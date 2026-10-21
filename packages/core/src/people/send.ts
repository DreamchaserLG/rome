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
// separate two numbers on one channel, and reaching for another channel when
// one is down sends somewhere nobody chose. `defaultSendAccount` in the
// contract offers surfaces a preselected account; it is a default rendered on
// screen, not a decision taken off it.
//
// Which of Rome's own accounts on that service sends is a different question,
// and Rome answers it, since the recipient is the account the send names
// whichever of them sends. A link is keyed by service, so it reaches every
// channel of the service. A channel the account's address means nothing on
// cannot produce a conversation for it, so it is never the one chosen.
//
// Whether a channel can be sent to at all is the channel's own declaration:
// its `send` port's `direct`. A channel whose sending cannot reach an account
// directly cannot be written to from here, without a read-only flag threaded
// through anything.

import type { ChatId } from "@rome-os/app-runtime";
import type { AccountSendState } from "@rome/api-types/people";
import {
  ChannelNotConnected,
  linkedChannels,
  type Channel,
  type ChannelSend,
  type Channels,
} from "../channels/channel.js";
import type { ServiceOfChannel } from "../db/repositories/channel-records.js";

export interface SendAccount {
  channel: string;
  channelUserId: string;
}

export interface SendDeps {
  channels: Channels;
  /** The service each channel belongs to, which a link keyed by its service
   *  reaches every channel of. Absent, each channel is its own service, which
   *  holds only while no service has a later channel. */
  serviceOfChannel?: ServiceOfChannel;
}

/** A resolved target: the channel it is on, that channel's send port, and the
 *  conversation on it that reaches this account. It names the channel, not the
 *  Connection: the port finds the channel's Connection again when it sends. A
 *  channel holds at most one Connection, so that is the one the conversation
 *  was resolved on, unless the Connection was replaced in between. This is
 *  deliberate. */
export interface SendTarget {
  channel: string;
  send: ChannelSend;
  conversationId: ChatId;
}

export type Resolution = { ok: true; target: SendTarget } | { ok: false; send: RefusedState };

export type RefusedState = Exclude<AccountSendState, "yes">;

type SendState = { state: RefusedState } | { state: "yes"; target: SendTarget };

/** How much nearer to sending each refusal is, for the account a link reaches
 *  on several channels: it reports the refusal of the channel that came
 *  nearest, so a connected account outranks one nothing backs. */
const NEARNESS: Record<RefusedState, number> = {
  "not-connected": 0,
  unsupported: 1,
  "no-conversation": 2,
};

/**
 * Whether the account can be sent to on any channel its link reaches, and on
 * which.
 *
 * A link keyed by a service reaches every channel of it (`linkedChannels`).
 * The first, in the channel list's order, that can address the account
 * directly is the target, so the service's first channel goes first and its
 * later accounts follow it. A link naming one channel reaches that channel
 * alone, and so does a service with one channel, which answers exactly what
 * that channel does. The channels are asked in turn rather than together, so
 * no channel after the chosen one costs a provider call.
 */
async function sendStateOf(
  reach: (linked: string) => Channel[],
  account: SendAccount,
): Promise<SendState> {
  let refused: RefusedState = "not-connected";
  for (const channel of reach(account.channel)) {
    const answer = await channelSendState(channel, account.channelUserId);
    if (answer.state === "yes") return answer;
    if (NEARNESS[answer.state] > NEARNESS[refused]) refused = answer.state;
  }
  // A link reaching no channel Rome knows is one no connection answers for.
  return { state: refused };
}

/**
 * Everything true before a body may be handed to one channel, or which of the
 * three ways it is not.
 *
 * Whether the channel does direct messaging is a synchronous read of its send
 * port. Only asking for the thread that reaches this account can reach a
 * provider, and it is also what says no Connection exists for the channel:
 * the port rejects with {@link ChannelNotConnected} then, as a send would.
 */
async function channelSendState(channel: Channel, channelUserId: string): Promise<SendState> {
  const send = channel.send;
  const direct = send?.direct ?? null;
  if (!send || !direct) return { state: "unsupported" };

  // A channel that throws asking for a thread is a channel that could not
  // produce one, which is the same answer as null and the same answer the
  // person read already gives for this account. Letting it escape would make
  // the send path report a 500 where the read reported `no-conversation`, so
  // the two would disagree about one condition.
  let conversationId: ChatId | null;
  try {
    conversationId = await direct.conversationFor(channelUserId);
  } catch (err) {
    if (err instanceof ChannelNotConnected) return { state: "not-connected" };
    conversationId = null;
  }
  if (conversationId === null) return { state: "no-conversation" };
  return { state: "yes", target: { channel: channel.name, send, conversationId } };
}

/** The channels each link reaches. Each channel's service is a record read,
 *  so a call reads them once rather than once per account. */
function reachOf(deps: SendDeps): (linked: string) => Channel[] {
  return linkedChannels(deps.channels, deps.serviceOfChannel ?? ((channel) => channel));
}

export async function resolveSendTarget(deps: SendDeps, account: SendAccount): Promise<Resolution> {
  const resolved = await sendStateOf(reachOf(deps), account);
  return resolved.state === "yes"
    ? { ok: true, target: resolved.target }
    : { ok: false, send: resolved.state };
}

/**
 * Whether Rome can send to each of the given accounts, positionally.
 *
 * Only `conversationFor` can reach a provider, and it is asked at most once
 * per channel an account's link reaches — cheap on the channels in play, and
 * the reason a channel that keys threads separately has to be priced before it
 * is added to a listing read. A listing must not fail because one account of
 * one person could not be priced.
 */
export async function readSendStates(
  deps: SendDeps,
  accounts: readonly SendAccount[],
): Promise<AccountSendState[]> {
  const reach = reachOf(deps);
  return await Promise.all(
    accounts.map(async (account) => (await sendStateOf(reach, account)).state),
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
  const receipt = await target.send.send(target.conversationId, { text });
  return { messageId: receipt.messageId ?? null };
}
