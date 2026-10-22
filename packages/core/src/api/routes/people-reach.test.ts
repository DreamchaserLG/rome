import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
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
// that platform reaches it (docs/domains/people.md#account). The two fake
// Telegram channels here are two of Rome's accounts on one platform that can
// both send.

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

  /** The bot cannot open a conversation with Mei, and the other account can. */
  function botWithoutChat(): Hono {
    const connections = createTestConnections(deps.transports, (service, talk) =>
      service === "telegram" ? { ...talk, directMessaging: { chatFor: async () => null } } : talk,
    );
    const noBotChat = { ...deps, connections, channels: testChannels(deps, connections) };
    return new Hono().route("/", peopleRoutes(noBotChat));
  }

  it("sends from another of Rome's accounts on the platform when the link's own cannot", async () => {
    const app = botWithoutChat();
    const recorded = rs.spyOn(deps.webchatRepo, "ensureChannelChat");

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
    // Rome's transcript files the message under the channel that carried it.
    expect(recorded).toHaveBeenCalledWith({ channel: "telegram_user", threadId: TG });
  });

  it("sends from the account the link names when none has talked with them", async () => {
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
