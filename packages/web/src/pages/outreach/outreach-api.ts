import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";

// The Outreach surface's reads and writes.
//
// Envoys lists the agents that speak through the accounts Rome has connected.
// A connected account has at most one agent: its own account, or the guardian's
// account with the agent as delegate. An account with no agent is connected but
// unlinked, and Rome does not listen to it until an agent is linked.
//
// The backend for these routes does not exist yet. Mock mode answers them from
// `mock/handlers/outreach.ts`, and the types here are the contract a backend
// would implement.

export type ChatPlatform = "feishu" | "lark" | "telegram" | "discord" | "wechat";

/** Every platform an account can be connected on, in the order Envoys offers them.
 *  Feishu and Lark are separate platforms: one account cannot sign in to both. */
export const CHAT_PLATFORMS: readonly ChatPlatform[] = [
  "feishu",
  "lark",
  "telegram",
  "discord",
  "wechat",
];

/** How an account is set up on each platform: scanning a QR code in the app, or
 *  pasting the token the platform's developer console issued. */
export const PLATFORM_SETUP: Record<ChatPlatform, "qr" | "token"> = {
  feishu: "qr",
  lark: "qr",
  wechat: "qr",
  telegram: "token",
  discord: "token",
};

export interface OutreachFolder {
  path: string;
  access: "read" | "write";
}

/** How an agent is linked to an account: the account is the agent's own, or it
 *  is the guardian's and the agent answers on their behalf as a delegate. */
export type LinkKind = "own" | "delegate";

/** Platforms where the guardian can connect their own account for a delegate. */
export const DELEGATE_PLATFORMS: readonly ChatPlatform[] = ["telegram"];

export interface OutreachBot {
  id: string;
  platform: ChatPlatform;
  /** The name people see and @mention on the platform. */
  name: string;
  /** The agent that speaks through this account. */
  answersAs: string;
  kind: LinkKind;
  connectedAt: string;
  groups: number;
  dms: number;
}

/** A connected account with no agent. `kind` is the link it takes once an agent
 *  is linked: `delegate` when it is the guardian's own account. */
export interface UnlinkedAccount {
  id: string;
  platform: ChatPlatform;
  name: string;
  kind: LinkKind;
  connectedAt: string;
}

export interface OutreachAgent {
  name: string;
  description: string;
  model: string;
  tools: string[];
  folders: OutreachFolder[];
  canReadOtherChats: boolean;
  introduceOnJoin: boolean;
}

export interface OutreachAgentSummary extends OutreachAgent {
  bots: OutreachBot[];
  chats: number;
}

export interface BotRegistration {
  id: string;
  agent: string;
  botName: string;
  platform: ChatPlatform;
  kind: LinkKind;
  status: "waiting" | "connected" | "expired";
  /** A data URL of the QR code to scan in the chat app, for apps set up by QR. */
  qr: string | null;
  botId?: string;
}

const KEY = "outreach";

export const outreachKeys = {
  all: [KEY] as const,
  list: () => [KEY, "list"] as const,
  candidates: () => [KEY, "candidates"] as const,
  agent: (name: string) => [KEY, "agent", name] as const,
  registration: (id: string) => [KEY, "registration", id] as const,
};

const enc = encodeURIComponent;

export function useOutreachAgents() {
  return useQuery({
    queryKey: outreachKeys.list(),
    queryFn: () =>
      fetchJson<{ agents: OutreachAgentSummary[]; unlinked: UnlinkedAccount[] }>(
        "/api/outreach/agents",
        {
          fallback: "Failed to load envoys",
        },
      ),
  });
}

export function useOutreachCandidates() {
  return useQuery({
    queryKey: outreachKeys.candidates(),
    queryFn: () =>
      fetchJson<{ agents: OutreachAgent[] }>("/api/outreach/candidates", {
        fallback: "Failed to load agents",
      }),
  });
}

export function useOutreachAgent(name: string) {
  return useQuery({
    queryKey: outreachKeys.agent(name),
    queryFn: () =>
      fetchJson<OutreachAgentSummary>(`/api/outreach/agents/${enc(name)}`, {
        fallback: "Failed to load agent",
      }),
  });
}

export function useRegistration(id: string | null) {
  return useQuery({
    queryKey: outreachKeys.registration(id ?? ""),
    enabled: id !== null,
    queryFn: () =>
      fetchJson<BotRegistration>(`/api/outreach/registrations/${enc(id ?? "")}`, {
        fallback: "Failed to check the scan",
      }),
    refetchInterval: (query) => (query.state.data?.status === "waiting" ? 1500 : false),
  });
}

/** Every write settles by invalidating the whole surface, since switching or
 *  disconnecting one account changes counts on several agents at once. */
function useOutreachWrite<TVars, TResult>(write: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: outreachKeys.all }),
  });
}

export function useUpdateAgentSettings(name: string) {
  return useOutreachWrite(
    (patch: Partial<Pick<OutreachAgent, "canReadOtherChats" | "introduceOnJoin">>) =>
      fetchJson<OutreachAgent>(`/api/outreach/agents/${enc(name)}`, {
        method: "PATCH",
        json: patch,
        fallback: "Failed to save",
      }),
  );
}

/** Links, switches or unlinks the account's agent; `null` unlinks it. */
export function useMoveBot() {
  return useOutreachWrite((vars: { botId: string; answersAs: string | null }) =>
    fetchJson<void>(`/api/outreach/bots/${enc(vars.botId)}`, {
      method: "PATCH",
      json: { answersAs: vars.answersAs },
      fallback: "Failed to change the agent",
    }),
  );
}

export function useRemoveBot() {
  return useOutreachWrite((botId: string) =>
    fetchJson<void>(`/api/outreach/bots/${enc(botId)}`, {
      method: "DELETE",
      fallback: "Failed to disconnect the account",
    }),
  );
}

export function useStartRegistration() {
  return useMutation({
    mutationFn: (vars: {
      agent: string;
      botName: string;
      platform: ChatPlatform;
      kind: LinkKind;
      token?: string;
    }) =>
      fetchJson<BotRegistration>("/api/outreach/registrations", {
        method: "POST",
        json: vars,
        fallback: "Failed to connect the account",
      }),
  });
}
