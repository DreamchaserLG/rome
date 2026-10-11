import { describe, expect, it } from "@rstest/core";
import {
  channelSessionKey,
  forkSessionKey,
  parseSessionKey,
  sentinelSessionKey,
  sessionKeyChannel,
  subagentSessionKey,
  webchatConversationOfKey,
} from "./session-key.js";

// Rome looks stored sessions up by these exact strings, so a builder that
// changes its output strands every existing provider thread.
describe("session key builders", () => {
  it("spells channel and sentinel keys as stored rows expect", () => {
    expect(channelSessionKey("telegram", "t1")).toBe("telegram:t1");
    expect(sentinelSessionKey("telegram:t1")).toBe("sentinel:telegram:t1");
    expect(subagentSessionKey("telegram:t1", "s1")).toBe("telegram:t1:subagent:s1");
  });
});

describe("parseSessionKey", () => {
  it("names a webchat chat's own key", () => {
    expect(parseSessionKey("webchat:chat-1")).toEqual({
      kind: "webchat",
      conversationId: "chat-1",
    });
    expect(webchatConversationOfKey("webchat:chat-1")).toBe("chat-1");
  });

  it("reads subagent and fork keys back to their parent", () => {
    const key = subagentSessionKey(forkSessionKey("webchat:chat-1", "fork-1"), "s1");
    const parsed = parseSessionKey(key);
    expect(parsed).toMatchObject({
      kind: "subagent",
      subagentId: "s1",
      parent: {
        kind: "fork",
        forkSessionId: "fork-1",
        parent: { kind: "webchat", conversationId: "chat-1" },
      },
    });
    expect(webchatConversationOfKey(key)).toBeUndefined();
    expect(sessionKeyChannel(key)).toBe("webchat");
  });

  it("keeps a colon inside a messaging thread id", () => {
    expect(parseSessionKey("slack:C1:1700000000.1")).toEqual({
      kind: "channel",
      channel: "slack",
      threadId: "C1:1700000000.1",
    });
    expect(sessionKeyChannel("telegram:t1:subagent:abc")).toBe("telegram");
  });

  it("gives a sentinel no delivery channel", () => {
    expect(parseSessionKey("sentinel:telegram:t1")).toEqual({
      kind: "sentinel",
      watched: { kind: "channel", channel: "telegram", threadId: "t1" },
    });
    expect(sessionKeyChannel("sentinel:telegram:t1")).toBeUndefined();
  });

  it("treats a webchat key with extra parts as a plain channel key", () => {
    expect(webchatConversationOfKey("webchat:chat-1:extra")).toBeUndefined();
    expect(sessionKeyChannel("webchat:chat-1:extra")).toBe("webchat");
  });
});
