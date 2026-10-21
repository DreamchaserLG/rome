import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { DrizzleDb } from "./index.js";
import {
  channels,
  outboundMessages,
  romeAgentMessages,
  romeSessions,
  sessions,
  sessionTurnCheckpoints,
} from "./schema.js";

const DELETE_DISCONNECTED = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/system/0083_delete_disconnected_accounts.sql",
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
    }
    db.insert(romeSessions)
      .values({
        id: "child",
        name: "child",
        type: "subagent",
        parentSessionId: "gone",
        createdAt: NOW,
      })
      .run();
    for (const [id, key, conversationId] of [
      ["a-gone", "telegram:t1", "gone"],
      ["a-legacy", "telegram:t9", null],
      ["a-sentinel", "sentinel:telegram:t1", null],
      ["a-live", "telegram_user:t1", "live"],
      ["a-mail", "email:t1", "mail"],
    ] as const) {
      db.insert(sessions)
        .values({
          id,
          agentName: "main",
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

    migrate(db);

    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    expect(ids(db.select().from(channels).all())).toEqual(["email", "telegram_user"]);
    expect(ids(db.select().from(romeSessions).all())).toEqual(["child", "live", "mail"]);
    expect(ids(db.select().from(romeAgentMessages).all())).toEqual(["m-live", "m-mail"]);
    expect(ids(db.select().from(outboundMessages).all())).toEqual(["o-live", "o-mail"]);
    expect(ids(db.select().from(sessions).all())).toEqual(["a-live", "a-mail"]);
    expect(
      db
        .select()
        .from(sessionTurnCheckpoints)
        .all()
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual(["a-live", "a-mail"]);
  });
});
