import { describe, expect, it } from "@rstest/core";
import type { ChatId, ChannelDirectMessaging } from "@rome-os/app-runtime";
import { type Channel, ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { readSendStates, resolveSendTarget } from "./send.js";

function channel(name: string, send: ChannelSend | null): Channel {
  return { name, send, inbound: null, accounts: null, messages: null, directory: null };
}

function sending(direct: ChannelDirectMessaging | null): ChannelSend {
  return { send: async (conversationId) => ({ conversationId }), direct, activity: null };
}

describe("readSendStates", () => {
  it("answers each state from the channel's send port", async () => {
    const channels = [
      channel(
        "unbacked",
        sending({
          conversationFor: () => Promise.reject(new ChannelNotConnected("unbacked")),
        }),
      ),
      channel("read-only", null),
      channel("no-direct", sending(null)),
      channel("no-thread", sending({ conversationFor: async () => null })),
      channel(
        "down",
        sending({
          conversationFor: () => Promise.reject(new Error("provider is down")),
        }),
      ),
      channel("open", sending({ conversationFor: async (id) => id as ChatId })),
    ];

    const states = await readSendStates({ channels }, [
      { channel: "unknown", channelUserId: "u" },
      ...channels.map((c) => ({ channel: c.name, channelUserId: "u" })),
    ]);

    expect(states).toEqual([
      "not-connected",
      "not-connected",
      "unsupported",
      "unsupported",
      "no-conversation",
      "no-conversation",
      "yes",
    ]);
  });
});

describe("a link keyed by a service", () => {
  // A service's first channel carries its name. A later account of it, or a
  // first account connected with an opaque id, carries an id of its own.
  const services: Record<string, string> = { "tg-opaque": "telegram", "tg-second": "telegram" };
  const serviceOfChannel = (name: string) => services[name] ?? name;

  const unbacked = (name: string) =>
    channel(
      name,
      sending({ conversationFor: () => Promise.reject(new ChannelNotConnected(name)) }),
    );
  const open = (name: string) =>
    channel(name, sending({ conversationFor: async (id) => id as ChatId }));
  const knowsNobody = (name: string) =>
    channel(name, sending({ conversationFor: async () => null }));

  const link = { channel: "telegram", channelUserId: "u" };

  it("sends on the service's own channel exactly as on any other", async () => {
    const deps = { channels: [open("telegram")], serviceOfChannel };

    expect(await readSendStates(deps, [link])).toEqual(["yes"]);
    const resolution = await resolveSendTarget(deps, link);
    expect(resolution.ok && resolution.target).toMatchObject({
      channel: "telegram",
      conversationId: "u",
    });
  });

  it("reaches an account connected with an opaque id while nothing backs the service's name", async () => {
    const deps = { channels: [unbacked("telegram"), open("tg-opaque")], serviceOfChannel };

    expect(await readSendStates(deps, [link])).toEqual(["yes"]);
    const resolution = await resolveSendTarget(deps, link);
    expect(resolution.ok && resolution.target.channel).toBe("tg-opaque");
  });

  it("takes the first of two accounts, in the list's order, that has a conversation", async () => {
    const both = { channels: [open("tg-opaque"), open("tg-second")], serviceOfChannel };
    const resolved = await resolveSendTarget(both, link);
    expect(resolved.ok && resolved.target.channel).toBe("tg-opaque");

    // An account the address means nothing on is passed over.
    const second = { channels: [knowsNobody("tg-opaque"), open("tg-second")], serviceOfChannel };
    const passedOver = await resolveSendTarget(second, link);
    expect(passedOver.ok && passedOver.target.channel).toBe("tg-second");
  });

  it("reports the refusal of the account that came nearest to sending", async () => {
    const deps = {
      channels: [unbacked("telegram"), knowsNobody("tg-opaque"), channel("tg-second", null)],
      serviceOfChannel,
    };

    expect(await readSendStates(deps, [link])).toEqual(["no-conversation"]);
  });

  it("keeps a link naming one channel's own id on that channel", async () => {
    const deps = { channels: [open("telegram"), knowsNobody("tg-second")], serviceOfChannel };

    expect(
      await readSendStates(deps, [
        { channel: "tg-second", channelUserId: "u" },
        { channel: "tg-unknown", channelUserId: "u" },
      ]),
    ).toEqual(["no-conversation", "not-connected"]);
  });
});
