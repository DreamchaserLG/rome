// Accounts and their linked agents. An account is a channel a Connection
// backs, as the dashboard shows it. Vocabulary: docs/concepts/messaging.md#channels.
// Invariants: docs/architecture/channels.md#linked-agents.

import { LINKABLE_SERVICES } from "@rome/api-types/linked-agents";
import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import {
  ChannelRecordNotFound,
  ChannelRecordsRepository,
  ChannelUnbacked,
  type ChannelRecord,
} from "../../db/repositories/channel-records.js";
import type { ApiDeps } from "../deps.js";

interface AccountView {
  name: string;
  service: string;
  platform: string;
  connectionId: string | null;
  agent: string | null;
}

function accountView(record: ChannelRecord): AccountView {
  return {
    name: record.name,
    service: record.service,
    platform: record.platform,
    connectionId: record.connectionId,
    agent: record.agent,
  };
}

export function channelAccountsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const channels = new ChannelRecordsRepository(deps.db);

  app.get("/channels/accounts", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ accounts: channels.all().map(accountView) });
  });

  // Link an agent to an account, or unlink it with `null`. Linking an agent
  // that has an account on the same platform takes it off that account. Only
  // an account of a linkable service takes a link; unlinking is always open.
  app.put("/channels/accounts/:name/agent", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const body = await c.req.json<{ agent?: unknown }>().catch(() => ({}) as { agent?: unknown });
    if (body.agent !== null && typeof body.agent !== "string") {
      return c.json({ error: "Name an agent, or null to unlink." }, 400);
    }
    const agent = typeof body.agent === "string" ? body.agent.trim() : null;
    if (agent !== null) {
      if (isCoreMainAgentId(agent)) {
        return c.json({ error: "Main answers wherever no agent is linked. Unlink instead." }, 400);
      }
      if (!deps.agentLoader.has(agent)) {
        return c.json({ error: `Agent "${agent}" is not loaded.` }, 400);
      }
    }
    const name = c.req.param("name");
    const record = channels.byName(name);
    if (agent !== null && record && !LINKABLE_SERVICES.has(record.service)) {
      return c.json({ error: `A ${record.service} account cannot be linked to an agent.` }, 400);
    }
    try {
      const outcome = channels.link(name, agent);
      return c.json({ account: accountView(outcome.channel), unlinkedFrom: outcome.unlinkedFrom });
    } catch (err) {
      if (err instanceof ChannelRecordNotFound) return c.json({ error: err.message }, 404);
      if (err instanceof ChannelUnbacked) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  return app;
}
