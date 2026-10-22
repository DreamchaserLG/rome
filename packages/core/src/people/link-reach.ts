// What a link reaches. A link names an account on a platform, and every one of
// Rome's accounts on that platform reaches it, so the person page reads and
// sends through all of them (docs/domains/people.md#account).

import { platformOf } from "@rome/api-types/platform";
import type { StoredAddress } from "../channels/account-fold.js";
import type { Channels } from "../channels/channel.js";

/** The platform the channel `name` is an account on. */
export type PlatformOfChannel = (name: string) => string;

/** Reads a channel's name as its kind of connection, which names the platform
 *  of every kind's first channel. Production passes the channel records. */
const platformOfName: PlatformOfChannel = (name) => platformOf(name);

export interface ReachDeps {
  channels: Channels;
  platformOfChannel?: PlatformOfChannel;
}

/**
 * The link's account at each of Rome's accounts on its platform: the channel
 * the link names first, then the others in the channels' order. A link on a
 * platform no channel is on reaches only itself, which Rome's own stores can
 * still answer for.
 */
export function reachOf(deps: ReachDeps, link: StoredAddress): StoredAddress[] {
  const platformOfChannel = deps.platformOfChannel ?? platformOfName;
  const platform = platformOfChannel(link.channel);
  return [
    link,
    ...deps.channels
      .filter(
        (channel) => channel.name !== link.channel && platformOfChannel(channel.name) === platform,
      )
      .map((channel) => ({ channel: channel.name, channelUserId: link.channelUserId })),
  ];
}

/** Whether two channels are accounts on one platform. */
export function samePlatform(deps: ReachDeps, a: string, b: string): boolean {
  const platformOfChannel = deps.platformOfChannel ?? platformOfName;
  return platformOfChannel(a) === platformOfChannel(b);
}

/** Every link's reach, in the links' order. */
export function reachOfAll(deps: ReachDeps, links: readonly StoredAddress[]): StoredAddress[] {
  return links.flatMap((link) => reachOf(deps, link));
}
