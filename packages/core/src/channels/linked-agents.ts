/**
 * The agent linked to a channel, as the channels Rome hands to the
 * `channel-message` hook carry it. Vocabulary:
 * docs/concepts/messaging.md#channels. Invariants:
 * docs/architecture/channels.md#linked-agents.
 */

import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import type { Channel } from "./channel.js";

/**
 * Give `channel` a `linkedAgent` read from its record each time it is asked,
 * so a relink takes effect on the next message with nothing rebuilt. A
 * channel no record names, such as WhatsApp's, has none.
 */
export function withLinkedAgent<C extends Pick<Channel, "name">>(
  channel: C,
  records: Pick<ChannelRecordsRepository, "byName">,
): C {
  Object.defineProperty(channel, "linkedAgent", {
    get: () => records.byName(channel.name)?.agent ?? null,
    enumerable: false,
    configurable: true,
  });
  return channel;
}
