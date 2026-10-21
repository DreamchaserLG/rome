import { afterEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  channels,
  outboundMessages,
  romeAgentMessages,
  romeSessions,
  sentinelLog,
  sessions,
  sessionTurnCheckpoints,
} from "../schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import {
  ChannelNotLinkable,
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
} from "./channel-records.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("ChannelRecordsRepository", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function repository(): ChannelRecordsRepository {
    testDb = createTestDb();
    return new ChannelRecordsRepository(testDb.db);
  }

  it("names a service's first channel after it and later ones by an opaque id", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    const third = records.claim(db, { id: "c3", service: "feishu" }, NOW).id;
    expect(second).toMatch(UUID);
    expect(third).toMatch(UUID);
    expect(third).not.toBe(second);
    expect(records.claim(db, { id: "c4", service: "telegram_user" }, NOW)).toMatchObject({
      id: "telegram_user",
      platform: "telegram",
    });
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).id).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("deletes a released bot's channel, and a re-added bot starts fresh linked to main", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byId("feishu")).toBeNull();

    // A live agent session may still hold the deleted id, so this run mints
    // another one.
    const readded = records.claim(db, { id: "c2", service: "feishu" }, NOW);
    expect(readded).toMatchObject({ connectionId: "c2", agent: "core:main" });
    expect(readded.id).toMatch(UUID);
  });

  it("gives a deleted channel's id to a re-added bot after a restart", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    const restarted = new ChannelRecordsRepository(db);
    expect(restarted.claim(db, { id: "c2", service: "feishu" }, NOW)).toMatchObject({
      id: "feishu",
      agent: "core:main",
    });
  });

  it("deletes what was recorded through a released bot, and nothing of another account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    for (const [id, channel] of [
      ["gone", "telegram"],
      ["kept", "telegram_user"],
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
    db.insert(romeSessions)
      .values({
        id: "child",
        name: "child",
        type: "subagent",
        parentSessionId: "gone",
        activityAt: NOW,
        createdAt: NOW,
      })
      .run();
    for (const [id, key, conversationId] of [
      ["a-gone", "telegram:t1", "gone"],
      ["a-subagent", "telegram:t1:subagent:s1", null],
      ["a-sentinel", "sentinel:telegram:t1", null],
      ["a-kept", "telegram_user:t1", "kept"],
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

    records.vacate(db, "c1");

    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    expect(ids(records.all())).toEqual(["telegram_user"]);
    expect(ids(db.select().from(romeSessions).all())).toEqual(["child", "kept"]);
    expect(
      db.select().from(romeSessions).where(eq(romeSessions.id, "child")).get()?.parentSessionId,
    ).toBeNull();
    expect(ids(db.select().from(romeAgentMessages).all())).toEqual(["m-kept"]);
    expect(ids(db.select().from(outboundMessages).all())).toEqual(["o-kept"]);
    expect(ids(db.select().from(sentinelLog).all())).toEqual(["s-kept"]);
    expect(ids(db.select().from(sessions).all())).toEqual(["a-kept"]);
    expect(
      db
        .select()
        .from(sessionTurnCheckpoints)
        .all()
        .map((row) => row.sessionId),
    ).toEqual(["a-kept"]);
  });

  it("links main to a linkable service's first account only", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "telegram" }, NOW).agent).toBe("core:main");
    expect(records.claim(db, { id: "c2", service: "telegram_user" }, NOW).agent).toBe("core:main");
    expect(records.claim(db, { id: "c3", service: "telegram" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c4", service: "webchat" }, NOW).agent).toBeNull();
    expect(records.claim(db, { id: "c5", service: "agents" }, NOW).agent).toBeNull();
  });

  it("never gives a later account's channel to the next account", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const later = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link(later, "sales:agent");
    records.vacate(db, "c2");

    const next = records.claim(db, { id: "c3", service: "feishu" }, NOW);
    expect(next.id).not.toBe(later);
    expect(next.agent).toBeNull();
  });

  it("takes back a service's released channel when the service takes no agent", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "email" }, NOW);
    const later = records.claim(db, { id: "c2", service: "email" }, NOW).id;
    records.vacate(db, "c2");
    records.vacate(db, "c1");

    expect(records.claim(db, { id: "c3", service: "email" }, NOW).id).toBe("email");
    expect(records.claim(db, { id: "c4", service: "email" }, NOW).id).toBe(later);
  });

  it("names the service behind a channel, and passes an unrecorded name through", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "telegram" }, NOW);
    const second = records.claim(testDb!.db, { id: "c2", service: "telegram" }, NOW).id;

    expect(records.serviceOf(second)).toBe("telegram");
    expect(records.serviceOf("webchat")).toBe("webchat");
  });

  it("keeps a Connection's channel name current across claims and releases", () => {
    const records = repository();
    const db = testDb!.db;
    expect(records.idOf("c1")).toBeNull();

    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    expect(records.idOf("c1")).toBe("feishu");

    records.vacate(db, "c1");
    expect(records.idOf("c1")).toBeNull();
  });

  it("caches no name read inside a transaction that rolls back", () => {
    const records = repository();
    const db = testDb!.db;

    expect(() =>
      db.transaction((tx) => {
        records.claim(tx, { id: "c1", service: "feishu" }, NOW);
        expect(records.idOf("c1")).toBe("feishu");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(records.idOf("c1")).toBeNull();
  });

  it("links one agent to several channels of one platform and keeps each link", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    const later = records.claim(db, { id: "c3", service: "telegram" }, NOW).id;
    records.link("telegram", "sales:agent");

    expect(records.link("telegram_user", "sales:agent")).toMatchObject({
      id: "telegram_user",
      agent: "sales:agent",
    });
    records.link(later, "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("telegram_user")?.agent).toBe("sales:agent");
    expect(records.byId(later)?.agent).toBe("sales:agent");
  });

  it("unlinks one channel of an agent and leaves its other channels linked", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "sales:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("sales:agent");
  });

  it("links main to several channels of one platform, by its canonical id", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    const later = records.claim(db, { id: "c2", service: "telegram" }, NOW).id;

    expect(records.link(later, "main")).toMatchObject({ agent: "core:main" });
    expect(records.byId("telegram")?.agent).toBe("core:main");
    expect(() =>
      db.update(channels).set({ agent: "core:main" }).where(eq(channels.service, "telegram")).run(),
    ).not.toThrow();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "telegram" }, NOW);
    records.link("feishu", "sales:agent");

    records.link("telegram", "sales:agent");

    expect(records.byId("telegram")?.agent).toBe("sales:agent");
    expect(records.byId("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    const second = records.claim(db, { id: "c2", service: "feishu" }, NOW).id;
    records.link("feishu", "sales:agent");
    records.link(second, "support:agent");

    records.link("feishu", null);

    expect(records.byId("feishu")?.agent).toBeNull();
    expect(records.byId(second)?.agent).toBe("support:agent");
  });

  it("refuses a link to a missing or unbacked channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");
    db.insert(channels)
      .values({ id: "telegram", service: "telegram", platform: "telegram", createdAt: NOW })
      .run();

    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("telegram", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("refuses a link to a channel whose service takes none, and unlinks it", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect(() => records.link("agents", "sales:agent")).toThrow(ChannelNotLinkable);
    expect(records.link("agents", null).agent).toBeNull();
  });

  it("accepts a direct write that links one agent to every channel of a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).not.toThrow();
    expect(records.all().map((record) => record.agent)).toEqual(["sales:agent", "sales:agent"]);
  });

  it("lists the Connections no channel records yet", () => {
    const records = repository();
    records.claim(testDb!.db, { id: "c1", service: "feishu" }, NOW);

    expect(
      records.unclaimed([
        { id: "c1", service: "feishu" },
        { id: "c2", service: "discord" },
      ]),
    ).toEqual([{ id: "c2", service: "discord" }]);
  });
});
