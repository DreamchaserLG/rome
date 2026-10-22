// Sending to a person: which of their accounts a message may go to, and
// everything that has to be true before one is handed to a channel.
//
// Vocabulary: docs/concepts/people.md. The wire shapes are the People
// contract's (`@rome/api-types/people`).
//
// A send names its account. There is no entry point here that takes a person
// and picks for them, because every rule that could pick decides who receives
// a message on evidence too thin to carry it — a timeline entry names its
// channel and not its address, so "reply where they last wrote" cannot
// separate two numbers on one channel. Which of Rome's accounts on the
// account's platform carries the message is chosen here, since the recipient
// is the same whichever does. `defaultSendAccount` in the
// contract offers surfaces a preselected account; it is a default rendered on
// screen, not a decision taken off it.
//
// Whether a channel can be sent to at all is the channel's own declaration:
// its `send` port's `direct`. A channel whose sending cannot reach an account
// directly cannot be written to from here, without a read-only flag threaded
// through anything.

import type { ChatId } from "@rome-os/app-runtime";
import type { AccountSendState } from "@rome/api-types/people";
import {
  ChannelNotConnected,
  messageStores,
  type ChannelSend,
  type Channels,
} from "../channels/channel.js";
import type { AccountMessages } from "../channels/messages.js";
import type { DrizzleDb } from "../db/index.js";
import { reachOf, type ReachDeps } from "./link-reach.js";
import { personMessageStores } from "./timeline-sources.js";

export interface SendAccount {
  channel: string;
  channelUserId: string;
}

export interface SendDeps extends ReachDeps {
  channels: Channels;
  /** Where Rome's own transcript lives, which holds what was said on a channel
   *  with no store of its own. Without it only the channels' stores say which
   *  of Rome's accounts has talked to someone. */
  db?: DrizzleDb;
}

/** A resolved target: the channel's send port, and the conversation on it
 *  that reaches this account. It names the channel, not the Connection: the
 *  port finds the channel's Connection again when it sends. A connection kind holds at
 *  most one Connection, so that is the one the conversation was resolved on,
 *  unless the Connection was replaced in between. This is deliberate. */
export interface SendTarget {
  /** The channel that sends, which may be another of Rome's accounts on the
   *  link's platform than the one the link names. */
  channel: string;
  send: ChannelSend;
  chatId: ChatId;
}

export type Resolution = { ok: true; target: SendTarget } | { ok: false; send: RefusedState };

export type RefusedState = Exclude<AccountSendState, "yes">;

/**
 * Everything true before a body may be handed to a channel, or which of the
 * three ways it is not.
 *
 * Whether the channel does direct messaging is a synchronous read of its send
 * port. Only asking for the thread that reaches this account can reach a
 * provider, and it is also what says no Connection exists for the channel:
 * the port rejects with {@link ChannelNotConnected} then, as a send would.
 */
async function sendStateOf(
  deps: SendDeps,
  account: SendAccount,
  /** Whether to pick the sender by history. Only a send needs to: a listing
   *  asks whether any of them can send, and reading history per link would
   *  cost it a query per row. */
  pick: boolean,
): Promise<{ state: RefusedState } | { state: "yes"; target: SendTarget }> {
  // Every one of Rome's accounts on the platform reaches the account. Of those
  // that can send, the one that last talked with it sends, so nobody hears
  // first from an account of Rome's they never wrote to. A channel's answer to
  // `chatFor` is no evidence: some hand back any address. With no history on
  // any of them the link's own channel sends, and with none that can send it
  // says why.
  const reach = reachOf(deps, account);
  const states = await Promise.all(reach.map((address) => sendStateOn(deps, address)));
  const sendable = states.filter(
    (state): state is { state: "yes"; target: SendTarget } => state.state === "yes",
  );
  if (sendable.length <= 1 || !pick) return sendable[0] ?? states[0]!;
  const stores = deps.db
    ? personMessageStores({ db: deps.db, channels: deps.channels })
    : messageStores(deps.channels);
  const lastTalked = await Promise.all(
    sendable.map((state) => latestOn(stores, state.target.channel, account.channelUserId)),
  );
  let chosen = 0;
  for (let i = 1; i < sendable.length; i++) {
    if ((lastTalked[i] ?? -1) > (lastTalked[chosen] ?? -1)) chosen = i;
  }
  return sendable[chosen]!;
}

/** When Rome's account `channel` last exchanged a message with the address,
 *  across every store, or null when none holds one. */
async function latestOn(
  stores: readonly AccountMessages[],
  channel: string,
  channelUserId: string,
): Promise<number | null> {
  const heads = await Promise.all(
    stores.map((store) => store.latest([{ channel, addresses: [channelUserId] }])),
  );
  let latest: number | null = null;
  for (const head of heads) {
    if (head && (latest === null || head.timestamp > latest)) latest = head.timestamp;
  }
  return latest;
}

async function sendStateOn(
  deps: SendDeps,
  account: SendAccount,
): Promise<{ state: RefusedState } | { state: "yes"; target: SendTarget }> {
  const channel = deps.channels.find((candidate) => candidate.name === account.channel);
  // A channel Rome does not know is one no connection answers for.
  if (!channel) return { state: "not-connected" };
  const send = channel.send;
  const direct = send?.direct ?? null;
  if (!send || !direct) return { state: "unsupported" };

  // A channel that throws asking for a thread is a channel that could not
  // produce one, which is the same answer as null and the same answer the
  // person read already gives for this account. Letting it escape would make
  // the send path report a 500 where the read reported `no-conversation`, so
  // the two would disagree about one condition.
  let chatId: ChatId | null;
  try {
    chatId = await direct.chatFor(account.channelUserId);
  } catch (err) {
    if (err instanceof ChannelNotConnected) return { state: "not-connected" };
    chatId = null;
  }
  if (chatId === null) return { state: "no-conversation" };
  return { state: "yes", target: { channel: channel.name, send, chatId } };
}

export async function resolveSendTarget(deps: SendDeps, account: SendAccount): Promise<Resolution> {
  const resolved = await sendStateOf(deps, account, true);
  return resolved.state === "yes"
    ? { ok: true, target: resolved.target }
    : { ok: false, send: resolved.state };
}

/**
 * Whether Rome can send to each of the given accounts, positionally.
 *
 * Only `chatFor` can reach a provider, and it is asked once per
 * account — cheap on the channels in play, and the reason a channel that keys
 * threads separately has to be priced before it is added to a listing read. A
 * listing must not fail because one account of one person could not be priced.
 */
export async function readSendStates(
  deps: SendDeps,
  accounts: readonly SendAccount[],
): Promise<AccountSendState[]> {
  return await Promise.all(
    accounts.map(async (account) => (await sendStateOf(deps, account, false)).state),
  );
}

/** What a channel said when it took the message: its own id for it, so the
 *  entry this becomes on the timeline can be recognized when it lands. */
export interface SendReceipt {
  messageId: string | null;
}

/**
 * Hand the text to the channel.
 *
 * Throws whatever the channel throws — the caller records the failure, because
 * only it knows which outbox row is waiting on the answer.
 */
export async function sendToTarget(target: SendTarget, text: string): Promise<SendReceipt> {
  const receipt = await target.send.send(target.chatId, { text });
  return { messageId: receipt.messageId ?? null };
}
