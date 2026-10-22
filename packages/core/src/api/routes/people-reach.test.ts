import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import type { PersonResource } from "@rome/api-types/people";
import {
  buildTestDeps,
  createTestConnections,
  createTestDb,
  testChannels,
  type TestDb,
  type TestDeps,
} from "../../test/helpers.js";
import { peopleRoutes } from "./people.js";

// A link names an account on a platform, and every one of Rome's accounts on
// that platform reaches it (docs/domains/people.md#account). The Telegram bot
// and the signed-in Telegram are two of Rome's accounts on one platform.

const TG = "4242";

describe("People through every one of Rome's accounts on a platform", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let personId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db, { channels: ["telegram", "telegram_user", "webchat"] });
    personId = await deps.personMappingRepo.create({
      displayName: "Mei",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: TG }],
    });
  });
  afterEach(() => testDb.close());

  /** The bot has never talked to Mei, and the signed-in account has. */
  function botWithoutChat(): Hono {
    const connections = createTestConnections(deps.transports, (service, talk) =>
      service === "telegram" ? { ...talk, directMessaging: { chatFor: async () => null } } : talk,
    );
    return new Hono().route(
      "/",
      peopleRoutes({ ...deps, connections, channels: testChannels(deps, connections) }),
    );
  }

  it("sends from the first of Rome's accounts that already has a chat with them", async () => {
    const app = botWithoutChat();

    const person = (await (await app.request(`/people/${personId}`)).json()) as PersonResource;
    expect(person.accounts).toMatchObject([
      { channel: "telegram", channelUserId: TG, send: "yes" },
    ]);

    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: TG, text: "hi" }),
    });

    expect(res.status).toBe(202);
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    expect(deps.transports.get("telegram_user")?.sentMessages).toEqual([
      { chatId: TG, message: { text: "hi" } },
    ]);
  });

  it("sends from the account the link names when it has a chat", async () => {
    const app = new Hono().route("/", peopleRoutes(deps));

    await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: TG, text: "hi" }),
    });

    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    expect(deps.transports.get("telegram_user")?.sentMessages).toEqual([]);
  });
});
