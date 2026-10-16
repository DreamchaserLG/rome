import { describe, expect, it, rs } from "@rstest/core";
import type {
  ActionEngineLike,
  ChannelInteractions,
  ConversationId,
  InboundInteractionEvent,
} from "@rome-os/app-runtime";
import {
  interactionActionName,
  routeInteractionsToActions,
  runInteractionAction,
} from "./interaction-actions.js";

function click(value: unknown): InboundInteractionEvent {
  return {
    kind: "interaction",
    interaction: {
      channel: "feishu",
      conversationId: "oc_chat" as ConversationId,
      messageId: "om_card",
      senderId: "ou_alice",
      senderDisplayName: "Alice",
      action: { tag: "button", value },
      timestamp: new Date("2026-10-16T00:00:00.000Z"),
    },
    ref: { connectionId: "conn-1", conversationId: "oc_chat" as ConversationId },
  };
}

function engine() {
  const run = rs.fn<ActionEngineLike["run"]>(async () => ({ status: "ok" as const }));
  return { run };
}

const actions = {
  get: (name: string) =>
    ({ confirm_visit: { interactions: true }, delete_everything: {} })[name] as
      | { interactions?: boolean }
      | undefined,
};

describe("runInteractionAction", () => {
  it("runs the action a card names, as the person who clicked", async () => {
    const actionEngine = engine();
    await runInteractionAction(
      { actions, actionEngine },
      click({ romeAction: "confirm_visit", visit: "C26-00127-V01" }),
    );
    expect(actionEngine.run).toHaveBeenCalledWith(
      "confirm_visit",
      {
        interaction: {
          channel: "feishu",
          connectionId: "conn-1",
          conversationId: "oc_chat",
          messageId: "om_card",
          senderId: "ou_alice",
          senderDisplayName: "Alice",
          action: {
            tag: "button",
            value: { romeAction: "confirm_visit", visit: "C26-00127-V01" },
          },
          timestamp: "2026-10-16T00:00:00.000Z",
        },
      },
      {
        initiator: "connection:conn-1",
        channelContext: {
          connectionId: "conn-1",
          channel: "feishu",
          threadId: "oc_chat",
          channelUserId: "ou_alice",
        },
      },
    );
  });

  it("refuses an action that does not declare interactions", async () => {
    const actionEngine = engine();
    await runInteractionAction(
      { actions, actionEngine },
      click({ romeAction: "delete_everything" }),
    );
    await runInteractionAction({ actions, actionEngine }, click({ romeAction: "missing" }));
    expect(actionEngine.run).not.toHaveBeenCalled();
  });

  it("ignores a click that names no action", async () => {
    const actionEngine = engine();
    await runInteractionAction({ actions, actionEngine }, click({ op: "save" }));
    await runInteractionAction({ actions, actionEngine }, click("plain"));
    expect(actionEngine.run).not.toHaveBeenCalled();
  });

  it("survives an action that throws", async () => {
    const actionEngine = {
      run: rs.fn<ActionEngineLike["run"]>(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      runInteractionAction({ actions, actionEngine }, click({ romeAction: "confirm_visit" })),
    ).resolves.toBeUndefined();
  });
});

describe("interactionActionName", () => {
  it("reads the action name from a control's value", () => {
    expect(interactionActionName({ romeAction: " confirm_visit " })).toBe("confirm_visit");
    expect(interactionActionName({ romeAction: "" })).toBeNull();
    expect(interactionActionName({ romeAction: 3 })).toBeNull();
    expect(interactionActionName(null)).toBeNull();
  });
});

describe("routeInteractionsToActions", () => {
  it("subscribes to every channel with interactions and unsubscribes on demand", async () => {
    const unsubscribe = rs.fn();
    let handler: ((event: InboundInteractionEvent) => Promise<void>) | undefined;
    const interactions: ChannelInteractions = {
      subscribe: (h) => {
        handler = h;
        return unsubscribe;
      },
    };
    const actionEngine = engine();
    const stop = routeInteractionsToActions({
      channels: [
        { name: "feishu", inbound: { subscribe: () => () => {}, media: null, interactions } },
        { name: "telegram", inbound: { subscribe: () => () => {}, media: null } },
        { name: "linkedin", inbound: null },
      ],
      actions,
      actionEngine,
    });
    await handler?.(click({ romeAction: "confirm_visit" }));
    expect(actionEngine.run).toHaveBeenCalledTimes(1);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
