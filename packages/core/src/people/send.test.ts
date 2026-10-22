import { describe, expect, it } from "@rstest/core";
import type { ChatId, ChannelDirectMessaging } from "@rome-os/app-runtime";
import { type Channel, ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import type { Message } from "@rome/api-types/message";
import type { AccountMessages, Messages } from "../channels/messages.js";
import { readSendStates, resolveSendTarget } from "./send.js";

function channel(name: string, send: ChannelSend | null): Channel {
  return { name, send, inbound: null, accounts: null, messages: null, directory: null };
}

function sending(talker: Pick<ChannelDirectMessaging, "chatFor"> | null): ChannelSend {
  const direct = talker && { ...talker, conversationFor: talker.chatFor };
  return { send: async (chatId) => ({ chatId }), direct, activity: null };
}

describe("readSendStates", () => {
  it("answers each state from the channel's send port", async () => {
    const channels = [
      channel(
        "unbacked",
        sending({
          chatFor: () => Promise.reject(new ChannelNotConnected("unbacked")),
        }),
      ),
      channel("read-only", null),
      channel("no-direct", sending(null)),
      channel("no-thread", sending({ chatFor: async () => null })),
      channel(
        "down",
        sending({
          chatFor: () => Promise.reject(new Error("provider is down")),
        }),
      ),
      channel("open", sending({ chatFor: async (id) => id as ChatId })),
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

describe("resolveSendTarget", () => {
  /** A store that has heard from the address on `talked` alone. */
  function heardOn(talked: string): Messages {
    const byAccount: AccountMessages = {
      read: async () => [],
      count: async () => 0,
      latest: async ([account]) =>
        account?.channel === talked ? ({ timestamp: 5 } as Message) : null,
    };
    return { query: async () => [], byAccount } as unknown as Messages;
  }

  const open = () => sending({ chatFor: async (id) => id as ChatId });

  it("sends from the one of Rome's accounts on the platform that last talked with them", async () => {
    const history = heardOn("telegram_user");
    const channels = [
      { ...channel("telegram", open()), messages: history },
      { ...channel("telegram_user", open()), messages: history },
    ];

    const resolved = await resolveSendTarget(
      { channels },
      { channel: "telegram", channelUserId: "7" },
    );

    expect(resolved.ok && resolved.target.channel).toBe("telegram_user");
  });

  it("sends from the link's own channel when none of them has talked with them", async () => {
    const channels = [channel("telegram", open()), channel("telegram_user", open())];

    const resolved = await resolveSendTarget(
      { channels },
      { channel: "telegram_user", channelUserId: "7" },
    );

    expect(resolved.ok && resolved.target.channel).toBe("telegram_user");
  });

  it("falls back to another account on the platform when the link's own cannot send", async () => {
    const channels = [
      channel("telegram", open()),
      channel("telegram_user", sending({ chatFor: async () => null })),
    ];

    const resolved = await resolveSendTarget(
      { channels },
      { channel: "telegram_user", channelUserId: "7" },
    );

    expect(resolved.ok && resolved.target.channel).toBe("telegram");
  });
});
