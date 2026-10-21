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

  it("keeps the service's name for a Connection whose history spells it", () => {
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

    expect(records.byConnection("c1")?.id).toBe("telegram");
  });
});
