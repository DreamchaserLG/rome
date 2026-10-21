import { afterEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  approvals,
  channels,
  outboundMessages,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
  routines,
  sentinelLog,
  sessions,
  sessionTurnCheckpoints,
} from "../schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { AgentTraceRecorder } from "../../core/agent-trace-recorder.js";
import { WebChatRepository } from "./webchat.js";
import {
  ChannelNotLinkable,
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
} from "./channel-records.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("ChannelRecordsRepository", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function repository(): ChannelRecordsRepository {
    testDb = createTestDb();
    return new ChannelRecordsRepository(testDb.db);
  }

  it("names a service's first channel after it and later ones by an opaque id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    const third = records.claim(db, { id: "c3", service: "feishu" }, NOW).id;
    expect(second).toMatch(UUID);
    expect(third).toMatch(UUID);
    expect(third).not.toBe(second);
    expect(records.claim(db, { id: "c4", service: "telegram_user" }, NOW)).toMatchObject({
      id: "telegram_user",
      platform: "telegram",
    });
  });

  it("puts a Feishu app on the platform its domain names", () => {
    const records = repository();
    const db = testDb!.db;

    const platformOf = (id: string, domain?: string) =>
      records.claim(db, { id, service: "feishu", domain }, NOW).platform;

    expect(platformOf("c1")).toBe("feishu");
    expect(platformOf("c2", "feishu")).toBe("feishu");
    expect(platformOf("c3", "lark")).toBe("lark");
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("deletes a released bot's channel, and a re-added bot starts fresh with no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toBeNull();

    // A live agent session may still hold the deleted id, so this run mints
    // another one.
    const readded = records.claim(db, { id: "c2", service: "feishu" }, NOW);
    expect(readded).toMatchObject({ connectionId: "c2", agent: null });
    expect(readded.id).toMatch(UUID);
  });

  it("sweeps a late turn's rows under a deleted account's name, then gives the name back", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.vacate(db, "c1");
    // A turn still running at the disconnect writes after the deletes.
    db.insert(romeSessions)
      .values({
        id: "channel:telegram:t1",
        name: "t1",
        type: "channel",
        sourceChannel: "telegram",
        sourceThreadId: "t1",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    db.insert(romeAgentMessages)
      .values({
        id: "late",
        sessionId: "channel:telegram:t2",
        role: "assistant",
        content: "[]",
        createdAt: NOW,
      })
      .run();
    db.insert(romeAgentTraceBlocks)
      .values({ messageId: "trace", seq: 0, sessionId: "channel:telegram:t3", content: "{}" })
      .run();
    db.insert(sentinelLog)
      .values({
        id: "triage",
        messageId: "p1",
        channel: "telegram",
        channelUserId: "u1",
        text: "hello",
        action: "replied",
        createdAt: NOW,
      })
      .run();
    db.insert(sessions)
      .values({
        id: "agent",
        agentName: "main",
        channelThreadKey: "sentinel:telegram:t1",
        createdAt: NOW,
        lastActiveAt: NOW,
        status: "completed",
      })
      .run();

    const restarted = new ChannelRecordsRepository(db);
    expect(restarted.sweep()).toContain("telegram");
    expect(db.select().from(romeSessions).all()).toEqual([]);
    expect(db.select().from(romeAgentMessages).all()).toEqual([]);
    expect(db.select().from(romeAgentTraceBlocks).all()).toEqual([]);
    expect(db.select().from(sentinelLog).all()).toEqual([]);
    expect(db.select().from(sessions).all()).toEqual([]);
    expect(restarted.claim(db, { id: "c2", service: "telegram" }, NOW).id).toBe("telegram");
  });

  it("sweeps late rows under a deleted minted id, and keeps every held channel's", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const minted = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.vacate(db, "c2");
    for (const channel of [minted, "feishu"]) {
      db.insert(sentinelLog)
        .values({
          id: `s-${channel}`,
          messageId: `p-${channel}`,
          channel,
          channelUserId: "u1",
          text: "hello",
          action: "replied",
          createdAt: NOW,
        })
        .run();
    }

    expect(new ChannelRecordsRepository(db).sweep()).toContain(minted);
    expect(
      db
        .select()
        .from(sentinelLog)
        .all()
        .map((row) => row.id),
    ).toEqual(["s-feishu"]);
  });

  it("sweeps a late transcript row under a deleted minted id that nothing else records", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const minted = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.vacate(db, "c2");
    db.insert(romeAgentMessages)
      .values({
        id: "late",
        sessionId: `channel:${minted}:t1`,
        role: "assistant",
        content: "[]",
        createdAt: NOW,
      })
      .run();
    db.insert(romeAgentTraceBlocks)
      .values({ messageId: "late", seq: 0, sessionId: `channel:${minted}:t1`, content: "{}" })
      .run();

    expect(new ChannelRecordsRepository(db).sweep()).toContain(minted);
    expect(db.select().from(romeAgentMessages).all()).toEqual([]);
    expect(db.select().from(romeAgentTraceBlocks).all()).toEqual([]);
  });

  it("sweeps a late sentinel run under a deleted minted id that only its name spells", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const minted = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.vacate(db, "c2");
    db.insert(romeSessions)
      .values({
        id: "action:exec-late:sentinel",
        name: `sentinel:${minted}:t1`,
        type: "action",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    db.insert(romeAgentMessages)
      .values({
        id: "late",
        sessionId: "action:exec-late:sentinel",
        role: "user",
        content: "[]",
        createdAt: NOW,
      })
      .run();

    expect(new ChannelRecordsRepository(db).sweep()).toContain(minted);
    expect(db.select().from(romeSessions).all()).toEqual([]);
    expect(db.select().from(romeAgentMessages).all()).toEqual([]);
  });

  it("sweeps a late agent session under a deleted minted id that only its key spells", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const minted = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.vacate(db, "c2");
    db.insert(sessions)
      .values({
        id: "late",
        agentName: "main",
        channelThreadKey: `${minted}:t1`,
        createdAt: NOW,
        lastActiveAt: NOW,
        status: "active",
      })
      .run();

    expect(new ChannelRecordsRepository(db).sweep()).toContain(minted);
    expect(db.select().from(sessions).all()).toEqual([]);
  });

  it("keeps an agent's ad-hoc sessions when its name starts like an absent account's", () => {
    const records = repository();
    const db = testDb!.db;
    db.insert(sessions)
      .values({
        id: "adhoc",
        agentName: "telegram:helper",
        channelThreadKey: "telegram:helper:0b5e2c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21",
        createdAt: NOW,
        lastActiveAt: NOW,
        status: "active",
      })
      .run();

    expect(records.sweep()).toContain("telegram");
    expect(
      db
        .select()
        .from(sessions)
        .all()
        .map((row) => row.id),
    ).toEqual(["adhoc"]);
  });

  it("gives a deleted channel's id to a re-added bot after a restart", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    const restarted = new ChannelRecordsRepository(db);
    expect(restarted.claim(db, { id: "c2", service: "feishu" }, NOW)).toMatchObject({
      id: "feishu",
      agent: null,
    });
  });

  it("deletes the sentinel's triage runs on a deleted account, by the key the inbox runs it under", async () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    const webchat = new WebChatRepository(db);
    for (const channel of ["telegram", "telegram_user"]) {
      const recorder = new AgentTraceRecorder({
        webchatRepo: webchat,
        agentName: "sentinel",
        channelThreadKey: `sentinel:${channel}:t1`,
        turnId: `turn-${channel}`,
        actionContext: { actionName: "inbox:message_handler", executionId: `exec-${channel}` },
      });
      await recorder.record({
        type: "turn_start",
        turnId: `turn-${channel}`,
        sessionId: `provider-${channel}`,
        userPrompt: "hello from a stranger",
      });
    }

    records.vacate(db, "c1");

    expect(
      db
        .select()
        .from(romeSessions)
        .all()
        .map((row) => row.id),
    ).toEqual(["action:exec-telegram_user:sentinel"]);
    expect(
      db
        .select()
        .from(romeAgentMessages)
        .all()
        .map((row) => row.sessionId),
    ).not.toContain("action:exec-telegram:sentinel");
  });

  it("turns off a routine that sends on a deleted account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    for (const channel of ["telegram", "telegram_user"]) {
      db.insert(routines)
        .values({
          id: `r-${channel}`,
          name: "notify",
          trigger: { type: "schedule" },
          actionName: "system:send_message",
          args: { channel, threadId: "t1", text: "hi" },
          createdAt: NOW,
        })
        .run();
    }

    // A routine may store the action by its bare name.
    db.insert(routines)
      .values({
        id: "r-bare",
        name: "notify",
        trigger: { type: "schedule" },
        actionName: "send_message",
        args: { channel: "telegram", threadId: "t2", text: "hi" },
        createdAt: NOW,
      })
      .run();

    expect(records.vacate(db, "c1").sort()).toEqual(["r-bare", "r-telegram"]);

    expect(
      Object.fromEntries(
        db
          .select()
          .from(routines)
          .all()
          .map((row) => [row.id, row.enabled]),
      ),
    ).toEqual({ "r-bare": false, "r-telegram": false, "r-telegram_user": true });
  });

  it("rejects the approvals still waiting to act on a deleted account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    const action = (channel: string) => ({ channelContext: { channel, threadId: "t1" } });
    db.insert(approvals)
      .values(
        [
          ["asked", "action_execution", "pending", "idle", action("telegram")],
          ["queued", "action_execution", "approved", "queued", action("telegram")],
          ["ran", "action_execution", "approved", "succeeded", action("telegram")],
          ["failed", "action_execution", "approved", "failed", action("telegram")],
          ["reply", "outgoing_message", "pending", "idle", { channel: "telegram", threadId: "t1" }],
          ["other", "action_execution", "pending", "idle", action("telegram_user")],
        ].map(([id, type, status, executionState, payload]) => ({
          id: id as string,
          type: type as "action_execution" | "outgoing_message",
          status: status as "pending" | "approved",
          executionState: executionState as "idle" | "queued" | "succeeded" | "failed",
          requestedBy: "main",
          description: "d",
          payload,
          createdAt: NOW,
        })),
      )
      .run();

    records.vacate(db, "c1");

    const states = Object.fromEntries(
      db
        .select()
        .from(approvals)
        .all()
        .map((row) => [row.id, `${row.status}/${row.executionState}`]),
    );
    expect(states).toEqual({
      asked: "rejected/idle",
      queued: "rejected/idle",
      ran: "approved/succeeded",
      failed: "rejected/failed",
      reply: "rejected/idle",
      other: "pending/idle",
    });
  });

  it("deletes what was recorded through a released bot, and nothing of another account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    for (const [id, channel] of [
      ["gone", "telegram"],
      ["kept", "telegram_user"],
    ] as const) {
      db.insert(romeSessions)
        .values({
          id,
          name: id,
          type: "channel",
          sourceChannel: channel,
          sourceThreadId: "t1",
          activityAt: NOW,
          createdAt: NOW,
        })
        .run();
      db.insert(romeAgentMessages)
        .values({ id: `m-${id}`, sessionId: id, role: "user", content: "[]", createdAt: NOW })
        .run();
      db.insert(outboundMessages)
        .values({
          id: `o-${id}`,
          channel,
          channelUserId: "u1",
          conversationId: id,
          text: "hi",
          state: "failed",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      db.insert(sentinelLog)
        .values({
          id: `s-${id}`,
          messageId: `p-${id}`,
          channel,
          channelUserId: "u1",
          text: "hello",
          action: "replied",
          createdAt: NOW,
        })
        .run();
    }
    db.insert(romeSessions)
      .values({
        id: "child",
        name: "child",
        type: "subagent",
        sourceChannel: "telegram",
        parentSessionId: "gone",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    db.insert(romeSessions)
      .values({
        id: "fork",
        name: "fork",
        type: "fork",
        parentSessionId: "gone",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    // An agent named like the service: its ad-hoc key starts like a channel's.
    for (const [id, key, conversationId, agentName] of [
      ["a-gone", "telegram:t1", "gone", "main"],
      ["a-subagent", "telegram:t1:subagent:s1", null, "main"],
      ["a-sentinel", "sentinel:telegram:t1", null, "main"],
      ["a-kept", "telegram_user:t1", "kept", "main"],
      ["a-adhoc", "telegram:helper:0b5e2c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21", null, "telegram:helper"],
      ["a-elsewhere", "telegram:helper:run", "kept", "main"],
    ] as const) {
      db.insert(sessions)
        .values({
          id,
          agentName,
          channelThreadKey: key,
          conversationId,
          createdAt: NOW,
          lastActiveAt: NOW,
          status: "completed",
        })
        .run();
      db.insert(sessionTurnCheckpoints)
        .values({
          sessionId: id,
          turnId: "turn",
          provider: "claude",
          providerThreadId: "p",
          checkpointId: "x",
          createdAt: NOW,
        })
        .run();
    }

    records.vacate(db, "c1");

    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    expect(ids(records.all())).toEqual(["telegram_user"]);
    expect(ids(db.select().from(romeSessions).all())).toEqual(["fork", "kept"]);
    expect(
      db.select().from(romeSessions).where(eq(romeSessions.id, "fork")).get()?.parentSessionId,
    ).toBeNull();
    expect(ids(db.select().from(romeAgentMessages).all())).toEqual(["m-kept"]);
    expect(ids(db.select().from(outboundMessages).all())).toEqual(["o-kept"]);
    expect(ids(db.select().from(sentinelLog).all())).toEqual(["s-kept"]);
    expect(ids(db.select().from(sessions).all())).toEqual(["a-adhoc", "a-elsewhere", "a-kept"]);
    expect(
      db
        .select()
        .from(sessionTurnCheckpoints)
        .all()
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual(["a-adhoc", "a-elsewhere", "a-kept"]);
  });

  it("starts every new account with no agent, and with the one asked only where it takes one", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "telegram" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c2", service: "telegram_user" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c3", service: "telegram" }, NOW, "core:main").agent).toBe(
      "core:main",
    );
    expect(records.claim(db, { id: "c4", service: "webchat" }, NOW, "core:main").agent).toBeNull();
    expect(records.claim(db, { id: "c5", service: "agents" }, NOW).agent).toBeNull();
  });

  it("never gives a later account's channel to the next account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const later = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link(later, "sales:agent");
    records.vacate(db, "c2");

    const next = records.claim(db, { id: "c3", service: "feishu" }, NOW);
    expect(next.id).not.toBe(later);
    expect(next.agent).toBeNull();
  });

  it("takes back a service's released channel when the service takes no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "email" }, NOW);
    const later = records.claim(db, { id: "c2", service: "email" }, NOW).id;
    records.vacate(db, "c2");
    records.vacate(db, "c1");

    expect(records.claim(db, { id: "c3", service: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c4", service: "email" }, NOW).id).toBe(later);
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "telegram" }, NOW);
    const second = records.claim(testDb!.db, { id: "c2", service: "telegram" }, NOW).id;

    expect(records.serviceOf(second)).toBe("telegram");
    expect(records.serviceOf("webchat")).toBe("webchat");
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", service: "feishu" }, NOW);
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
  });

  it("links one agent to several channels of one platform and keeps each link", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    const later = records.claim(db, { id: "c3", service: "telegram" }, NOW).id;
    records.link("telegram", "sales:agent");

    expect(records.link("telegram_user", "sales:agent")).toMatchObject({
      id: "telegram_user",
      agent: "sales:agent",
    });
    records.link(later, "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("telegram_user")?.agent).toBe("sales:agent");
    expect(records.byId(later)?.agent).toBe("sales:agent");
  });

  it("unlinks one channel of an agent and leaves its other channels linked", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "sales:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("sales:agent");
  });

  it("links main to several channels of one platform, by its canonical id", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    const later = records.claim(db, { id: "c2", service: "telegram" }, NOW).id;
    records.link("telegram", "main");

    expect(records.link(later, "main")).toMatchObject({ agent: "core:main" });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(() =>
      db.update(channels).set({ agent: "core:main" }).where(eq(channels.service, "telegram")).run(),
    ).not.toThrow();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "telegram" }, NOW);
    records.link("feishu", "sales:agent");

    records.link("telegram", "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "support:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("support:agent");
  });

  it("refuses a link to a missing or unbacked channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");
    db.insert(channels)
      .values({ id: "telegram", service: "telegram", platform: "telegram", createdAt: NOW })
      .run();

    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("telegram", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("refuses a link to a channel whose service takes none, and unlinks it", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect(() => records.link("agents", "sales:agent")).toThrow(ChannelNotLinkable);
    expect(records.link("agents", null).agent).toBeNull();
  });

  it("accepts a direct write that links one agent to every channel of a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).not.toThrow();
    expect(records.all().map((record) => record.agent)).toEqual(["sales:agent", "sales:agent"]);
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "feishu" }, NOW);

    expect(
      records.unclaimed([
        { id: "c1", service: "feishu" },
        { id: "c2", service: "discord" },
      ]),
    ).toEqual([{ id: "c2", service: "discord" }]);
  });
});
