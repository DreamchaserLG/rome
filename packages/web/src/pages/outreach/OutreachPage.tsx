import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Folder, MessagesSquare, Search, Users } from "lucide-react";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageNav,
  PageNavLink,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { ListGrid } from "@rome-os/ui/layout-list";
import { Timestamp } from "@rome-os/ui/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow, ListRowContent } from "@/components/ui/list-row";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FeishuIcon } from "@/components/brand-icons/connection-badges";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Avatar } from "../people/avatar";
import {
  type ChatEntry,
  type OutreachAgentSummary,
  type OutreachBot,
  type OutreachChat,
  outreachKeys,
  useAgentActivity,
  useAgentChats,
  useChat,
  useMoveBot,
  useOutreachAgent,
  useOutreachAgents,
  useOutreachCandidates,
  useRegistration,
  useRemoveBot,
  useStartRegistration,
  useUpdateAgentSettings,
} from "./outreach-api";

/**
 * Outreach: the agents that people can reach from a chat app.
 *
 * Rome may have many agents; only the ones a bot answers as are listed here.
 * Each such agent has an Overview (its bots and what it can use), its Chats
 * (every group and DM one of its bots is in), Activity across those chats, and
 * Settings. A chat is stored once, so a group that holds two of the guardian's
 * bots shows the same history on both agents.
 */
export default function OutreachPage() {
  return (
    <Routes>
      <Route index element={<OutreachIndex />} />
      <Route path="add" element={<AddAgent />} />
      <Route path=":agent/feishu/new" element={<NewFeishuBot />} />
      <Route path=":agent/*" element={<AgentPage />} />
    </Routes>
  );
}

const agentPath = (name: string, rest = "") => `/outreach/${encodeURIComponent(name)}${rest}`;

function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" align="start" className="self-start">
      <Link to={to}>
        <ArrowLeft data-icon="inline-start" />
        {children}
      </Link>
    </Button>
  );
}

function Loading() {
  const { t } = useTranslation("outreach");
  return <p className="py-12 text-center text-ui text-muted-foreground">{t("loading")}</p>;
}

function LoadError({ message }: { message: string }) {
  return <p className="text-ui text-destructive">{message}</p>;
}

function BotPills({ bots }: { bots: OutreachBot[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {bots.map((b) => (
        <Badge key={b.id} variant="outline">
          <FeishuIcon aria-hidden="true" />
          {b.name}
        </Badge>
      ))}
    </span>
  );
}

// ─── Outreach list ───────────────────────────────────────────────────────────

function OutreachIndex() {
  const { t } = useTranslation("outreach");
  const query = useOutreachAgents();
  const agents = query.data?.agents ?? [];

  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("index.title")}</PageTitle>
          <PageDescription>{t("index.description")}</PageDescription>
        </PageHeading>
        <PageActions>
          <Button asChild>
            <Link to="/outreach/add">{t("index.add")}</Link>
          </Button>
        </PageActions>
      </PageHeader>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <LoadError message={query.error.message} />
      ) : agents.length === 0 ? (
        <EmptyState>
          <EmptyStateTitle>{t("index.emptyTitle")}</EmptyStateTitle>
          <EmptyStateDescription>{t("index.emptyBody")}</EmptyStateDescription>
          <EmptyStateAction>
            <Button asChild>
              <Link to="/outreach/add">{t("index.add")}</Link>
            </Button>
          </EmptyStateAction>
        </EmptyState>
      ) : (
        <ListGrid>
          {agents.map((a) => (
            <AgentCard key={a.name} agent={a} />
          ))}
        </ListGrid>
      )}
    </Page>
  );
}

function AgentCard({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  return (
    <Link
      to={agentPath(agent.name)}
      className="rounded-12 outline-none outline-1 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      <Card className="h-full transition-colors hover:bg-surface-hover">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Avatar name={agent.name} />
            <div className="min-w-0">
              <CardTitle>{agent.name}</CardTitle>
              <CardDescription>{t("chatCount", { count: agent.chats })}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-ui text-muted-foreground">{agent.description}</p>
          <BotPills bots={agent.bots} />
        </CardContent>
      </Card>
    </Link>
  );
}

// ─── Add an agent ────────────────────────────────────────────────────────────

function AddAgent() {
  const { t } = useTranslation("outreach");
  const query = useOutreachCandidates();
  const [term, setTerm] = useState("");
  const all = query.data?.agents ?? [];
  const shown = all.filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(term.trim().toLowerCase()),
  );
  useDocumentTitle([t("add.title"), t("index.title")]);

  return (
    <Page>
      <BackLink to="/outreach">{t("index.title")}</BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("add.title")}</PageTitle>
          <PageDescription>{t("add.description")}</PageDescription>
        </PageHeading>
      </PageHeader>
      <div className="max-w-xl">
        <Input
          aria-label={t("add.search")}
          placeholder={t("add.search")}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          icon={<Search />}
        />
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <LoadError message={query.error.message} />
      ) : (
        <Card className="max-w-3xl py-0">
          <List>
            {shown.map((a) => (
              <ListRow key={a.name} asChild interactive>
                <Link to={agentPath(a.name, "/feishu/new")}>
                  <Avatar name={a.name} size="sm" />
                  <ListRowContent>
                    <div className="font-medium">{a.name}</div>
                    <div className="truncate text-aux text-muted-foreground">{a.description}</div>
                  </ListRowContent>
                  <span className="text-aux text-muted-foreground">{a.model}</span>
                </Link>
              </ListRow>
            ))}
            {shown.length === 0 && (
              <p className="p-4 text-ui text-muted-foreground">{t("add.noMatch")}</p>
            )}
          </List>
        </Card>
      )}
      <p className="text-aux text-muted-foreground">{t("add.footnote", { count: all.length })}</p>
    </Page>
  );
}

// ─── Give an agent a Feishu bot ──────────────────────────────────────────────

function NewFeishuBot() {
  const { t } = useTranslation("outreach");
  const navigate = useNavigate();
  const name = useParams<{ agent: string }>().agent ?? "";
  const agentQuery = useOutreachAgent(name);
  const hasBot = (agentQuery.data?.bots.length ?? 0) > 0;
  const [botName, setBotName] = useState(name.charAt(0).toUpperCase() + name.slice(1));
  const [region, setRegion] = useState<"feishu" | "lark">("feishu");
  const queryClient = useQueryClient();
  const start = useStartRegistration();
  const reg = useRegistration(start.data?.id ?? null);
  const status = reg.data?.status ?? start.data?.status;
  useDocumentTitle([t("newBot.title", { agent: name }), t("index.title")]);

  // The scan creates a bot, which moves this agent into Outreach and changes
  // its counts, so every Outreach read is stale once it lands.
  useEffect(() => {
    if (status !== "connected") return;
    void queryClient
      .invalidateQueries({ queryKey: outreachKeys.all })
      .then(() => navigate(agentPath(name), { replace: true }));
  }, [status, name, navigate, queryClient]);

  return (
    <Page>
      <BackLink to={hasBot ? agentPath(name) : "/outreach/add"}>
        {hasBot ? name : t("add.title")}
      </BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("newBot.title", { agent: name })}</PageTitle>
          <PageDescription>{t("newBot.description", { agent: name })}</PageDescription>
        </PageHeading>
      </PageHeader>
      <div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate({ agent: name, botName, region });
          }}
        >
          <Field>
            <FieldLabel htmlFor="bot-name">{t("newBot.name")}</FieldLabel>
            <Input id="bot-name" value={botName} onChange={(e) => setBotName(e.target.value)} />
            <FieldDescription>{t("newBot.nameHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="bot-region">{t("newBot.region")}</FieldLabel>
            <Select value={region} onValueChange={(v) => setRegion(v as "feishu" | "lark")}>
              <SelectTrigger id="bot-region" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">{t("newBot.regionFeishu")}</SelectItem>
                <SelectItem value="lark">{t("newBot.regionLark")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div>
            <Button type="submit" disabled={start.isPending || status === "waiting"}>
              {t("newBot.showQr")}
            </Button>
          </div>
          {start.error && <LoadError message={start.error.message} />}
        </form>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            {start.data ? (
              <>
                <img
                  src={start.data.qr}
                  alt={t("newBot.qrAlt")}
                  className="size-44 rounded-8 border border-border bg-white p-2"
                />
                <p className="text-ui font-medium">{t("newBot.scanTitle")}</p>
                <p className="text-aux text-muted-foreground">
                  {t("newBot.scanBody", { bot: start.data.botName })}
                </p>
                <p className="text-aux text-muted-foreground" role="status">
                  {t("newBot.waiting")}
                </p>
              </>
            ) : (
              <p className="py-16 text-ui text-muted-foreground">{t("newBot.qrPlaceholder")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

// ─── One agent ───────────────────────────────────────────────────────────────

type Tab = "overview" | "chats" | "activity" | "settings";

function AgentPage() {
  const { t } = useTranslation("outreach");
  const name = useParams<{ agent: string }>().agent ?? "";
  const location = useLocation();
  const query = useOutreachAgent(name);
  const agent = query.data;
  const rest = location.pathname.slice(agentPath(name).length).split("/").filter(Boolean);
  const tab: Tab =
    (["chats", "activity", "settings"] as const).find((x) => x === rest[0]) ?? "overview";
  useDocumentTitle(agent ? [t(`tabs.${tab}`), agent.name, t("index.title")] : null);

  if (query.isPending) return <Loading />;
  if (query.error || !agent) {
    return (
      <Page>
        <BackLink to="/outreach">{t("index.title")}</BackLink>
        <LoadError message={query.error?.message ?? t("agent.missing")} />
      </Page>
    );
  }

  const tabs: { id: Tab; to: string; count?: number }[] = [
    { id: "overview", to: agentPath(name) },
    { id: "chats", to: agentPath(name, "/chats"), count: agent.chats },
    { id: "activity", to: agentPath(name, "/activity") },
    { id: "settings", to: agentPath(name, "/settings") },
  ];

  return (
    <Page>
      <BackLink to="/outreach">{t("index.title")}</BackLink>
      <PageHeader>
        <PageHeading>
          <div className="flex items-center gap-3">
            <Avatar name={agent.name} size="lg" />
            <div className="min-w-0">
              <PageTitle>{agent.name}</PageTitle>
              <PageDescription>{agent.description}</PageDescription>
            </div>
          </div>
        </PageHeading>
        <PageActions>
          <BotPills bots={agent.bots} />
        </PageActions>
      </PageHeader>
      <PageNav aria-label={agent.name}>
        {tabs.map((x) => (
          <PageNavLink asChild key={x.id} active={x.id === tab}>
            <Link to={x.to}>
              {t(`tabs.${x.id}`)}
              {x.count !== undefined && (
                <span className="ml-1 text-muted-foreground">{x.count}</span>
              )}
            </Link>
          </PageNavLink>
        ))}
      </PageNav>
      <Routes>
        <Route index element={<Overview agent={agent} />} />
        <Route path="chats" element={<Chats agent={agent} />} />
        <Route path="chats/:chatId" element={<ChatView agent={agent} />} />
        <Route path="activity" element={<Activity agent={agent} />} />
        <Route path="settings" element={<Settings agent={agent} />} />
        <Route path="*" element={<Navigate to={agentPath(name)} replace />} />
      </Routes>
    </Page>
  );
}

function Overview({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("overview.bots")}</CardTitle>
          <CardDescription>
            {agent.bots.length
              ? t("overview.botsBody", { agent: agent.name })
              : t("overview.noBots", { agent: agent.name })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {agent.bots.length > 0 && (
            <List>
              {agent.bots.map((b) => (
                <ListRow key={b.id}>
                  <FeishuIcon className="size-6" aria-hidden="true" />
                  <ListRowContent>
                    <div className="font-medium">{b.name}</div>
                    <div className="text-aux text-muted-foreground">
                      {t("overview.botStats", { groups: b.groups, dms: b.dms })}
                      {" · "}
                      {t("overview.since")} <Timestamp value={b.connectedAt} format="date" />
                    </div>
                  </ListRowContent>
                  <Badge variant="success">{t("overview.connected")}</Badge>
                </ListRow>
              ))}
            </List>
          )}
          {agent.bots.length > 0 && agent.chats === 0 && (
            <p className="rounded-8 bg-surface-muted p-3 text-ui">
              <span className="font-medium">
                {t("overview.inviteTitle", { bot: agent.bots[0]!.name })}
              </span>{" "}
              {t("overview.inviteBody", { bot: agent.bots[0]!.name })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {agent.chats > 0 && (
              <Button asChild variant="outline" size="sm">
                <Link to={agentPath(agent.name, "/chats")}>{t("overview.seeChats")}</Link>
              </Button>
            )}
            <Button asChild variant={agent.bots.length ? "ghost" : "default"} size="sm">
              <Link to={agentPath(agent.name, "/feishu/new")}>
                {agent.bots.length ? t("overview.addBot") : t("overview.addToFeishu")}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("overview.uses")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-ui">
            <dt className="text-muted-foreground">{t("overview.model")}</dt>
            <dd>{agent.model}</dd>
            <dt className="text-muted-foreground">{t("overview.tools")}</dt>
            <dd className="flex flex-wrap gap-1">
              {agent.tools.map((x) => (
                <Badge key={x} variant="muted" shape="square">
                  {x}
                </Badge>
              ))}
            </dd>
            <dt className="text-muted-foreground">{t("overview.folders")}</dt>
            <dd className="flex flex-col gap-1">
              {agent.folders.length === 0
                ? t("overview.wholeWorkspace")
                : agent.folders.map((f) => (
                    <span key={f.path} className="flex items-center gap-2">
                      <Folder className="size-4 text-muted-foreground" aria-hidden="true" />
                      <code className="text-code">{f.path}</code>
                      <span className="text-aux text-muted-foreground">
                        {t(`access.${f.access}`)}
                      </span>
                    </span>
                  ))}
            </dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function otherBots(chat: OutreachChat, agent: string) {
  return chat.bots.filter((b) => b.answersAs !== agent);
}

function Chats({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const query = useAgentChats(agent.name);
  const chats = query.data?.chats ?? [];
  if (query.isPending) return <Loading />;
  if (query.error) return <LoadError message={query.error.message} />;
  if (chats.length === 0) {
    return (
      <EmptyState>
        <EmptyStateTitle>{t("chats.emptyTitle")}</EmptyStateTitle>
        <EmptyStateDescription>
          {agent.bots[0]
            ? t("overview.inviteBody", { bot: agent.bots[0].name })
            : t("overview.noBots", { agent: agent.name })}
        </EmptyStateDescription>
      </EmptyState>
    );
  }
  const groups = chats.filter((c) => c.kind === "group");
  const dms = chats.filter((c) => c.kind === "dm");
  return (
    <div className="flex flex-col gap-6">
      {[
        { label: t("chats.groups"), rows: groups },
        { label: t("chats.dms"), rows: dms },
      ]
        .filter((s) => s.rows.length > 0)
        .map((s) => (
          <Section key={s.label}>
            <SectionHeader>
              <SectionHeading>
                <SectionTitle>
                  {s.label} <span className="text-muted-foreground">{s.rows.length}</span>
                </SectionTitle>
              </SectionHeading>
            </SectionHeader>
            <Card className="py-0">
              <List>
                {s.rows.map((c) => (
                  <ChatRow key={c.id} chat={c} agent={agent.name} />
                ))}
              </List>
            </Card>
          </Section>
        ))}
    </div>
  );
}

function ChatRow({ chat, agent }: { chat: OutreachChat; agent: string }) {
  const { t } = useTranslation("outreach");
  const others = otherBots(chat, agent);
  return (
    <ListRow asChild interactive>
      <Link to={agentPath(agent, `/chats/${encodeURIComponent(chat.id)}`)}>
        {chat.kind === "group" ? (
          <span className="flex size-8 items-center justify-center rounded-8 bg-surface-muted text-muted-foreground">
            <Users className="size-4" aria-hidden="true" />
          </span>
        ) : (
          <Avatar name={chat.name} size="sm" />
        )}
        <ListRowContent>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{chat.name}</span>
            {chat.kind === "group" && (
              <Badge variant="muted">{t("chats.members", { count: chat.members })}</Badge>
            )}
            {others.map((b) => (
              <Badge key={b.id} variant="info">
                {t("chats.alsoHere", { bot: b.name })}
              </Badge>
            ))}
          </div>
          {chat.preview && (
            <div className="truncate text-aux text-muted-foreground">{chat.preview}</div>
          )}
        </ListRowContent>
        <div className="shrink-0 text-right text-aux text-muted-foreground">
          <Timestamp value={chat.lastMessageAt ?? chat.joinedAt} />
          <div>{t("chats.addedBy", { name: chat.addedBy })}</div>
        </div>
      </Link>
    </ListRow>
  );
}

function ChatView({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const chatId = useParams<{ chatId: string }>().chatId ?? "";
  const query = useChat(chatId);
  if (query.isPending) return <Loading />;
  if (query.error) return <LoadError message={query.error.message} />;
  const { chat, entries } = query.data;
  const others = otherBots(chat, agent.name);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-title font-semibold">{chat.name}</h2>
          <p className="text-aux text-muted-foreground">
            {chat.kind === "group"
              ? t("chat.groupMeta", { count: chat.members, name: chat.addedBy })
              : t("chat.dmMeta", { name: chat.addedBy })}
            {" · "}
            {t("chat.botsHere", { bots: chat.bots.map((b) => b.name).join(", ") })}
          </p>
        </div>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {entries.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </CardContent>
      </Card>
      {others.length > 0 && (
        <p className="text-aux text-muted-foreground">
          {t("chat.shared", {
            bots: others.map((b) => `${b.name} (${b.answersAs})`).join(", "),
            count: others.length,
          })}
        </p>
      )}
      <p className="text-aux text-muted-foreground">{t("chat.settings")}</p>
    </div>
  );
}

function Entry({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "event") {
    return (
      <p className="text-center text-aux text-muted-foreground">
        <Timestamp value={entry.at} format="datetime" /> · {entry.text}
      </p>
    );
  }
  return (
    <div className="flex gap-3">
      <Avatar name={entry.sender} size="sm" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-aux text-muted-foreground">
          <span className="text-ui font-medium text-foreground">{entry.sender}</span>
          {entry.bot && <Badge variant="brand">{entry.bot.agent}</Badge>}
          <Timestamp value={entry.at} format="time" />
        </div>
        <p className="text-ui whitespace-pre-wrap">{entry.text}</p>
      </div>
    </div>
  );
}

function Activity({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const query = useAgentActivity(agent.name);
  const [view, setView] = useState<"chat" | "time">("chat");
  const items = query.data?.items ?? [];
  const byChat = useMemo(() => {
    const map = new Map<
      string,
      { name: string; asked: number; said: number; last?: string; at: string }
    >();
    for (const it of items) {
      const row = map.get(it.chatId) ?? { name: it.chatName, asked: 0, said: 0, at: it.entry.at };
      if (it.entry.bot) {
        row.said += 1;
        row.last ??= it.entry.text;
      } else {
        row.asked += 1;
      }
      map.set(it.chatId, row);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui text-muted-foreground">
          {t("activity.description", { agent: agent.name })}
        </p>
        <SegmentedControl
          aria-label={t("activity.view")}
          size="sm"
          value={view}
          onValueChange={setView}
          options={[
            { value: "chat", label: t("activity.byChat") },
            { value: "time", label: t("activity.timeline") },
          ]}
        />
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <LoadError message={query.error.message} />
      ) : items.length === 0 ? (
        <EmptyState>
          <EmptyStateTitle>{t("activity.emptyTitle")}</EmptyStateTitle>
        </EmptyState>
      ) : view === "chat" ? (
        <ListGrid>
          {byChat.map(([id, row]) => (
            <Card key={id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessagesSquare className="size-4 text-muted-foreground" aria-hidden="true" />
                  {row.name}
                </CardTitle>
                <CardDescription>
                  <Timestamp value={row.at} />
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-ui">
                <p>
                  {t("activity.counts", { asked: row.asked, said: row.said, agent: agent.name })}
                </p>
                {row.last && (
                  <p className="text-muted-foreground">
                    {t("activity.lastSaid")} {row.last}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </ListGrid>
      ) : (
        <Card className="py-0">
          <List>
            {items.map((it) => (
              <ListRow key={it.entry.id} className="items-start py-3">
                <span className="w-24 shrink-0 text-aux text-muted-foreground">
                  <Timestamp value={it.entry.at} />
                </span>
                <ListRowContent>
                  <div>
                    <span className="font-medium">{it.entry.sender}</span> {it.entry.text}
                  </div>
                  <div className="text-aux text-muted-foreground">
                    {t("activity.inChat", { chat: it.chatName })}
                  </div>
                </ListRowContent>
              </ListRow>
            ))}
          </List>
        </Card>
      )}
    </div>
  );
}

function Settings({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const navigate = useNavigate();
  const update = useUpdateAgentSettings(agent.name);
  const move = useMoveBot();
  const remove = useRemoveBot();
  const candidates = useOutreachCandidates();
  const all = useOutreachAgents();
  const [pending, setPending] = useState<{ botId: string; to: string } | null>(null);
  const names = [
    ...new Set([
      ...(all.data?.agents ?? []).map((a) => a.name),
      ...(candidates.data?.agents ?? []).map((a) => a.name),
      agent.name,
    ]),
  ].sort();

  const toggle = (
    label: string,
    body: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) => (
    <div className="flex items-start justify-between gap-6 py-3">
      <div>
        <div className="text-ui font-medium">{label}</div>
        <div className="text-aux text-muted-foreground">{body}</div>
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.chats")}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border-subtle">
          {toggle(
            t("settings.readOthers"),
            t("settings.readOthersBody", { agent: agent.name }),
            agent.canReadOtherChats,
            (v) => update.mutate({ canReadOtherChats: v }),
          )}
          {toggle(
            t("settings.introduce"),
            t("settings.introduceBody"),
            agent.introduceOnJoin,
            (v) => update.mutate({ introduceOnJoin: v }),
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.bots")}</CardTitle>
          <CardDescription>{t("settings.botsBody")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border-subtle">
          {agent.bots.map((b) => {
            const moving = pending?.botId === b.id ? pending : null;
            const count = b.groups + b.dms;
            return (
              <div key={b.id} className="flex flex-col gap-3 py-3">
                <div className="flex items-center gap-3">
                  <FeishuIcon className="size-5" aria-hidden="true" />
                  <span className="flex-1 font-medium">{b.name}</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(b.id, {
                        onSuccess: () => {
                          if (agent.bots.length <= 1) navigate("/outreach");
                        },
                      })
                    }
                  >
                    {t("settings.removeBot")}
                  </Button>
                </div>
                <Field className="max-w-xs">
                  <FieldLabel htmlFor={`answers-${b.id}`}>{t("settings.answersAs")}</FieldLabel>
                  <Select
                    value={moving?.to ?? b.answersAs}
                    onValueChange={(to) =>
                      setPending(to === b.answersAs ? null : { botId: b.id, to })
                    }
                  >
                    <SelectTrigger id={`answers-${b.id}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {names.map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {moving && (
                  <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
                    <p>{t("settings.moveConfirm", { bot: b.name, to: moving.to, count })}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={move.isPending}
                        onClick={() =>
                          move.mutate(
                            { botId: b.id, answersAs: moving.to },
                            {
                              onSuccess: () => {
                                setPending(null);
                                navigate(agentPath(moving.to, "/settings"));
                              },
                            },
                          )
                        }
                      >
                        {t("settings.move")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                        {t("settings.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("overview.folders")}</CardTitle>
          <CardDescription>
            {agent.folders.length ? t("settings.foldersBody") : t("settings.noFolders")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-ui">
          {agent.folders.map((f) => (
            <div key={f.path} className="flex items-center gap-2">
              <code className="flex-1 text-code">{f.path}</code>
              <span className="text-aux text-muted-foreground">{t(`access.${f.access}`)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
