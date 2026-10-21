import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { DrizzleDb } from "./index.js";
import {
  approvals,
  channels,
  outboundMessages,
  romeAgentMessages,
  romeSessions,
  routines,
  sentinelLog,
  sessions,
  sessionTurnCheckpoints,
} from "./schema.js";

const DELETE_DISCONNECTED = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/system/0084_delete_disconnected_accounts.sql",
  ),
  "utf8",
);

const NOW = new Date("2026-10-21T00:00:00.000Z");

/** Runs the migration again over the seeded rows. The test database is
 *  already migrated, so this replays it against data it never saw. */
function migrate(db: DrizzleDb): void {
  for (const statement of DELETE_DISCONNECTED.split("--> statement-breakpoint")) {
    db.run(sql.raw(statement));
  }
}

describe("delete disconnected accounts migration", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("deletes an unbacked linkable channel with what was recorded through it", () => {
    testDb = createTestDb();
    const db = testDb.db;
    db.insert(channels)
      .values([
        { id: "telegram", service: "telegram", platform: "telegram", createdAt: NOW },
        {
          id: "telegram_user",
          service: "telegram_user",
          platform: "telegram",
          connectionId: "c2",
          agent: "core:main",
          createdAt: NOW,
        },
        { id: "email", service: "email", platform: "email", createdAt: NOW },
      ])
      .run();
    for (const [id, channel] of [
      ["gone", "telegram"],
      ["live", "telegram_user"],
      ["mail", "email"],
    ] as const) {
      db.insert(romeSessions)
        .values({
          id,
          name: id,
          type: "channel",
          sourceChannel: channel,
          sourceThreadId: "t1",
          activityAt: NOW,
          createdAt: NOW,
        })
        .run();
      db.insert(romeAgentMessages)
        .values({ id: `m-${id}`, sessionId: id, role: "user", content: "[]", createdAt: NOW })
        .run();
      db.insert(outboundMessages)
        .values({
          id: `o-${id}`,
          channel,
          channelUserId: "u1",
          conversationId: id,
          text: "hi",
          state: "failed",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      db.insert(sentinelLog)
        .values({
          id: `s-${id}`,
          messageId: `p-${id}`,
          channel,
          channelUserId: "u1",
          text: "hello",
          action: "replied",
          createdAt: NOW,
        })
        .run();
    }
    db.insert(romeAgentMessages)
      .values({
        id: "m-late",
        sessionId: "channel:telegram:t2",
        role: "assistant",
        content: "[]",
        createdAt: NOW,
      })
      .run();
    db.insert(romeSessions)
      .values({
        id: "child",
        name: "child",
        type: "subagent",
        sourceChannel: "telegram",
        parentSessionId: "gone",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    db.insert(romeSessions)
      .values({
        id: "fork",
        name: "fork",
        type: "fork",
        parentSessionId: "gone",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    // An agent named like the service: its ad-hoc key starts like a channel's.
    for (const [id, key, conversationId, agentName] of [
      ["a-gone", "telegram:t1", "gone", "main"],
      ["a-legacy", "telegram:t9", null, "main"],
      ["a-sentinel", "sentinel:telegram:t1", null, "main"],
      ["a-live", "telegram_user:t1", "live", "main"],
      ["a-mail", "email:t1", "mail", "main"],
      ["a-adhoc", "telegram:helper:0b5e2c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21", null, "telegram:helper"],
      ["a-elsewhere", "telegram:helper:run", "live", "main"],
    ] as const) {
      db.insert(sessions)
        .values({
          id,
          agentName,
          channelThreadKey: key,
          conversationId,
          createdAt: NOW,
          lastActiveAt: NOW,
          status: "completed",
        })
        .run();
      db.insert(sessionTurnCheckpoints)
        .values({
          sessionId: id,
          turnId: "turn",
          provider: "claude",
          providerThreadId: "p",
          checkpointId: "x",
          createdAt: NOW,
        })
        .run();
    }

    db.insert(approvals)
      .values(
        (["telegram", "telegram_user"] as const).map((channel) => ({
          id: `ap-${channel}`,
          type: "action_execution" as const,
          status: "pending" as const,
          requestedBy: "main",
          description: "d",
          payload: { channelContext: { channel, threadId: "t1" } },
          createdAt: NOW,
        })),
      )
      .run();
    // A send to the account asked from webchat.
    db.insert(approvals)
      .values({
        id: "ap-send",
        type: "action_execution",
        status: "pending",
        requestedBy: "main",
        description: "d",
        payload: {
          channelContext: { channel: "webchat", threadId: "w1" },
          actionName: "system:send_message",
          args: { channel: "telegram", threadId: "t1", text: "hi" },
        },
        createdAt: NOW,
      })
      .run();

    db.insert(romeSessions)
      .values({
        id: "triage",
        name: "sentinel:telegram:t1",
        type: "action",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    db.insert(routines)
      .values(
        (["telegram", "telegram_user"] as const).map((channel) => ({
          id: `r-${channel}`,
          name: "notify",
          trigger: { type: "schedule" },
          actionName: "system:send_message",
          args: { channel, threadId: "t1", text: "hi" },
          createdAt: NOW,
        })),
      )
      .run();
    db.insert(routines)
      .values({
        id: "r-bare",
        name: "notify",
        trigger: { type: "schedule" },
        actionName: "send_message",
        args: { channel: "telegram", threadId: "t1", text: "hi" },
        createdAt: NOW,
      })
      .run();

    migrate(db);

    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    expect(ids(db.select().from(channels).all())).toEqual(["email", "telegram_user"]);
    expect(ids(db.select().from(romeSessions).all())).toEqual(["fork", "live", "mail"]);
    expect(ids(db.select().from(romeAgentMessages).all())).toEqual(["m-live", "m-mail"]);
    expect(ids(db.select().from(outboundMessages).all())).toEqual(["o-live", "o-mail"]);
    expect(ids(db.select().from(sentinelLog).all())).toEqual(["s-live", "s-mail"]);
    expect(ids(db.select().from(sessions).all())).toEqual([
      "a-adhoc",
      "a-elsewhere",
      "a-live",
      "a-mail",
    ]);
    expect(
      db
        .select()
        .from(sessionTurnCheckpoints)
        .all()
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual(["a-adhoc", "a-elsewhere", "a-live", "a-mail"]);
    expect(
      Object.fromEntries(
        db
          .select()
          .from(approvals)
          .all()
          .map((row) => [row.id, row.status]),
      ),
    ).toEqual({
      "ap-send": "rejected",
      "ap-telegram": "rejected",
      "ap-telegram_user": "pending",
    });
    expect(
      Object.fromEntries(
        db
          .select()
          .from(routines)
          .all()
          .map((row) => [row.id, row.enabled]),
      ),
    ).toEqual({ "r-bare": false, "r-telegram": false, "r-telegram_user": true });
  });
});
