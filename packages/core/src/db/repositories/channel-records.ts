import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { platformOf } from "../../channels/platform.js";
import { channels } from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its name, the service and platform
 * it is on, the Connection behind it now (null once that Connection is gone),
 * and the agent linked to it. Vocabulary: docs/concepts/messaging.md#channels.
 */
export interface ChannelRecord {
  name: string;
  service: string;
  platform: string;
  connectionId: string | null;
  agent: string | null;
  createdAt: Date;
}

/** What a link changed: the channel as it now stands, and the channel on the
 *  same platform the agent was taken from, if it was linked to one. */
export interface LinkOutcome {
  channel: ChannelRecord;
  unlinkedFrom: string | null;
}

export class ChannelRecordNotFound extends Error {
  constructor(readonly channel: string) {
    super(`No channel named "${channel}"`);
    this.name = "ChannelRecordNotFound";
  }
}

/** A link asked of a channel no Connection backs now. */
export class ChannelUnbacked extends Error {
  constructor(readonly channel: string) {
    super(`Channel "${channel}" has no connection, so no agent can be linked to it`);
    this.name = "ChannelUnbacked";
  }
}

type Exec = DrizzleDb | DrizzleTx;

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    name: row.name,
    service: row.service,
    platform: row.platform,
    connectionId: row.connectionId,
    agent: row.agent,
    createdAt: row.createdAt,
  };
}

/** The order a service's channels are named in: the service's own name, then
 *  `<service>-2`, `<service>-3` and on. Null for a name outside that series. */
function seriesIndex(service: string, name: string): number | null {
  if (name === service) return 1;
  const suffix = name.startsWith(`${service}-`) ? name.slice(service.length + 1) : "";
  return /^[1-9][0-9]*$/.test(suffix) && Number(suffix) >= 2 ? Number(suffix) : null;
}

/**
 * The channels the Connections back, and which agent each is linked to.
 *
 * A channel's name is minted once and never changes, since every stored row
 * spells it. A row stays when its Connection goes, and the service's next
 * Connection takes it back before a new name is minted.
 */
export class ChannelRecordsRepository {
  constructor(private readonly db: DrizzleDb) {}

  all(): ChannelRecord[] {
    return this.db.select().from(channels).orderBy(asc(channels.createdAt)).all().map(toRecord);
  }

  byName(name: string): ChannelRecord | null {
    const row = this.db.select().from(channels).where(eq(channels.name, name)).get();
    return row ? toRecord(row) : null;
  }

  byConnection(connectionId: string): ChannelRecord | null {
    const row = this.db
      .select()
      .from(channels)
      .where(eq(channels.connectionId, connectionId))
      .get();
    return row ? toRecord(row) : null;
  }

  /**
   * The channel `connection` backs, recorded in `exec` (the transaction that
   * mints the Connection). A Connection that already has one keeps it. Else
   * it takes the service's first unbacked channel in naming order, and
   * failing that, the first unused name in the series.
   */
  claim(exec: Exec, connection: { id: string; service: string }, now: Date): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);

    const service = connection.service;
    const ofService = exec.select().from(channels).where(eq(channels.service, service)).all();
    const vacant = ofService
      .filter((row) => row.connectionId === null)
      .map((row) => ({ row, index: seriesIndex(service, row.name) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.index - b.index || a.row.name.localeCompare(b.row.name))[0];
    if (vacant) {
      exec
        .update(channels)
        .set({ connectionId: connection.id })
        .where(eq(channels.name, vacant.row.name))
        .run();
      return toRecord({ ...vacant.row, connectionId: connection.id });
    }

    const taken = new Set(
      exec
        .select({ name: channels.name })
        .from(channels)
        .all()
        .map((r) => r.name),
    );
    let index = 1;
    let name = service;
    while (taken.has(name)) {
      index += 1;
      name = `${service}-${index}`;
    }
    const row = {
      name,
      service,
      platform: platformOf(service),
      connectionId: connection.id,
      agent: null,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. The row and its name stay, and
   *  its link goes: an agent stays linked only where it can still answer. */
  vacate(exec: Exec, connectionId: string): void {
    exec
      .update(channels)
      .set({ connectionId: null, agent: null })
      .where(eq(channels.connectionId, connectionId))
      .run();
  }

  /**
   * Link `agent` to the channel named `name`, or unlink it with null. On one
   * platform an agent is linked to at most one channel, so linking it here
   * unlinks it from any other channel on this platform, in the same
   * transaction. The partial unique index rejects any write that would break
   * the rule anyway.
   */
  link(name: string, agent: string | null): LinkOutcome {
    return this.db.transaction((tx) => {
      const row = tx.select().from(channels).where(eq(channels.name, name)).get();
      if (!row) throw new ChannelRecordNotFound(name);
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(name);
      let unlinkedFrom: string | null = null;
      if (agent !== null) {
        const holder = tx
          .select({ name: channels.name })
          .from(channels)
          .where(
            and(
              eq(channels.platform, row.platform),
              eq(channels.agent, agent),
              ne(channels.name, name),
            ),
          )
          .get();
        if (holder) {
          tx.update(channels).set({ agent: null }).where(eq(channels.name, holder.name)).run();
          unlinkedFrom = holder.name;
        }
      }
      tx.update(channels).set({ agent }).where(eq(channels.name, name)).run();
      return { channel: toRecord({ ...row, agent }), unlinkedFrom };
    });
  }

  /** The Connections no channel records yet, for the boot pass that gives
   *  each a channel. */
  unclaimed(connections: ReadonlyArray<{ id: string; service: string }>): Array<{
    id: string;
    service: string;
  }> {
    const claimed = new Set(
      this.db
        .select({ connectionId: channels.connectionId })
        .from(channels)
        .where(isNotNull(channels.connectionId))
        .all()
        .map((row) => row.connectionId),
    );
    return connections.filter((connection) => !claimed.has(connection.id));
  }
}
