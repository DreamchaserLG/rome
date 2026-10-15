import { afterEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import { channelAccountsRoutes } from "./channel-accounts.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("channel account routes", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup(loaded: string[] = ["sales:agent"]) {
    testDb = createTestDb();
    const records = new ChannelRecordsRepository(testDb.db);
    const app = new Hono().route(
      "/",
      channelAccountsRoutes({
        db: testDb.db,
        agentLoader: { has: (name: string) => loaded.includes(name) },
      } as unknown as ApiDeps),
    );
    const link = (
      name: string,
      agent: string | null,
      headers: Record<string, string> = SAME_ORIGIN,
    ) =>
      app.request(`/channels/accounts/${name}/agent`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ agent }),
      });
    return { records, app, link, db: testDb.db };
  }

  it("lists each account with its linked agent", async () => {
    const { records, app, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.link("feishu", "sales:agent");

    const res = await app.request("/channels/accounts");

    expect(await res.json()).toEqual({
      accounts: [
        {
          name: "feishu",
          service: "feishu",
          platform: "feishu",
          connectionId: "c1",
          agent: "sales:agent",
        },
      ],
    });
  });

  it("links an agent and reports the account it moved from", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "telegram" }, NOW);
    records.claim(db, { id: "c2", service: "telegram_user" }, NOW);
    await link("telegram", "sales:agent");

    const res = await link("telegram_user", "sales:agent");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { name: "telegram_user", agent: "sales:agent" },
      unlinkedFrom: "telegram",
    });
    expect(records.byName("telegram")?.agent).toBeNull();
  });

  it("refuses main, an agent that is not loaded, and a body without an agent", async () => {
    const { records, link, app, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    expect((await link("feishu", "main")).status).toBe(400);
    expect((await link("feishu", "ghost:agent")).status).toBe(400);
    const empty = await app.request("/channels/accounts/feishu/agent", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: "{}",
    });
    expect(empty.status).toBe(400);
    expect(records.byName("feishu")?.agent).toBeNull();
  });

  it("refuses to link an account of a service that is not linkable", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "agents" }, NOW);

    expect((await link("agents", "sales:agent")).status).toBe(400);
    expect((await link("agents", null)).status).toBe(200);
    expect(records.byName("agents")?.agent).toBeNull();
  });

  it("answers 404 for a missing account and 409 for an unbacked one", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);
    records.vacate(db, "c1");

    expect((await link("nope", "sales:agent")).status).toBe(404);
    expect((await link("feishu", "sales:agent")).status).toBe(409);
  });

  it("rejects a cross-site link", async () => {
    const { records, link, db } = setup();
    records.claim(db, { id: "c1", service: "feishu" }, NOW);

    const res = await link("feishu", "sales:agent", {
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(records.byName("feishu")?.agent).toBeNull();
  });
});
