import { randomUUID } from "node:crypto";
import { LINKABLE_SERVICES, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { platformOf } from "../../channels/platform.js";
import {
  approvals,
  channels,
  outboundMessages,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
  routines,
  sentinelLog,
  sessions,
  sessionTurnCheckpoints,
  sharedChats,
  webchatTurnFeedback,
  webchatWorkspaceLayouts,
} from "../schema.js";
import { inTransaction, type DrizzleDb, type DrizzleTx } from "../index.js";

/**
 * A channel a Connection backs, as stored: its id, the service and platform
 * it is on, the Connection behind it now (null once that Connection is gone),
 * and the agent linked to it. Vocabulary: docs/concepts/messaging.md#romes-accounts.
 */
export interface ChannelRecord {
  id: string;
  service: string;
  platform: string;
  connectionId: string | null;
  agent: string | null;
  createdAt: Date;
}

export class ChannelRecordNotFound extends Error {
  constructor(readonly channel: string) {
    super(`No channel with id "${channel}"`);
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

/** A link asked of a channel whose service takes no agent. */
export class ChannelNotLinkable extends Error {
  constructor(
    readonly channel: string,
    readonly service: string,
  ) {
    super(`A ${service} account cannot be linked to an agent`);
    this.name = "ChannelNotLinkable";
  }
}

type Exec = DrizzleDb | DrizzleTx;

/** Rows whose `column` begins with `prefix`, as a range its index serves. */
function startsWith(column: SQLiteColumn, prefix: string) {
  const next = String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return and(gte(column, prefix), lt(column, `${prefix.slice(0, -1)}${next}`));
}

/** An agent session whose key spells channel `id`, its sentinel's included. */
function keyedTo(id: string) {
  return or(
    startsWith(sessions.channelThreadKey, `${id}:`),
    startsWith(sessions.channelThreadKey, `sentinel:${id}:`),
  );
}

/** A message row of a conversation on channel `id`, by the conversation id
 *  every conversation on the channel takes (`channelConversationId`), so it
 *  is found even when its conversation row is gone. */
function onChannel(column: SQLiteColumn, id: string) {
  return startsWith(column, `channel:${id}:`);
}

/** The shape of an id `claim` mints when a service's name is taken. */
const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A conversation recorded through channel `id`: one on it, or the triage
 *  run the inbox's sentinel makes for a message on it. That run carries no
 *  thread, so its conversation is named by its agent session's key. */
function recordedThrough(id: string) {
  return or(
    eq(romeSessions.sourceChannel, id),
    and(eq(romeSessions.type, "action"), startsWith(romeSessions.name, `sentinel:${id}:`)),
  );
}

/**
 * Delete what was recorded through channel `id`: its conversations with their
 * messages, the agent sessions that served them, its outbox and its triage
 * log. Agent sessions are found by their key and messages by their
 * conversation id as well, since both spell the channel, so rows a turn wrote
 * after its conversation went are deleted too. A subagent conversation
 * carries its parent's channel, so it is one of the channel's conversations
 * and goes with it. Its id does not spell the channel, so its recorder writes
 * nothing once its conversation is gone. Any other conversation whose parent
 * goes stays, with no parent.
 *
 * What would act on the channel later stops, so it acts on no channel that
 * takes this id next: a routine that sends on it is turned off, and an
 * approval still waiting is rejected. That is an action asked from one of its
 * conversations that has not run, or failed and could be retried, or a reply
 * to send there. Migration 0084 runs the same changes for the channels left
 * unbacked before this.
 */
function deleteRecorded(exec: Exec, id: string): string[] {
  const conversations = exec
    .select({ id: romeSessions.id })
    .from(romeSessions)
    .where(recordedThrough(id));
  const agentSessions = exec
    .select({ id: sessions.id })
    .from(sessions)
    .where(or(inArray(sessions.conversationId, conversations), keyedTo(id)));
  exec
    .delete(sessionTurnCheckpoints)
    .where(inArray(sessionTurnCheckpoints.sessionId, agentSessions))
    .run();
  exec.delete(sessions).where(inArray(sessions.id, agentSessions)).run();
  exec
    .delete(romeAgentTraceBlocks)
    .where(
      or(
        inArray(romeAgentTraceBlocks.sessionId, conversations),
        onChannel(romeAgentTraceBlocks.sessionId, id),
      ),
    )
    .run();
  exec
    .delete(romeAgentMessages)
    .where(
      or(
        inArray(romeAgentMessages.sessionId, conversations),
        onChannel(romeAgentMessages.sessionId, id),
      ),
    )
    .run();
  exec
    .delete(webchatTurnFeedback)
    .where(inArray(webchatTurnFeedback.sessionId, conversations))
    .run();
  exec
    .delete(webchatWorkspaceLayouts)
    .where(inArray(webchatWorkspaceLayouts.sessionId, conversations))
    .run();
  exec.delete(sharedChats).where(inArray(sharedChats.sessionId, conversations)).run();
  exec
    .update(romeSessions)
    .set({ parentSessionId: null })
    .where(inArray(romeSessions.parentSessionId, conversations))
    .run();
  exec.delete(romeSessions).where(recordedThrough(id)).run();
  exec.delete(outboundMessages).where(eq(outboundMessages.channel, id)).run();
  exec.delete(sentinelLog).where(eq(sentinelLog.channel, id)).run();
  // A routine that sends on the channel would send through whichever account
  // takes this id next.
  const routinesOff = exec
    .update(routines)
    .set({ enabled: false })
    .where(
      and(
        eq(routines.actionName, "system:send_message"),
        sql`json_extract(${routines.args}, '$.channel') = ${id}`,
      ),
    )
    .returning({ id: routines.id })
    .all()
    .map((row) => row.id);
  exec
    .update(approvals)
    .set({
      status: "rejected",
      resolvedAt: new Date(),
      resolvedBy: "system:connection-disconnected",
      // A queued run will not start. A failed one keeps its failure.
      executionState: sql`CASE WHEN ${approvals.executionState} = 'queued' THEN 'idle' ELSE ${approvals.executionState} END`,
      payload: sql`json_set(${approvals.payload}, '$.resolution', 'superseded')`,
    })
    .where(
      or(
        and(
          eq(approvals.type, "action_execution"),
          or(
            eq(approvals.status, "pending"),
            and(
              eq(approvals.status, "approved"),
              inArray(approvals.executionState, ["queued", "failed"]),
            ),
          ),
          sql`json_extract(${approvals.payload}, '$.channelContext.channel') = ${id}`,
        ),
        and(
          eq(approvals.type, "outgoing_message"),
          eq(approvals.status, "pending"),
          sql`json_extract(${approvals.payload}, '$.channel') = ${id}`,
        ),
      ),
    )
    .run();
  return routinesOff;
}

/** The service a channel belongs to. A service's first channel carries the
 *  service's name, so a name with no record answers for itself. */
export type ServiceOfChannel = (channel: string) => string;

function toRecord(row: typeof channels.$inferSelect): ChannelRecord {
  return {
    id: row.id,
    service: row.service,
    platform: row.platform,
    connectionId: row.connectionId,
    agent: row.agent,
    createdAt: row.createdAt,
  };
}

/**
 * The channels the Connections back, and which agent each is linked to.
 *
 * A channel's id is minted once and never changes, since every stored row
 * spells it. It is an opaque id, except that a service's first channel carries
 * the service's name, which is what data stored before channels were recorded
 * spells. When a linkable service's Connection goes, its row goes with every
 * conversation and agent session recorded through it, so the service's next
 * Connection starts fresh even when it takes the same id. Another service's
 * row stays when its Connection goes, and that service's next Connection
 * takes it back, since apps address that service's one channel by its name.
 */
export class ChannelRecordsRepository {
  /** Channel id by Connection id, read on every port use. Every write that
   *  moves a Connection empties it (a link moves none), and nothing is cached
   *  while a transaction is open, so a rolled-back write leaves no id behind. */
  private readonly ids = new Map<string, string | null>();
  /** The ids of channels this repository deleted. A live agent session keeps
   *  its provider context in memory under a key that spells its channel, and a
   *  turn still running when its account is disconnected keeps it past the
   *  idle sweep. So no channel is minted under such an id until Rome restarts,
   *  when no live session is left to hold one. */
  private readonly deleted = new Set<string>();

  constructor(private readonly db: DrizzleDb) {}

  all(): ChannelRecord[] {
    return this.db.select().from(channels).orderBy(asc(channels.createdAt)).all().map(toRecord);
  }

  byId(id: string): ChannelRecord | null {
    const row = this.db.select().from(channels).where(eq(channels.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /** The service behind channel `id`, or `id` itself when no channel
   *  records it: a service's first channel's id is the service's name. */
  serviceOf(id: string): string {
    return this.byId(id)?.service ?? id;
  }

  /** The id of the channel `connectionId` backs, or null for none. */
  idOf(connectionId: string): string | null {
    const cached = this.ids.get(connectionId);
    if (cached !== undefined) return cached;
    const id = this.byConnection(connectionId)?.id ?? null;
    if (!inTransaction(this.db)) this.ids.set(connectionId, id);
    return id;
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
   * mints the Connection). A Connection that already has one keeps it. A
   * Connection of a linkable service never takes over another account's
   * channel, so it starts with no history. A Connection of any other service
   * takes back the service's unbacked channel, the one carrying the service's
   * name first. Failing that, it gets the service's name if no channel holds
   * it, and a fresh opaque id otherwise. A new channel is linked to `agent`
   * when its service takes one, and to none by default: Rome never picks an
   * account's agent, so a newly connected account is silent until the
   * guardian links one. `domain` is a Feishu app's domain, which decides its channel's platform.
   */
  claim(
    exec: Exec,
    connection: { id: string; service: string; domain?: string },
    now: Date,
    agent: string | null = null,
  ): ChannelRecord {
    const held = exec.select().from(channels).where(eq(channels.connectionId, connection.id)).get();
    if (held) return toRecord(held);
    this.ids.clear();

    const service = connection.service;
    const vacant = LINKABLE_SERVICES.has(service)
      ? undefined
      : exec
          .select()
          .from(channels)
          .where(and(eq(channels.service, service), isNull(channels.connectionId)))
          .all()
          .sort(
            (a, b) =>
              Number(b.id === service) - Number(a.id === service) ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          )[0];
    if (vacant) {
      // Only a service that takes no agent gets here, so the channel starts with none.
      exec
        .update(channels)
        .set({ connectionId: connection.id, agent: null })
        .where(eq(channels.id, vacant.id))
        .run();
      return toRecord({ ...vacant, connectionId: connection.id, agent: null });
    }

    const serviceIdTaken =
      this.deleted.has(service) ||
      exec.select({ id: channels.id }).from(channels).where(eq(channels.id, service)).get() !==
        undefined;
    const id = serviceIdTaken ? randomUUID() : service;
    const row = {
      id,
      service,
      platform: platformOf(service, connection.domain),
      connectionId: connection.id,
      agent: LINKABLE_SERVICES.has(service) ? agent : null,
      createdAt: now,
    };
    exec.insert(channels).values(row).run();
    return toRecord(row);
  }

  /** Release the channel `connectionId` backs. A linkable service's channel
   *  is deleted with everything recorded through it. Any other service's row
   *  and id stay for its next Connection, and its link goes: an agent stays
   *  linked only where it can still answer. Returns the ids of the routines
   *  turned off, for the caller to stop their live triggers. */
  vacate(exec: Exec, connectionId: string): string[] {
    this.ids.clear();
    const row = exec.select().from(channels).where(eq(channels.connectionId, connectionId)).get();
    if (row && LINKABLE_SERVICES.has(row.service)) {
      const routinesOff = deleteRecorded(exec, row.id);
      exec.delete(channels).where(eq(channels.id, row.id)).run();
      this.deleted.add(row.id);
      return routinesOff;
    }
    exec
      .update(channels)
      .set({ connectionId: null, agent: null })
      .where(eq(channels.connectionId, connectionId))
      .run();
    return [];
  }

  /**
   * Link `agent` to channel `id`, or unlink it with null, and return the
   * channel as it now stands. Only channel `id` changes: an agent may be the
   * agent of any number of channels, several on one platform included. Main is
   * stored by its canonical id. Only a channel of a linkable service takes a
   * link; unlinking is always open.
   */
  link(id: string, requested: string | null): ChannelRecord {
    const agent = requested !== null && isCoreMainAgentId(requested) ? MAIN_AGENT_ID : requested;
    return this.db.transaction((tx) => {
      const row = tx.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new ChannelRecordNotFound(id);
      if (agent !== null && !LINKABLE_SERVICES.has(row.service)) {
        throw new ChannelNotLinkable(id, row.service);
      }
      if (agent !== null && row.connectionId === null) throw new ChannelUnbacked(id);
      tx.update(channels).set({ agent }).where(eq(channels.id, id)).run();
      return toRecord({ ...row, agent });
    });
  }

  /**
   * Delete what is recorded under a channel id no row holds: a linkable
   * service's name, or an id `claim` minted that a conversation, outbox,
   * triage or transcript row records. Such rows are what a turn still
   * running when its account was disconnected wrote after the deletes, and
   * what was recorded through an account disconnected before channels were
   * recorded. Run at boot after every Connection has its channel, before any
   * new account can take a service's name, so none inherits them. Returns
   * the ids swept.
   */
  sweep(): string[] {
    const held = new Set(
      this.db
        .select({ id: channels.id })
        .from(channels)
        .all()
        .map((row) => row.id),
    );
    const recorded = new Set<string>(LINKABLE_SERVICES);
    const named = [
      this.db.selectDistinct({ id: romeSessions.sourceChannel }).from(romeSessions).all(),
      this.db.selectDistinct({ id: outboundMessages.channel }).from(outboundMessages).all(),
      this.db.selectDistinct({ id: sentinelLog.channel }).from(sentinelLog).all(),
    ].flat();
    // A transcript row of a channel conversation spells its channel in its
    // conversation id, and a late one may have no conversation row.
    const channelOf = (column: SQLiteColumn) => sql<string>`substr(${column}, 9, 36)`;
    const transcripts = [
      this.db
        .selectDistinct({ id: channelOf(romeAgentMessages.sessionId) })
        .from(romeAgentMessages)
        .where(startsWith(romeAgentMessages.sessionId, "channel:"))
        .all(),
      this.db
        .selectDistinct({ id: channelOf(romeAgentTraceBlocks.sessionId) })
        .from(romeAgentTraceBlocks)
        .where(startsWith(romeAgentTraceBlocks.sessionId, "channel:"))
        .all(),
    ].flat();
    for (const { id } of [...named, ...transcripts]) {
      if (id && MINTED_ID.test(id)) recorded.add(id);
    }
    const orphaned = [...recorded].filter((id) => !held.has(id));
    this.db.transaction((tx) => {
      for (const id of orphaned) deleteRecorded(tx, id);
    });
    return orphaned;
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
