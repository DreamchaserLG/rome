// Agent session keys (`channelThreadKey`): how an agent session names the
// conversation it serves. Each builder returns the exact string Rome stores,
// so a key built here finds the same session every time.

const WEBCHAT_KEY_PREFIX = "webchat:";
const SENTINEL_KEY_PREFIX = "sentinel:";
const SUBAGENT_SUFFIX = /^(.+):subagent:([^:#]+)$/;
const FORK_SUFFIX = /^(.+)#fork:([^:#]+)$/;

/** A webchat conversation's key. */
export function webchatSessionKey(conversationId: string): string {
  return `${WEBCHAT_KEY_PREFIX}${conversationId}`;
}

/** A messaging channel thread's key, such as a Telegram chat. */
export function channelSessionKey(channel: string, threadId: string): string {
  return `${channel}:${threadId}`;
}

/** The key of the sentinel that triages a thread's untrusted messages, given
 *  that thread's own key. */
export function sentinelSessionKey(watchedKey: string): string {
  return `${SENTINEL_KEY_PREFIX}${watchedKey}`;
}

/** A subagent's key, nested under its parent's so it never reuses the
 *  parent's provider context. */
export function subagentSessionKey(parentKey: string, subagentId: string): string {
  return `${parentKey}:subagent:${subagentId}`;
}

/** The key subagents of a forked turn nest under. */
export function forkSessionKey(parentKey: string, forkSessionId: string): string {
  return `${parentKey}#fork:${forkSessionId}`;
}

/**
 * A key's named parts. An ad-hoc key (`<agent>:<id>`) and a messaging
 * channel's key share the `<a>:<b>` shape, so an ad-hoc key parses as
 * `channel` with its agent name in `channel`.
 */
export type ParsedSessionKey =
  | { kind: "webchat"; conversationId: string }
  | { kind: "channel"; channel: string; threadId: string }
  | { kind: "sentinel"; watched: ParsedSessionKey }
  | { kind: "subagent"; parent: ParsedSessionKey; subagentId: string }
  | { kind: "fork"; parent: ParsedSessionKey; forkSessionId: string }
  | { kind: "other"; raw: string };

/** Splits a key into its named parts. The inverse of the builders above. */
export function parseSessionKey(key: string): ParsedSessionKey {
  const subagent = SUBAGENT_SUFFIX.exec(key);
  if (subagent) {
    return { kind: "subagent", parent: parseSessionKey(subagent[1]!), subagentId: subagent[2]! };
  }
  const fork = FORK_SUFFIX.exec(key);
  if (fork) {
    return { kind: "fork", parent: parseSessionKey(fork[1]!), forkSessionId: fork[2]! };
  }
  if (key.startsWith(SENTINEL_KEY_PREFIX)) {
    return { kind: "sentinel", watched: parseSessionKey(key.slice(SENTINEL_KEY_PREFIX.length)) };
  }
  const separator = key.indexOf(":");
  if (separator <= 0) return { kind: "other", raw: key };
  const head = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (head === "webchat" && rest && !rest.includes(":")) {
    return { kind: "webchat", conversationId: rest };
  }
  return { kind: "channel", channel: head, threadId: rest };
}

/**
 * The channel a key's turns are delivered on: subagent and fork keys take
 * their parent's. Undefined for a sentinel, which watches a channel without
 * replying on it, and for a key with no channel part.
 */
export function sessionKeyChannel(key: string | ParsedSessionKey): string | undefined {
  const parsed = typeof key === "string" ? parseSessionKey(key) : key;
  switch (parsed.kind) {
    case "webchat":
      return "webchat";
    case "channel":
      return parsed.channel;
    case "subagent":
    case "fork":
      return sessionKeyChannel(parsed.parent);
    case "sentinel":
    case "other":
      return undefined;
  }
}

/** The webchat conversation a key belongs to when it is that chat's own
 *  session, not a subagent or fork under it. */
export function webchatConversationOfKey(key: string): string | undefined {
  const parsed = parseSessionKey(key);
  return parsed.kind === "webchat" ? parsed.conversationId : undefined;
}
