import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig, BackendTurnParams } from "@rome-os/app-runtime";
import { createResumeSessionAction } from "../../../../rome_apps/system/src/actions/resume-session/index.js";
import type { OrphanedToolResult } from "../core/agent-runner.js";
import {
  createTestRome,
  invokeAction,
  recordingAction,
  result,
  type RecordingAction,
  type TestRome,
} from "../test/kit/index.js";
import { createBackendTurnRunner, type MainBackendTurnRunner } from "./backend-turn.js";

const resumeSessionConfig = {
  name: "resume_session",
  type: "system",
  description: "Continue an existing conversation",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
} as ActionConfig;

const channelContext = {
  channel: "webchat",
  threadId: "report-chat",
  channelUserId: "guardian",
};

function orphan(overrides: Partial<OrphanedToolResult> = {}): OrphanedToolResult {
  return {
    tool: "execute_action",
    callId: "call-slow",
    arguments: { action_name: "slow_report", json_args: {} },
    success: true,
    text: '{"report":"ready","codingSessionId":"cs-1"}',
    interrupted: false,
    ...overrides,
  };
}

// A Codex `exec` cell that yielded while awaiting `execute_action` loses the
// call at turn end. The provider reports the late result through
// `onOrphanedToolResult`; these tests start from that callback.
describe("tool results that finish after their turn", () => {
  let rome: TestRome | undefined;
  let slowReport: RecordingAction;

  afterEach(async () => {
    await rome?.cleanup();
    rome = undefined;
  });

  async function startReportInChat(
    extraActions: RecordingAction["action"][] = [],
  ): Promise<string> {
    slowReport = recordingAction("slow_report");
    let backendTurnRunner: MainBackendTurnRunner | undefined;
    const resumeSession = createResumeSessionAction(resumeSessionConfig, {
      backendTurnRunner: {
        runAndDeliver: async (params: BackendTurnParams) =>
          await backendTurnRunner!.runAndDeliver(params),
      },
    } as never);
    rome = await createTestRome({
      keepAliveAcrossTurns: true,
      actions: [slowReport.action, resumeSession, ...extraActions],
    });
    const testRome = rome;
    backendTurnRunner = createBackendTurnRunner({
      agentRunner: testRome.agentRunner,
      channel: (name) => testRome.channels.find((channel) => channel.name === name) ?? null,
    });
    testRome.model
      .whenPromptIncludes("Start the report")
      .replyOnce(invokeAction("slow_report"), result("Started the report."));

    const messages = await testRome.runAgent({
      prompt: "Start the report",
      channelThreadKey: `webchat:${channelContext.threadId}`,
      threadContext: channelContext,
    });
    const sessionId = messages.find((message) => message.type === "session_init")?.sessionId;
    if (!sessionId) throw new Error("the turn did not emit session_init");
    return sessionId;
  }

  it("resumes the same session once with the result, without running the action again", async () => {
    const sessionId = await startReportInChat();
    const testRome = rome!;
    const run = rs.spyOn(testRome.actionEngine, "run");

    testRome.model.sessions.at(-1)!.onOrphanedToolResult!(orphan());

    await rs.waitFor(() => expect(testRome.model.calls).toHaveLength(2));
    await Promise.all(run.mock.results.map((call) => call.value));
    const resumes = run.mock.calls.filter(([name]) => name === "resume_session");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.[1]).toEqual({
      sessionId,
      ...channelContext,
      agentName: "core:main",
      text: expect.stringContaining('"slow_report"'),
    });
    const prompt = testRome.model.lastPrompt() ?? "";
    expect(prompt).toContain("call-slow");
    expect(prompt).toContain("do not run it again");
    expect(prompt).toContain('"codingSessionId":"cs-1"');
    expect(testRome.model.sessions.at(-1)?.sessionId).toBe(sessionId);
    expect(slowReport.calls).toHaveLength(1);
  });

  it("says a failed result may be retried", async () => {
    await startReportInChat();
    const testRome = rome!;

    testRome.model.sessions.at(-1)!.onOrphanedToolResult!(
      orphan({ success: false, text: "upstream timed out" }),
    );

    await rs.waitFor(() => expect(testRome.model.calls).toHaveLength(2));
    const prompt = testRome.model.lastPrompt() ?? "";
    expect(prompt).toContain("decide from its result whether to retry");
    expect(prompt).not.toContain("do not run it again");
  });

  // No tool_result streams for a call that outlived its turn, so a component
  // it returns is never mounted and the guardian has to be asked in words.
  it("relays a component that a late result returns as a plain question", async () => {
    let slotGate = Promise.resolve();
    let lateCall: Promise<unknown> | undefined;
    const pickSlot = recordingAction("pick_slot", {
      execute: async () => {
        await slotGate;
        return {
          status: "pending_interaction",
          interaction: {
            appId: "calendar",
            promptText: "Pick a time slot",
            render: { kind: "inline", componentId: "slot-picker" },
          },
        };
      },
    });
    // Starts pick_slot inside a turn without waiting for it, as a yielded
    // Codex cell does.
    const startPick = recordingAction("start_pick", {
      execute: async () => {
        lateCall = rome!.model.sessions.at(-1)!.executeAction("pick_slot", {});
        return { status: "ok", data: { started: true } };
      },
    });
    await startReportInChat([pickSlot.action, startPick.action]);
    const testRome = rome!;
    const runInChat = async (prompt: string) =>
      await testRome.runAgent({
        prompt,
        channelThreadKey: `webchat:${channelContext.threadId}`,
        threadContext: channelContext,
      });

    testRome.model
      .whenPromptIncludes("Book a slot")
      .replyOnce(invokeAction("pick_slot"), result("Pick one above."));
    const inTurn = await runInChat("Book a slot");
    expect(JSON.stringify(inTurn.find((m) => m.type === "tool_result"))).toContain(
      "pendingInteraction",
    );

    let releaseSlot!: () => void;
    slotGate = new Promise((resolve) => {
      releaseSlot = resolve;
    });
    testRome.model
      .whenPromptIncludes("Book later")
      .replyOnce(invokeAction("start_pick"), result("Started."));
    await runInChat("Book later");
    releaseSlot();
    const late = await lateCall;
    expect(late).not.toHaveProperty("pendingInteraction");
    testRome.model.sessions.at(-1)!.onOrphanedToolResult!(
      orphan({
        arguments: { action_name: "pick_slot", json_args: {} },
        text: JSON.stringify(late),
      }),
    );

    await rs.waitFor(() => expect(testRome.model.calls).toHaveLength(4));
    const prompt = testRome.model.lastPrompt() ?? "";
    expect(prompt).toContain("Pick a time slot");
    expect(prompt).not.toContain("has been shown to the guardian");
  });

  it("starts no turn for a result that outlived an interrupted turn", async () => {
    await startReportInChat();
    const testRome = rome!;
    const run = rs.spyOn(testRome.actionEngine, "run");

    testRome.model.sessions.at(-1)!.onOrphanedToolResult!(orphan({ interrupted: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
    expect(testRome.model.calls).toHaveLength(1);
  });

  it("gives a session with no conversation thread nothing to resume into", async () => {
    rome = await createTestRome({ keepAliveAcrossTurns: true });

    await rome.runAgent({ prompt: "Run the nightly check", channelThreadKey: "system:nightly" });

    expect(rome.model.sessions.at(-1)?.onOrphanedToolResult).toBeUndefined();
  });
});
