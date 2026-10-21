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
// Nor does Rome pick among its own accounts of one service. A send names the
// one it goes out from, and Rome never substitutes another. Where nothing
// names one, a retry of a row from before rows recorded it, a link reaches the
// service's account only while the service has one (`ChannelOfLink`).
//
// Whether a channel can be sent to at all is the channel's own declaration:
// its `send` port's `direct`. A channel whose sending cannot reach an account
// directly cannot be written to from here, without a read-only flag threaded
// through anything.

import type { ChatId } from "@rome-os/app-runtime";
import type { AccountSendState } from "@rome/api-types/people";
import { ChannelNotConnected, type ChannelSend, type Channels } from "../channels/channel.js";
import type { ChannelOfLink, SendersOfLink } from "../db/repositories/channel-records.js";

export interface SendAccount {
  channel: string;
  channelUserId: string;
}

export interface SendDeps {
  channels: Channels;
  /** The one channel each link reaches. Absent, a link reaches the channel it
   *  names, which holds only while no service has a later channel. */
  channelOfLink?: ChannelOfLink;
  /** Rome's accounts a send to each link may name to go out from. Absent, a
   *  link's own channel. */
  sendersOfLink?: SendersOfLink;
}

/** A resolved target: the channel it is on, that channel's send port, and the
 *  conversation on it that reaches this account. It names the channel, not
 *  the Connection: the port finds the channel's Connection again when it
 *  sends. A channel holds at most one Connection, so that is the one the
 *  conversation was resolved on, unless the Connection was replaced in
 *  between. This is deliberate. */
export interface SendTarget {
  channel: string;
  send: ChannelSend;
  conversationId: ChatId;
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
  from?: string,
): Promise<{ state: RefusedState } | { state: "yes"; target: SendTarget }> {
  const name = from ?? (deps.channelOfLink ?? ((link: string) => link))(account.channel);
  // A link that reaches no one channel names a service Rome holds several
  // accounts of. No Connection answers for the link as such, and connecting
  // or removing an account is what settles it, so it reads as not connected.
  if (name === null) return { state: "not-connected" };
  const channel = deps.channels.find((candidate) => candidate.name === name);
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
  let conversationId: ChatId | null;
  try {
    conversationId = await direct.conversationFor(account.channelUserId);
  } catch (err) {
    if (err instanceof ChannelNotConnected) return { state: "not-connected" };
    conversationId = null;
  }
  if (conversationId === null) return { state: "no-conversation" };
  return { state: "yes", target: { channel: channel.name, send, conversationId } };
}

/**
 * The target a send to `account` goes out on. `from` names the channel of
 * Rome's account it goes out from, and no other is tried. The caller has
 * checked it is one of `SendersOfLink` for the account's link. Absent, the
 * account's link has to reach one channel (`channelOfLink`).
 */
export async function resolveSendTarget(
  deps: SendDeps,
  account: SendAccount,
  from?: string,
): Promise<Resolution> {
  const resolved = await sendStateOf(deps, account, from);
  return resolved.state === "yes"
    ? { ok: true, target: resolved.target }
    : { ok: false, send: resolved.state };
}

/** How near to sending each refusal is: a read reports the nearest of the
 *  accounts a send may go out from. */
const NEARNESS: Record<RefusedState, number> = {
  "not-connected": 0,
  unsupported: 1,
  "no-conversation": 2,
};

/**
 * Whether Rome can send to each of the given accounts, positionally: `yes`
 * when any of Rome's accounts a send may name as `from` (`sendersOfLink`) can,
 * and otherwise the refusal of the one that came nearest. A send still names
 * one, so this says whether there is one to name, and never which.
 *
 * Only `conversationFor` can reach a provider, and it is asked once per
 * account and account it may go out from — cheap on the channels in play, and
 * the reason a channel that keys threads separately has to be priced before
 * it is added to a listing read. A listing must not fail because one account
 * of one person could not be priced.
 */
export async function readSendStates(
  deps: SendDeps,
  accounts: readonly SendAccount[],
): Promise<AccountSendState[]> {
  const sendersOf = deps.sendersOfLink ?? ((link: string) => [link]);
  return await Promise.all(
    accounts.map(async (account): Promise<AccountSendState> => {
      const states = await Promise.all(
        sendersOf(account.channel).map(
          async (from) => (await sendStateOf(deps, account, from)).state,
        ),
      );
      if (states.includes("yes")) return "yes";
      let nearest: RefusedState = "not-connected";
      for (const state of states) {
        if (state !== "yes" && NEARNESS[state] > NEARNESS[nearest]) nearest = state;
      }
      return nearest;
    }),
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
