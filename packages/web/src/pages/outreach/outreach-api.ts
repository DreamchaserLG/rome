import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";

// The Outreach surface's reads and writes.
//
// Outreach lists the agents that a bot answers as. A bot is an agent's presence
// on a chat app; underneath it runs over a channel, which is why the same bot
// also shows in Connections. A chat is stored once with its whole history,
// however many of the guardian's bots are in it, so two agents in one group
// read one transcript.
//
// The backend for these routes does not exist yet. Mock mode answers them from
// `mock/handlers/outreach.ts`, and the types here are the contract a backend
// would implement.

export type ChatPlatform = "feishu" | "telegram" | "discord" | "wechat";

/** Every chat app an agent can get an account on, in the order Outreach offers them. */
export const CHAT_PLATFORMS: readonly ChatPlatform[] = ["feishu", "telegram", "discord", "wechat"];

/** How an account is created on each app: scanning a QR code in the app, or
 *  pasting the token the app's developer console issued. */
export const PLATFORM_SETUP: Record<ChatPlatform, "qr" | "token"> = {
  feishu: "qr",
  wechat: "qr",
  telegram: "token",
  discord: "token",
};

export interface OutreachFolder {
  path: string;
  access: "read" | "write";
}

export interface OutreachBot {
  id: string;
  platform: ChatPlatform;
  /** The name people see and @mention in the chat app. */
  name: string;
  /** The agent this bot answers as. */
  answersAs: string;
  connectedAt: string;
  groups: number;
  dms: number;
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

export interface ChatBotRef {
  id: string;
  name: string;
  answersAs: string;
}

export interface OutreachChat {
  id: string;
  platform: ChatPlatform;
  kind: "group" | "dm";
  name: string;
  members: number;
  bots: ChatBotRef[];
  addedBy: string;
  joinedAt: string;
  lastMessageAt: string | null;
  preview: string | null;
}

export type ChatEntry =
  | { kind: "event"; id: string; at: string; text: string }
  | {
      kind: "message";
      id: string;
      at: string;
      sender: string;
      /** Set when a bot sent it; names the bot and the agent it answered as. */
      bot?: { id: string; agent: string };
      text: string;
    };

export interface ChatDetail {
  chat: OutreachChat;
  entries: ChatEntry[];
}

export interface ActivityItem {
  chatId: string;
  chatName: string;
  entry: Extract<ChatEntry, { kind: "message" }>;
}

export interface BotRegistration {
  id: string;
  agent: string;
  botName: string;
  platform: ChatPlatform;
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
  chats: (name: string) => [KEY, "chats", name] as const,
  chat: (id: string) => [KEY, "chat", id] as const,
  activity: (name: string) => [KEY, "activity", name] as const,
  registration: (id: string) => [KEY, "registration", id] as const,
};

const enc = encodeURIComponent;

export function useOutreachAgents() {
  return useQuery({
    queryKey: outreachKeys.list(),
    queryFn: () =>
      fetchJson<{ agents: OutreachAgentSummary[] }>("/api/outreach/agents", {
        fallback: "Failed to load outreach agents",
      }),
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

export function useAgentChats(name: string) {
  return useQuery({
    queryKey: outreachKeys.chats(name),
    queryFn: () =>
      fetchJson<{ chats: OutreachChat[] }>(`/api/outreach/agents/${enc(name)}/chats`, {
        fallback: "Failed to load chats",
      }),
  });
}

export function useChat(id: string) {
  return useQuery({
    queryKey: outreachKeys.chat(id),
    queryFn: () =>
      fetchJson<ChatDetail>(`/api/outreach/chats/${enc(id)}`, { fallback: "Failed to load chat" }),
  });
}

export function useAgentActivity(name: string) {
  return useQuery({
    queryKey: outreachKeys.activity(name),
    queryFn: () =>
      fetchJson<{ items: ActivityItem[] }>(`/api/outreach/agents/${enc(name)}/activity`, {
        fallback: "Failed to load activity",
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

/** Every write settles by invalidating the whole surface, since moving or
 *  removing one bot changes counts on several agents at once. */
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

export function useMoveBot() {
  return useOutreachWrite((vars: { botId: string; answersAs: string }) =>
    fetchJson<OutreachBot>(`/api/outreach/bots/${enc(vars.botId)}`, {
      method: "PATCH",
      json: { answersAs: vars.answersAs },
      fallback: "Failed to move the bot",
    }),
  );
}

export function useRemoveBot() {
  return useOutreachWrite((botId: string) =>
    fetchJson<void>(`/api/outreach/bots/${enc(botId)}`, {
      method: "DELETE",
      fallback: "Failed to remove the bot",
    }),
  );
}

export function useStartRegistration() {
  return useMutation({
    mutationFn: (vars: {
      agent: string;
      botName: string;
      platform: ChatPlatform;
      region?: "feishu" | "lark";
      token?: string;
    }) =>
      fetchJson<BotRegistration>("/api/outreach/registrations", {
        method: "POST",
        json: vars,
        fallback: "Failed to create the account",
      }),
  });
}
