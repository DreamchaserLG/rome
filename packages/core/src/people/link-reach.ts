// What a link reaches. A link names an account on a platform, and every one of
// Rome's accounts on that platform reaches it, so the person page reads through
// all of them (docs/domains/people.md#account).

import { platformOf } from "@rome/api-types/platform";
import type { StoredAddress } from "../channels/account-fold.js";
import type { Channels } from "../channels/channel.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";

/** The platform the channel `name` is an account on. */
export type PlatformOfChannel = (name: string) => string;

/** Reads a channel's name as its kind of connection, which names the platform
 *  of every kind's first channel. Production passes the channel records. */
const platformOfName: PlatformOfChannel = (name) => platformOf(name);

export interface ReachDeps {
  channels: Channels;
  personMappingRepo: Pick<PersonMappingRepository, "findByChannelUser">;
  platformOfChannel?: PlatformOfChannel;
  /** Every channel Rome has a record of, connected or not. A disconnected
   *  account's transcript and outbox rows stay readable after a restart drops
   *  it from `channels`. */
  recordedChannels?: () => readonly string[];
}

/** The person whose links are read, as the repository returns them. */
export interface LinkHolder {
  id: string;
  channelMappings: readonly StoredAddress[];
}

/**
 * The link's account at each of Rome's accounts on its platform: the channel
 * the link names first, then the others, live channels before disconnected
 * ones. A link on a platform no other channel is on reaches only itself.
 *
 * Links are still keyed by connection kind, so another person can hold the
 * same id under a second kind on the platform. That address stays theirs and
 * is left out, so one person's page never shows or acts on another's history.
 */
export async function reachOf(
  deps: ReachDeps,
  holderId: string,
  link: StoredAddress,
): Promise<StoredAddress[]> {
  const platformOfChannel = deps.platformOfChannel ?? platformOfName;
  const platform = platformOfChannel(link.channel);
  const names = new Set([
    ...deps.channels.map((channel) => channel.name),
    ...(deps.recordedChannels?.() ?? []),
  ]);
  const reach = [link];
  for (const name of names) {
    if (name === link.channel || platformOfChannel(name) !== platform) continue;
    const holder = await deps.personMappingRepo.findByChannelUser(name, link.channelUserId);
    if (holder && holder.id !== holderId) continue;
    reach.push({ channel: name, channelUserId: link.channelUserId });
  }
  return reach;
}

/** Whether two channels are accounts on one platform. */
export function samePlatform(deps: ReachDeps, a: string, b: string): boolean {
  const platformOfChannel = deps.platformOfChannel ?? platformOfName;
  return platformOfChannel(a) === platformOfChannel(b);
}

/** Every one of a person's links' reach, in the links' order. */
export async function reachOfAll(deps: ReachDeps, person: LinkHolder): Promise<StoredAddress[]> {
  const reaches = await Promise.all(
    person.channelMappings.map((link) => reachOf(deps, person.id, link)),
  );
  return reaches.flat();
}
