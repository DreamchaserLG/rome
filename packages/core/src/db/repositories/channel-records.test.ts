import { afterEach, describe, expect, it } from "@rstest/core";
import { channels } from "../schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import {
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
} from "./channel-records.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");

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

  it("names a service's first channel after it and later ones by number", () => {
    const records = repository();
    const db = testDb!.db;

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.claim(db, { id: "c2", service: "feishu" }, NOW).name).toBe("feishu-2");
    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW).name).toBe("feishu-3");
    expect(records.claim(db, { id: "c4", service: "telegram_user" }, NOW)).toMatchObject({
      name: "telegram_user",
      platform: "telegram",
    });
  });

  it("keeps the channel a Connection already holds", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect(records.claim(db, { id: "c1", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.all()).toHaveLength(1);
  });

  it("gives a released name back to the service's next Connection, unlinked", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    records.vacate(db, "c1");
    expect(records.byName("feishu")).toMatchObject({ connectionId: null, agent: null });

    expect(records.claim(db, { id: "c3", service: "feishu" }, NOW).name).toBe("feishu");
    expect(records.byConnection("c3")?.name).toBe("feishu");
  });

  it("moves an agent between channels of one platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    records.link("telegram", "sales:agent");

    const outcome = records.link("telegram_user", "sales:agent");

    expect(outcome).toMatchObject({
      channel: { name: "telegram_user", agent: "sales:agent" },
      unlinkedFrom: "telegram",
    });
    expect(records.byName("telegram")?.agent).toBeNull();
  });

  it("lets one agent hold a channel on each platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "telegram" }, NOW);
    records.link("feishu", "sales:agent");

    expect(records.link("telegram", "sales:agent").unlinkedFrom).toBeNull();
    expect(records.byName("feishu")?.agent).toBe("sales:agent");
  });

  it("unlinks with null and keeps other links", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");
    records.link("feishu-2", "support:agent");

    records.link("feishu", null);

    expect(records.byName("feishu")?.agent).toBeNull();
    expect(records.byName("feishu-2")?.agent).toBe("support:agent");
  });

  it("refuses a link to a missing or unbacked channel", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    expect(() => records.link("nope", "sales:agent")).toThrow(ChannelRecordNotFound);
    expect(() => records.link("feishu", "sales:agent")).toThrow(ChannelUnbacked);
  });

  it("rejects a direct write that links one agent twice on a platform", () => {
    const records = repository();
    const db = testDb!.db;
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.claim(db, { id: "c2", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    expect(() => db.update(channels).set({ agent: "sales:agent" }).run()).toThrow(
      /UNIQUE constraint failed/,
    );
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
