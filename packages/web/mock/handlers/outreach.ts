import { http, HttpResponse } from "msw";
import type {
  ActivityItem,
  BotRegistration,
  ChatPlatform,
  ChatEntry,
  LinkKind,
  OutreachAgent,
  OutreachAgentSummary,
  OutreachBot,
  OutreachChat,
} from "@/pages/outreach/outreach-api";

// Envoys: agents, the connected accounts they speak through, and the chats
// those accounts are in. The surface has no backend yet, so this module is the
// only implementation of its routes. Writes run against the in-memory store
// below.
//
// A chat is stored once with Rome's accounts that are in it, and an agent's
// chats are the chats where any account it speaks through is a member. That one
// lookup is the whole model, so it lives in `chatsOf` and every route goes
// through it. A stored account has at most one agent. One with none is connected
// but unlinked: Rome does not listen to it, so it reaches no chat. Disconnecting
// removes the account, and a chat goes when the last of Rome's accounts leaves it.

interface StoredBot {
  id: string;
  platform: ChatPlatform;
  name: string;
  answersAs: string | null;
  /** The kind of link the account takes: the agent's own account, or the
   *  guardian's with the agent as delegate. Kept while the account is unlinked. */
  kind: LinkKind;
  connectedAt: string;
}

interface StoredChat {
  id: string;
  kind: "group" | "dm";
  name: string;
  members: number;
  botIds: string[];
  addedBy: string;
  joinedAt: string;
  entries: ChatEntry[];
}

const day = (d: number, hh: number, mm: number) =>
  new Date(Date.UTC(2026, 9, d, hh - 8, mm)).toISOString();

const agents: OutreachAgent[] = [
  {
    name: "main",
    description: "Your everyday assistant. Answers you in Chat and through the Rome account.",
    model: "Large",
    tools: ["Read", "Write", "Bash", "WebSearch"],
    folders: [],
    canReadOtherChats: true,
    introduceOnJoin: false,
  },
  {
    name: "researcher",
    description: "Finds sources, reads them, and writes short briefs for the team.",
    model: "Large",
    tools: ["WebSearch", "WebFetch", "Read", "Write"],
    folders: [{ path: "~/research", access: "write" }],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
  {
    name: "writer",
    description: "Drafts release notes, announcements, and replies in the team's voice.",
    model: "Medium",
    tools: ["Read", "Write", "Edit"],
    folders: [
      { path: "~/docs/releases", access: "write" },
      { path: "~/brand", access: "read" },
    ],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
  {
    name: "coding",
    description: "Plans and makes code changes in your projects.",
    model: "Large",
    tools: ["Read", "Write", "Edit", "Bash"],
    folders: [],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
  {
    name: "planning",
    description: "Breaks a goal into steps and tracks them.",
    model: "Medium",
    tools: ["Read", "TodoWrite"],
    folders: [],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
  {
    name: "image-gen",
    description: "Makes images from a description.",
    model: "Medium",
    tools: ["ImageGeneration"],
    folders: [],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
  {
    name: "dream",
    description: "Reviews the day's sessions overnight and keeps notes.",
    model: "Small",
    tools: ["Read"],
    folders: [],
    canReadOtherChats: true,
    introduceOnJoin: true,
  },
];

let bots: StoredBot[] = [
  {
    id: "cli_rome",
    platform: "feishu",
    name: "Rome",
    answersAs: "main",
    kind: "own",
    connectedAt: day(2, 10, 0),
  },
  {
    id: "cli_writer",
    platform: "feishu",
    name: "Writer",
    answersAs: "writer",
    kind: "own",
    connectedAt: day(9, 9, 12),
  },
  {
    id: "tg_writer",
    platform: "telegram",
    name: "WriterRomeBot",
    answersAs: "writer",
    kind: "own",
    connectedAt: day(11, 14, 0),
  },
  {
    id: "tg_ouou",
    platform: "telegram",
    name: "Ouou",
    answersAs: "main",
    kind: "delegate",
    connectedAt: day(12, 9, 0),
  },
  {
    id: "dc_ops",
    platform: "discord",
    name: "Rome Ops",
    answersAs: null,
    kind: "own",
    connectedAt: day(13, 16, 30),
  },
];

let entrySeq = 0;
const ev = (at: string, text: string): ChatEntry => ({
  kind: "event",
  id: `e${++entrySeq}`,
  at,
  text,
});
const say = (at: string, sender: string, text: string): ChatEntry => ({
  kind: "message",
  id: `e${++entrySeq}`,
  at,
  sender,
  text,
});
const botSay = (at: string, botId: string, text: string): ChatEntry => {
  const bot = bots.find((b) => b.id === botId);
  if (!linked(bot)) throw new Error(`fixture message from unlinked account ${botId}`);
  return {
    kind: "message",
    id: `e${++entrySeq}`,
    at,
    sender: bot.name,
    bot: { id: bot.id, agent: bot.answersAs, kind: bot.kind },
    text,
  };
};

let chats: StoredChat[] = [
  {
    id: "oc_release",
    kind: "group",
    name: "Release crew",
    members: 8,
    botIds: ["cli_writer"],
    addedBy: "Lin Wei",
    joinedAt: day(9, 9, 20),
    entries: [
      ev(day(9, 9, 20), "Lin Wei added Writer to the group"),
      say(
        day(13, 9, 30),
        "Lin Wei",
        "@Writer we cut 1.8 today. Can you draft the release notes from the merged PRs?",
      ),
      botSay(
        day(13, 9, 42),
        "cli_writer",
        "The draft is in ~/docs/releases/1.8.md. Two open questions: do we mention the Lark region, and is the pricing change public yet?",
      ),
      say(day(13, 9, 44), "Zhao Min", "Pricing is not public until Friday."),
    ],
  },
  {
    id: "oc_launch",
    kind: "group",
    name: "Launch room",
    members: 6,
    botIds: ["cli_rome", "cli_writer"],
    addedBy: "Zhao Min",
    joinedAt: day(12, 15, 0),
    entries: [
      ev(day(12, 15, 0), "Zhao Min added Rome and Writer to the group"),
      say(day(13, 10, 2), "Zhao Min", "Launch is Thursday. Who is drafting the announcement?"),
      say(
        day(13, 10, 4),
        "Ouou",
        "@Writer draft it, under 80 words. @Rome put Thursday 10:00 on my calendar.",
      ),
      botSay(day(13, 10, 5), "cli_rome", "Added “Launch” to your calendar for Thursday at 10:00."),
      botSay(
        day(13, 10, 7),
        "cli_writer",
        "Draft: “Rome agents now join your Feishu groups. Give an agent its own account, invite it like a teammate, and @mention it when you need it.”",
      ),
    ],
  },
  {
    id: "oc_marketing",
    kind: "group",
    name: "Marketing weekly",
    members: 14,
    botIds: ["cli_writer"],
    addedBy: "Chen Yu",
    joinedAt: day(10, 11, 0),
    entries: [
      ev(day(10, 11, 0), "Chen Yu added Writer to the group"),
      say(day(12, 16, 20), "Chen Yu", "@Writer can you tighten the launch blurb? It runs long."),
      botSay(
        day(12, 16, 22),
        "cli_writer",
        "Here is a 40-word version. I kept the Lark line and dropped the pricing line.",
      ),
    ],
  },
  {
    id: "oc_dm_lin",
    kind: "dm",
    name: "Lin Wei",
    members: 2,
    botIds: ["cli_writer"],
    addedBy: "Lin Wei",
    joinedAt: day(9, 9, 15),
    entries: [
      say(day(13, 8, 51), "Lin Wei", "Did the changelog go out?"),
      botSay(day(13, 8, 55), "cli_writer", "Yes. I sent it to Release crew at 08:54."),
    ],
  },
  {
    id: "oc_dm_ouou",
    kind: "dm",
    name: "Ouou",
    members: 2,
    botIds: ["cli_rome"],
    addedBy: "Ouou",
    joinedAt: day(2, 10, 0),
    entries: [
      say(day(13, 9, 58), "Ouou", "Move my 11:00 to 11:30."),
      botSay(day(13, 10, 3), "cli_rome", "Done. Your 11:00 is now at 11:30."),
    ],
  },
  {
    id: "tg_press",
    kind: "group",
    name: "Press list",
    members: 5,
    botIds: ["tg_writer"],
    addedBy: "Sam Lee",
    joinedAt: day(11, 14, 10),
    entries: [
      ev(day(11, 14, 10), "Sam Lee added WriterRomeBot to the group"),
      say(
        day(13, 11, 5),
        "Sam Lee",
        "@WriterRomeBot an English version of the launch note, please.",
      ),
      botSay(
        day(13, 11, 7),
        "tg_writer",
        "Here it is: “Rome agents now join your team's chats, each under its own name.”",
      ),
    ],
  },
  {
    id: "tg_dm_sam",
    kind: "dm",
    name: "Sam Lee",
    members: 2,
    botIds: ["tg_ouou"],
    addedBy: "Sam Lee",
    joinedAt: day(12, 9, 5),
    entries: [
      say(day(13, 12, 30), "Sam Lee", "Are you free Thursday afternoon for the press call?"),
      botSay(
        day(13, 12, 31),
        "tg_ouou",
        "Thursday 14:00 works. The launch runs until 11:00, so anything after lunch is fine.",
      ),
    ],
  },
];

const registrations = new Map<string, BotRegistration & { startedAt: number }>();

const SCAN_AFTER_MS = 4000;

function agentNamed(name: string) {
  return agents.find((a) => a.name === name);
}

function botsOf(agent: string) {
  return bots.filter((b): b is StoredBot & { answersAs: string } => b.answersAs === agent);
}

function linked(b: StoredBot | undefined): b is StoredBot & { answersAs: string } {
  return b !== undefined && b.answersAs !== null;
}

function chatsOf(agent: string) {
  const ids = new Set(botsOf(agent).map((b) => b.id));
  return chats.filter((c) => c.botIds.some((id) => ids.has(id)));
}

function toBot(b: StoredBot & { answersAs: string }): OutreachBot {
  const its = chats.filter((c) => c.botIds.includes(b.id));
  return {
    id: b.id,
    platform: b.platform,
    name: b.name,
    answersAs: b.answersAs,
    kind: b.kind,
    connectedAt: b.connectedAt,
    groups: its.filter((c) => c.kind === "group").length,
    dms: its.filter((c) => c.kind === "dm").length,
  };
}

function toChat(c: StoredChat): OutreachChat {
  const last = [...c.entries].reverse().find((e) => e.kind === "message");
  return {
    id: c.id,
    platform: bots.find((b) => b.id === c.botIds[0])?.platform ?? "feishu",
    kind: c.kind,
    name: c.name,
    members: c.members,
    bots: c.botIds
      .map((id) => bots.find((b) => b.id === id))
      .filter(linked)
      .map((b) => ({ id: b.id, name: b.name, answersAs: b.answersAs, kind: b.kind })),
    addedBy: c.addedBy,
    joinedAt: c.joinedAt,
    lastMessageAt: last?.at ?? null,
    preview: last?.kind === "message" ? `${last.sender}: ${last.text}` : null,
  };
}

function summary(a: OutreachAgent): OutreachAgentSummary {
  return { ...a, bots: botsOf(a.name).map(toBot), chats: chatsOf(a.name).length };
}

function byRecent(a: OutreachChat, b: OutreachChat) {
  return (b.lastMessageAt ?? b.joinedAt).localeCompare(a.lastMessageAt ?? a.joinedAt);
}

/** A stand-in QR code: a deterministic grid of cells, drawn as an SVG data URL. */
function fakeQr(seed: string): string {
  let h = 7;
  for (const ch of seed) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  const n = 25;
  let cells = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      if (!finder && (h >>> 16) & 1) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 29 29" shape-rendering="crispEdges"><rect x="-2" y="-2" width="29" height="29" fill="#fff"/><g fill="#111">${cells}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</g></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The scan happens on a phone, so mock mode completes it on a timer. */
function settle(reg: BotRegistration & { startedAt: number }) {
  if (reg.status !== "waiting" || Date.now() - reg.startedAt < SCAN_AFTER_MS) return;
  const id = `${reg.platform}_${reg.agent.replace(/[^a-z0-9]/gi, "")}${bots.length}`;
  bots = [
    ...bots,
    {
      id,
      platform: reg.platform,
      name: reg.botName,
      answersAs: reg.agent,
      kind: reg.kind,
      connectedAt: new Date().toISOString(),
    },
  ];
  reg.status = "connected";
  reg.botId = id;
}

export const outreachHandlers = [
  http.get("/api/outreach/agents", () =>
    HttpResponse.json({
      agents: agents.filter((a) => botsOf(a.name).length > 0).map(summary),
      unlinked: bots
        .filter((b) => b.answersAs === null)
        .map((b) => ({
          id: b.id,
          platform: b.platform,
          name: b.name,
          kind: b.kind,
          connectedAt: b.connectedAt,
        })),
    }),
  ),

  // Picking the agent is the first step of connecting an account, and an agent
  // may speak through any number of accounts, so every agent is a candidate.
  http.get("/api/outreach/candidates", () => HttpResponse.json({ agents })),

  http.get("/api/outreach/agents/:name", ({ params }) => {
    const a = agentNamed(String(params.name));
    if (!a) return HttpResponse.json({ detail: "No such agent" }, { status: 404 });
    return HttpResponse.json(summary(a));
  }),

  http.patch("/api/outreach/agents/:name", async ({ params, request }) => {
    const a = agentNamed(String(params.name));
    if (!a) return HttpResponse.json({ detail: "No such agent" }, { status: 404 });
    const patch = (await request.json()) as Partial<OutreachAgent>;
    if (typeof patch.canReadOtherChats === "boolean") a.canReadOtherChats = patch.canReadOtherChats;
    if (typeof patch.introduceOnJoin === "boolean") a.introduceOnJoin = patch.introduceOnJoin;
    return HttpResponse.json(a);
  }),

  http.get("/api/outreach/agents/:name/chats", ({ params }) =>
    HttpResponse.json({ chats: chatsOf(String(params.name)).map(toChat).sort(byRecent) }),
  ),

  http.get("/api/outreach/agents/:name/activity", ({ params }) => {
    const name = String(params.name);
    const mine = new Set(botsOf(name).map((b) => b.name.toLowerCase()));
    const items: ActivityItem[] = [];
    for (const c of chatsOf(name)) {
      for (const e of c.entries) {
        if (e.kind !== "message") continue;
        const byAgent = e.bot?.agent === name;
        const toAgent =
          !e.bot &&
          (c.kind === "dm" ? true : [...mine].some((n) => e.text.toLowerCase().includes(`@${n}`)));
        if (byAgent || toAgent) items.push({ chatId: c.id, chatName: c.name, entry: e });
      }
    }
    items.sort((x, y) => y.entry.at.localeCompare(x.entry.at));
    return HttpResponse.json({ items });
  }),

  http.get("/api/outreach/chats/:id", ({ params }) => {
    const c = chats.find((x) => x.id === params.id);
    if (!c) return HttpResponse.json({ detail: "No such chat" }, { status: 404 });
    return HttpResponse.json({ chat: toChat(c), entries: c.entries });
  }),

  http.patch("/api/outreach/bots/:id", async ({ params, request }) => {
    const b = bots.find((x) => x.id === params.id);
    if (!b) return HttpResponse.json({ detail: "No such account" }, { status: 404 });
    const { answersAs } = (await request.json()) as { answersAs?: string | null };
    if (answersAs === undefined || (answersAs !== null && !agentNamed(answersAs))) {
      return HttpResponse.json({ detail: "No such agent" }, { status: 400 });
    }
    const from = b.answersAs;
    const at = new Date().toISOString();
    b.answersAs = answersAs;
    const text =
      answersAs === null
        ? `${from} unlinked from ${b.name}`
        : from === null
          ? `${answersAs} linked to ${b.name}`
          : `${b.name} switched from ${from} to ${answersAs}`;
    for (const c of chats) {
      if (c.botIds.includes(b.id)) c.entries = [...c.entries, ev(at, text)];
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete("/api/outreach/bots/:id", ({ params }) => {
    bots = bots.filter((b) => b.id !== params.id);
    for (const c of chats) c.botIds = c.botIds.filter((id) => id !== params.id);
    chats = chats.filter((c) => c.botIds.length > 0);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/outreach/registrations", async ({ request }) => {
    const body = (await request.json()) as {
      agent: string;
      botName: string;
      platform: ChatPlatform;
      kind: LinkKind;
      token?: string;
    };
    if (!agentNamed(body.agent)) {
      return HttpResponse.json({ detail: "No such agent" }, { status: 400 });
    }
    const byToken = body.token !== undefined;
    if (byToken && !body.token?.trim()) {
      return HttpResponse.json({ detail: "Paste the bot token first" }, { status: 400 });
    }
    const id = `reg_${registrations.size + 1}`;
    const reg = {
      id,
      agent: body.agent,
      botName: body.botName.trim() || body.agent,
      platform: body.platform,
      kind: body.kind,
      status: "waiting" as const,
      qr: byToken ? null : fakeQr(id + body.agent),
      // A pasted token needs no phone, so it settles on the next read.
      startedAt: byToken ? 0 : Date.now(),
    };
    registrations.set(id, reg);
    return HttpResponse.json(reg);
  }),

  http.get("/api/outreach/registrations/:id", ({ params }) => {
    const reg = registrations.get(String(params.id));
    if (!reg) return HttpResponse.json({ detail: "No such registration" }, { status: 404 });
    settle(reg);
    return HttpResponse.json(reg);
  }),
];
