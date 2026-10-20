import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, Search } from "lucide-react";
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
  SectionActions,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DiscordIcon,
  FeishuIcon,
  TelegramIcon,
  WeChatIcon,
} from "@/components/brand-icons/connection-badges";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Avatar } from "../people/avatar";
import {
  CHAT_PLATFORMS,
  type ChatPlatform,
  DELEGATE_PLATFORMS,
  type LinkKind,
  PLATFORM_SETUP,
  type OutreachAgentSummary,
  type OutreachBot,
  type UnlinkedAccount,
  outreachKeys,
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
 * Envoys: the agents that people can reach on chat platforms.
 *
 * Rome may have many agents; only the ones speaking through a connected account
 * are listed here. A connected account has at most one agent, usually chosen
 * when the account is connected: the agent's own account, or the guardian's
 * account with the agent as delegate. Accounts connected with no agent are
 * listed apart, and Rome does not listen to them until an agent is linked.
 * Each listed agent has an Overview of its accounts and Settings.
 */
export default function OutreachPage() {
  return (
    <Routes>
      <Route index element={<OutreachIndex />} />
      <Route path="add" element={<AddAgent />} />
      <Route path=":agent/new" element={<ChoosePlatform />} />
      <Route path=":agent/:platform/new" element={<NewBot />} />
      <Route path=":agent/*" element={<AgentPage />} />
    </Routes>
  );
}

const agentPath = (name: string, rest = "") => `/outreach/${encodeURIComponent(name)}${rest}`;

const PLATFORM_ICONS: Record<ChatPlatform, typeof FeishuIcon> = {
  feishu: FeishuIcon,
  lark: FeishuIcon,
  telegram: TelegramIcon,
  discord: DiscordIcon,
  wechat: WeChatIcon,
};

function PlatformIcon({ platform, className }: { platform: ChatPlatform; className?: string }) {
  const Icon = PLATFORM_ICONS[platform];
  return <Icon className={className} aria-hidden="true" />;
}

function isPlatform(value: string | undefined): value is ChatPlatform {
  return CHAT_PLATFORMS.includes(value as ChatPlatform);
}

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

/** A sentence from the outreach namespace whose `<agent>` tag sets the agent's
 *  name in monospace, so a name such as main does not read as a plain word. */
function AgentText({ k, values }: { k: string; values: Record<string, unknown> }) {
  const { t } = useTranslation("outreach");
  return (
    <Trans
      t={t}
      i18nKey={k}
      values={values}
      components={{ agent: <span className="font-mono text-[0.95em]" /> }}
    />
  );
}

/** The same sentence as plain text, for the document title. */
function plainAgentText(text: string) {
  return text.replace(/<\/?agent>/g, "");
}

function BotPills({ bots }: { bots: OutreachBot[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {bots.map((b) => (
        <Badge key={b.id} variant="outline">
          <PlatformIcon platform={b.platform} />
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
  const unlinked = query.data?.unlinked ?? [];

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
      ) : agents.length === 0 && unlinked.length === 0 ? (
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
        <>
          {agents.length > 0 && (
            <ListGrid>
              {agents.map((a) => (
                <AgentCard key={a.name} agent={a} />
              ))}
            </ListGrid>
          )}
          {unlinked.length > 0 && <UnlinkedAccounts accounts={unlinked} />}
        </>
      )}
    </Page>
  );
}

/** Accounts Rome has access to but no agent speaks through. Linking an agent is
 *  one step and starts Rome listening to the account. */
function UnlinkedAccounts({ accounts }: { accounts: UnlinkedAccount[] }) {
  const { t } = useTranslation("outreach");
  const navigate = useNavigate();
  const candidates = useOutreachCandidates();
  const link = useMoveBot();
  const names = (candidates.data?.agents ?? []).map((a) => a.name).sort();

  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("unlinked.title")}</SectionTitle>
          <SectionDescription>{t("unlinked.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <Card className="max-w-3xl py-0">
        <List>
          {accounts.map((acc) => {
            // A delegate is the guardian's pick, with main suggested first.
            const order =
              acc.kind === "delegate" ? ["main", ...names.filter((n) => n !== "main")] : names;
            return (
              <ListRow key={acc.id}>
                <PlatformIcon platform={acc.platform} className="size-6" />
                <ListRowContent>
                  <div className="font-medium">{acc.name}</div>
                  <div className="truncate text-aux text-muted-foreground">
                    {t(`platforms.${acc.platform}.name`)}
                    {acc.kind === "delegate" && ` · ${t("unlinked.yours")}`}
                  </div>
                </ListRowContent>
                <Select
                  value=""
                  disabled={link.isPending}
                  onValueChange={(agent) =>
                    link.mutate(
                      { botId: acc.id, answersAs: agent },
                      { onSuccess: () => navigate(agentPath(agent, "/settings")) },
                    )
                  }
                >
                  <SelectTrigger
                    className="w-48"
                    aria-label={t("unlinked.link", { bot: acc.name })}
                  >
                    <SelectValue placeholder={t("unlinked.pick")} />
                  </SelectTrigger>
                  <SelectContent>
                    {order.map((n) => (
                      <SelectItem key={n} value={n}>
                        {acc.kind === "delegate" && n === "main"
                          ? t("unlinked.suggested", { agent: n })
                          : n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ListRow>
            );
          })}
        </List>
      </Card>
    </Section>
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
  const shown = all.filter((a) => a.name.toLowerCase().includes(term.trim().toLowerCase()));
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
                <Link to={agentPath(a.name, "/new")}>
                  <Avatar name={a.name} size="sm" />
                  <ListRowContent>
                    <div className="font-medium">{a.name}</div>
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
    </Page>
  );
}

// ─── Give an agent an account on a chat app ─────────────────────────────────

function ChoosePlatform() {
  const { t } = useTranslation("outreach");
  const name = useParams<{ agent: string }>().agent ?? "";
  const agentQuery = useOutreachAgent(name);
  const bots = agentQuery.data?.bots ?? [];
  useDocumentTitle([plainAgentText(t("choose.title", { agent: name })), t("index.title")]);
  return (
    <Page>
      <BackLink to={bots.length ? agentPath(name) : "/outreach/add"}>
        {bots.length ? name : t("add.title")}
      </BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>
            <AgentText k="choose.title" values={{ agent: name }} />
          </PageTitle>
          <PageDescription>{t("choose.description")}</PageDescription>
        </PageHeading>
      </PageHeader>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>
              <AgentText k="choose.ownTitle" values={{ agent: name }} />
            </SectionTitle>
            <SectionDescription>
              <AgentText k="choose.ownBody" values={{ agent: name }} />
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Card className="max-w-3xl py-0">
          <List>
            {CHAT_PLATFORMS.map((p) => (
              <ListRow key={p} asChild interactive>
                <Link to={agentPath(name, `/${p}/new`)}>
                  <PlatformIcon platform={p} className="size-6" />
                  <ListRowContent>
                    <div className="font-medium">{t(`platforms.${p}.name`)}</div>
                  </ListRowContent>
                </Link>
              </ListRow>
            ))}
          </List>
        </Card>
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>{t("choose.delegateTitle")}</SectionTitle>
            <SectionDescription>
              <AgentText k="choose.delegateBody" values={{ agent: name }} />
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <Card className="max-w-3xl py-0">
          <List>
            {DELEGATE_PLATFORMS.map((p) => (
              <ListRow key={p} asChild interactive>
                <Link to={agentPath(name, `/${p}/new?kind=delegate`)}>
                  <PlatformIcon platform={p} className="size-6" />
                  <ListRowContent>
                    <div className="font-medium">
                      {t("choose.yourAccount", { app: t(`platforms.${p}.name`) })}
                    </div>
                  </ListRowContent>
                </Link>
              </ListRow>
            ))}
          </List>
        </Card>
      </Section>
    </Page>
  );
}

function NewBot() {
  const { t } = useTranslation("outreach");
  const navigate = useNavigate();
  const params = useParams<{ agent: string; platform: string }>();
  const name = params.agent ?? "";
  const [search] = useSearchParams();
  const kind: LinkKind = search.get("kind") === "delegate" ? "delegate" : "own";
  const [botName, setBotName] = useState(name.charAt(0).toUpperCase() + name.slice(1));
  const [token, setToken] = useState("");
  const queryClient = useQueryClient();
  const start = useStartRegistration();
  const reg = useRegistration(start.data?.id ?? null);
  const status = reg.data?.status ?? start.data?.status;
  const platform = isPlatform(params.platform) ? params.platform : null;
  const app = platform ? t(`platforms.${platform}.name`) : "";
  const delegate = kind === "delegate";
  const title = delegate
    ? t("newBot.delegateTitle", { app })
    : t("newBot.title", { agent: name, app });
  useDocumentTitle([plainAgentText(title), t("index.title")]);

  // Connecting the account moves this agent into Envoys and changes its
  // counts, so every Envoys read is stale once it lands.
  useEffect(() => {
    if (status !== "connected") return;
    void queryClient
      .invalidateQueries({ queryKey: outreachKeys.all })
      .then(() => navigate(agentPath(name), { replace: true }));
  }, [status, name, navigate, queryClient]);

  if (!platform || (delegate && !DELEGATE_PLATFORMS.includes(platform))) {
    return <Navigate to={agentPath(name, "/new")} replace />;
  }
  // Signing in to the guardian's own account is a QR scan in the app on every
  // platform that allows a delegate.
  const byQr = delegate || PLATFORM_SETUP[platform] === "qr";

  return (
    <Page>
      <BackLink to={agentPath(name, "/new")}>{t("choose.back")}</BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>
            {delegate ? title : <AgentText k="newBot.title" values={{ agent: name, app }} />}
          </PageTitle>
          <PageDescription>
            <AgentText
              k={delegate ? "newBot.delegateDescription" : "newBot.description"}
              values={{ agent: name }}
            />
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate({
              agent: name,
              botName: delegate ? "" : botName,
              platform,
              kind,
              ...(byQr ? {} : { token }),
            });
          }}
        >
          {!delegate && (
            <Field>
              <FieldLabel htmlFor="bot-name">{t("newBot.name", { app })}</FieldLabel>
              <Input id="bot-name" value={botName} onChange={(e) => setBotName(e.target.value)} />
              <FieldDescription>{t("newBot.nameHint")}</FieldDescription>
            </Field>
          )}
          {!byQr && (
            <Field>
              <FieldLabel htmlFor="bot-token">{t("newBot.token")}</FieldLabel>
              <Input
                id="bot-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <FieldDescription>{t(`platforms.${platform}.tokenHint`)}</FieldDescription>
            </Field>
          )}
          <div>
            <Button type="submit" disabled={start.isPending || status === "waiting"}>
              {byQr ? t("newBot.showQr") : t("newBot.connect")}
            </Button>
          </div>
          {start.error && <LoadError message={start.error.message} />}
        </form>
        {byQr && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
              {start.data?.qr ? (
                <>
                  <img
                    src={start.data.qr}
                    alt={t("newBot.qrAlt", { app })}
                    className="size-44 rounded-8 border border-border bg-white p-2"
                  />
                  <p className="text-ui font-medium">{t("newBot.scanTitle", { app })}</p>
                  <p className="text-aux text-muted-foreground">
                    {delegate ? (
                      <AgentText k="newBot.signInBody" values={{ app, agent: name }} />
                    ) : (
                      t("newBot.scanBody", { bot: start.data.botName, app })
                    )}
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
        )}
      </div>
    </Page>
  );
}

// ─── One agent ───────────────────────────────────────────────────────────────

type Tab = "overview" | "settings";

function AgentPage() {
  const { t } = useTranslation("outreach");
  const name = useParams<{ agent: string }>().agent ?? "";
  const location = useLocation();
  const query = useOutreachAgent(name);
  const agent = query.data;
  const rest = location.pathname.slice(agentPath(name).length).split("/").filter(Boolean);
  const tab: Tab = (["settings"] as const).find((x) => x === rest[0]) ?? "overview";
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

  const tabs: { id: Tab; to: string }[] = [
    { id: "overview", to: agentPath(name) },
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
      </PageHeader>
      <PageNav aria-label={agent.name}>
        {tabs.map((x) => (
          <PageNavLink asChild key={x.id} active={x.id === tab}>
            <Link to={x.to}>{t(`tabs.${x.id}`)}</Link>
          </PageNavLink>
        ))}
      </PageNav>
      <Routes>
        <Route index element={<Overview agent={agent} />} />
        <Route path="settings" element={<Settings agent={agent} />} />
        <Route path="*" element={<Navigate to={agentPath(name)} replace />} />
      </Routes>
    </Page>
  );
}

function Overview({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const first = agent.bots[0];
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("overview.bots")}</SectionTitle>
          {!first && (
            <SectionDescription>
              <AgentText k="overview.noBots" values={{ agent: agent.name }} />
            </SectionDescription>
          )}
        </SectionHeading>
        <SectionActions>
          <Button asChild variant={first ? "outline" : "default"} size="sm">
            <Link to={agentPath(agent.name, "/new")}>{t("overview.addBot")}</Link>
          </Button>
        </SectionActions>
      </SectionHeader>
      {first && (
        <ListGrid>
          {agent.bots.map((b) => (
            <AccountCard key={b.id} bot={b} />
          ))}
        </ListGrid>
      )}
      {first && agent.chats === 0 && (
        <p className="max-w-3xl rounded-8 bg-surface-muted p-3 text-ui">
          <span className="font-medium">{t("overview.inviteTitle", { bot: first.name })}</span>{" "}
          {t(`platforms.${first.platform}.invite`, { bot: first.name })}
        </p>
      )}
    </Section>
  );
}

/** One account: who it is on which platform, then how many chats it is in. */
function AccountCard({ bot }: { bot: OutreachBot }) {
  const { t } = useTranslation("outreach");
  return (
    <Card>
      <div className="flex items-center gap-3 px-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-8 bg-surface-muted">
          <PlatformIcon platform={bot.platform} className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate font-medium">{bot.name}</div>
          <div className="truncate text-aux text-muted-foreground">
            {t(`platforms.${bot.platform}.name`)} · {t(`kinds.${bot.kind}`)}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-border-subtle px-4 pt-4">
        <div>
          <dt className="text-aux text-muted-foreground">{t("overview.groups")}</dt>
          <dd className="text-title tabular-nums">{bot.groups}</dd>
        </div>
        <div>
          <dt className="text-aux text-muted-foreground">{t("overview.dms")}</dt>
          <dd className="text-title tabular-nums">{bot.dms}</dd>
        </div>
      </dl>
      <div className="px-4 text-aux text-muted-foreground">
        {t("overview.since")} <Timestamp value={bot.connectedAt} format="date" />
      </div>
    </Card>
  );
}

/** The agent select's value for "no agent"; picking it unlinks the account. */
const NO_AGENT = "__none__";

function Settings({ agent }: { agent: OutreachAgentSummary }) {
  const { t } = useTranslation("outreach");
  const navigate = useNavigate();
  const update = useUpdateAgentSettings(agent.name);
  const move = useMoveBot();
  const remove = useRemoveBot();
  const candidates = useOutreachCandidates();
  const all = useOutreachAgents();
  const [pending, setPending] = useState<{ botId: string; to: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

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
        </CardHeader>
        <CardContent className="divide-y divide-border-subtle">
          {agent.bots.map((b) => {
            const moving = pending?.botId === b.id ? pending : null;
            const count = b.groups + b.dms;
            return (
              <div key={b.id} className="flex flex-col gap-3 py-3">
                <div className="flex items-center gap-3">
                  <PlatformIcon platform={b.platform} className="size-5" />
                  <span className="flex-1 font-medium">{b.name}</span>
                  <Badge variant="muted">{t(`kinds.${b.kind}`)}</Badge>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={disconnecting === b.id}
                    onClick={() => {
                      setPending(null);
                      setDisconnecting(b.id);
                    }}
                  >
                    {t("settings.removeBot")}
                  </Button>
                </div>
                {disconnecting === b.id && (
                  <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
                    <p>{t("settings.disconnectConfirm", { bot: b.name, count })}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={remove.isPending}
                        onClick={() =>
                          remove.mutate(b.id, {
                            onSuccess: () => {
                              setDisconnecting(null);
                              if (agent.bots.length <= 1) navigate("/outreach");
                            },
                          })
                        }
                      >
                        {t("settings.removeBot")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDisconnecting(null)}>
                        {t("settings.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                <Field className="max-w-xs">
                  <FieldLabel htmlFor={`answers-${b.id}`}>{t("settings.answersAs")}</FieldLabel>
                  <Select
                    value={moving?.to ?? b.answersAs}
                    onValueChange={(to) => {
                      setDisconnecting(null);
                      setPending(to === b.answersAs ? null : { botId: b.id, to });
                    }}
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
                      <SelectItem value={NO_AGENT}>{t("settings.noAgent")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {moving && (
                  <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
                    <p>
                      {moving.to === NO_AGENT ? (
                        <AgentText
                          k="settings.unlinkConfirm"
                          values={{ bot: b.name, agent: agent.name }}
                        />
                      ) : (
                        <AgentText
                          k="settings.moveConfirm"
                          values={{ bot: b.name, to: moving.to, count }}
                        />
                      )}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={move.isPending}
                        onClick={() =>
                          move.mutate(
                            { botId: b.id, answersAs: moving.to === NO_AGENT ? null : moving.to },
                            {
                              onSuccess: () => {
                                setPending(null);
                                if (moving.to !== NO_AGENT) {
                                  navigate(agentPath(moving.to, "/settings"));
                                } else if (agent.bots.length <= 1) {
                                  navigate("/outreach");
                                }
                              },
                            },
                          )
                        }
                      >
                        {moving.to === NO_AGENT ? t("settings.unlink") : t("settings.move")}
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
    </div>
  );
}
