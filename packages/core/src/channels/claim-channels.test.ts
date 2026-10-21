import { afterEach, describe, expect, it } from "@rstest/core";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { claimChannels } from "./claim-channels.js";

describe("claimChannels", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  it("names each unrecorded Connection after its service and keeps recorded ones", () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    records.claim(testDb.db, { id: "c1", service: "feishu" }, new Date());

    claimChannels(testDb.db, records, [
      { id: "c1", service: "feishu" },
      { id: "c2", service: "telegram" },
      { id: "c3", service: "discord" },
    ]);

    expect(records.byConnection("c1")?.id).toBe("feishu");
    expect(records.byConnection("c2")?.id).toBe("telegram");
    expect(records.byConnection("c3")?.id).toBe("discord");
    expect(records.all()).toHaveLength(3);
  });

  it("keeps the service's name and history for a Connection from before channels", () => {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    const now = new Date();
    testDb.db
      .insert(romeSessions)
      .values({
        id: "channel:telegram:t1",
        name: "t1",
        type: "channel",
        sourceChannel: "telegram",
        sourceThreadId: "t1",
        activityAt: now,
        createdAt: now,
      })
      .run();

    claimChannels(testDb.db, records, [{ id: "c1", service: "telegram" }]);
    // Boot sweeps after this pass, and the account's history is its own.
    records.sweep();

    expect(records.byConnection("c1")?.id).toBe("telegram");
    expect(testDb.db.select().from(romeSessions).all()).toHaveLength(1);
  });
});
