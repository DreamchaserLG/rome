/**
 * Test kit for Rome apps: run an app's actions, API handler and hooks in a
 * plain test process, against its real migrations in an in-memory SQLite,
 * with no Rome daemon. Import from `@rome-os/app-runtime/testing`.
 *
 * ```ts
 * const app = await createTestApp({
 *   appId: "sales-agent",
 *   tablePrefix: "sales_agent",
 *   migrationsFolder: new URL("../src/db/migrations", import.meta.url),
 *   channelHistory: [channelMessage({ channel: "feishu", text: "Who owns Acme?" })],
 * });
 * const quote = app.action("quote", createQuoteAction);
 * const result = await app.inChannel(
 *   { channel: "feishu", threadId: "oc_sales", channelUserId: "ou_mei", threadType: "group" },
 *   () => app.runAction("quote", { lines: [{ sku: "PRO", quantity: 3 }] }),
 * );
 * ```
 *
 * The in-memory database needs `better-sqlite3`, which the host bundles but an
 * app installs itself as a dev dependency. Everything else is in this package.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionInvocationError,
  setCurrentActionContextResolver,
  type Action,
  type ActionConfig,
  type ActionInvocation,
  type ActionResult,
  type AppDbContext,
  type AppRuntimeRepositories,
  type AppStartedHook,
  type AppStartedHookDeps,
  type ChannelMessage,
  type ChannelMessageQuery,
  type ChannelsService,
  type ConversationId,
  type CurrentActionContext,
  type DrizzleDb,
  type Logger,
  type MessageReceipt,
  type OutgoingMessage,
  type RomeAppApiHandler,
  type RomeAppCaller,
  type RomeAppContext,
  type ThreadContext,
} from "./index.js";

/** Host table naming, so a test reads the same table names the daemon creates. */
function migrationsTableName(tablePrefix: string): string {
  return `__drizzle_migrations_app_${tablePrefix}`;
}

export interface TestDb {
  db: AppDbContext;
  close(): void;
}

/**
 * The app's tables in a fresh in-memory SQLite, created by running the app's
 * own migration files the way the host does at install.
 */
export async function createTestDb(options: {
  tablePrefix: string;
  /** The folder `drizzle-kit generate` writes, as a path or a `file:` URL. */
  migrationsFolder?: string | URL;
  /** The `better-sqlite3` default export. Found from this package or the
   *  current directory when left out. */
  Database?: SqliteConstructor;
}): Promise<TestDb> {
  const sqlite = await openInMemorySqlite(options.Database);
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const connection = drizzle(sqlite as never) as unknown as DrizzleDb;
  if (options.migrationsFolder) {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(connection as never, {
      migrationsFolder: toPath(options.migrationsFolder),
      migrationsTable: migrationsTableName(options.tablePrefix),
    });
  }
  const { tablePrefix } = options;
  return {
    db: { connection, tablePrefix, tableName: (name) => `${tablePrefix}__${name}` },
    close: () => sqlite.close(),
  };
}

interface SqliteHandle {
  close(): void;
}

export type SqliteConstructor = new (path: string) => SqliteHandle;

async function openInMemorySqlite(Database?: SqliteConstructor): Promise<SqliteHandle> {
  if (Database) return new Database(":memory:");
  // A variable specifier keeps TypeScript from requiring the optional module's
  // types in apps that never call createTestDb.
  const specifier = "better-sqlite3";
  let mod: { default: SqliteConstructor };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    // pnpm keeps an app's dev dependencies out of this package's resolution
    // path, so look again from the directory the tests run in.
    try {
      const require = createRequire(join(process.cwd(), "package.json"));
      return new (require(specifier) as SqliteConstructor)(":memory:");
    } catch (err) {
      throw new Error(
        `createTestDb needs better-sqlite3. Add it to the app's devDependencies (pnpm add -D better-sqlite3) and allow its build in pnpm-workspace.yaml (allowBuilds: { better-sqlite3: true }). Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return new mod.default(":memory:");
}

function toPath(value: string | URL): string {
  return value instanceof URL || value.startsWith("file:") ? fileURLToPath(value) : value;
}

export interface FakeChannels {
  service: ChannelsService;
  /** Every `query` call, oldest first. */
  queries: Array<{ channel: string; query?: ChannelMessageQuery }>;
  /** Every `send` call, oldest first. */
  sent: Array<{ channel: string; conversationId: ConversationId; message: OutgoingMessage }>;
  /** Add messages to the history later queries answer from. */
  push(...messages: ChannelMessage[]): void;
}

/**
 * A {@link ChannelsService} over a fixed history. `query` answers the way a
 * live channel does: newest first, narrowed by conversation and `since`,
 * capped by `limit` (default 100). `send` records the message and appends it
 * to the history as an outbound line.
 */
export function createFakeChannels(history: ChannelMessage[] = []): FakeChannels {
  const messages = [...history];
  const queries: FakeChannels["queries"] = [];
  const sent: FakeChannels["sent"] = [];
  let sequence = 0;

  const service: ChannelsService = {
    async list() {
      const names = new Set(messages.map((m) => m.channel));
      for (const s of sent) names.add(s.channel);
      return [...names].map((name) => ({ name, sendable: true }));
    },
    async send(channel, conversationId, message) {
      sent.push({ channel, conversationId, message });
      const messageId = `sent_${++sequence}`;
      messages.push({
        channel,
        direction: "outbound",
        messageId,
        conversationId,
        senderId: "",
        text: message.text ?? "",
        attachments: [],
        timestamp: new Date(),
      });
      return { messageId, conversationId } satisfies MessageReceipt;
    },
    async query(channel, query) {
      queries.push({ channel, ...(query ? { query } : {}) });
      const limit = Math.min(query?.limit ?? 100, 1000);
      return messages
        .filter((m) => m.channel === channel)
        .filter((m) => !query?.conversationId || m.conversationId === query.conversationId)
        .filter((m) => !query?.since || m.timestamp.getTime() >= query.since.getTime())
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);
    },
  };

  return { service, queries, sent, push: (...more) => messages.push(...more) };
}

let messageSequence = 0;

/** A {@link ChannelMessage} with defaults for everything a test does not name. */
export function channelMessage(
  fields: Partial<ChannelMessage> & { channel: string; text: string },
): ChannelMessage {
  return {
    direction: "inbound",
    messageId: `msg_${++messageSequence}`,
    conversationId: "conversation" as ConversationId,
    senderId: "sender",
    attachments: [],
    timestamp: new Date(),
    ...fields,
  };
}

const actionContextStore = new AsyncLocalStorage<CurrentActionContext>();
let resolverInstalled = false;

/**
 * Run `fn` as a turn on a channel conversation, so `getCurrentActionContext()`
 * inside it answers with `channelContext` the way it does when a channel
 * message reaches the app's agent. Calls nest and run concurrently without
 * leaking into each other.
 */
export function withActionContext<T>(
  context: CurrentActionContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!resolverInstalled) {
    setCurrentActionContextResolver(() => actionContextStore.getStore());
    resolverInstalled = true;
  }
  return actionContextStore.run(context, fn);
}

/** {@link withActionContext} for the common case: only the channel conversation. */
export function withChannelContext<T>(
  channelContext: ThreadContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withActionContext({ channelContext }, fn);
}

/** An {@link ActionConfig} with the defaults an `action.yaml` would fill. */
export function testActionConfig(
  name: string,
  overrides: Partial<ActionConfig> = {},
): ActionConfig {
  return {
    name,
    type: "custom",
    description: name,
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: "read-only",
    ...overrides,
  };
}

/** A logger that keeps every line, for assertions, and prints nothing. */
export interface RecordingLogger extends Logger {
  lines: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    data?: Record<string, unknown>;
  }>;
}

export function createRecordingLogger(): RecordingLogger {
  const lines: RecordingLogger["lines"] = [];
  const at =
    (level: RecordingLogger["lines"][number]["level"]) =>
    (message: string, data?: Record<string, unknown>) => {
      lines.push({ level, message, ...(data ? { data } : {}) });
    };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** The `createAction(config, deps)` an action module exports. */
export type ActionFactory<TDeps> = (config: ActionConfig, deps: TDeps) => Action | Promise<Action>;

export interface TestApiResponse {
  status: number;
  headers: Headers;
  /** The body parsed as JSON, or the raw text when it is not JSON. */
  body: unknown;
}

export interface TestApp {
  appId: string;
  db: AppDbContext;
  channels: FakeChannels;
  logger: RecordingLogger;
  /** In-memory app settings, as `appContext.repositories.settings` reads them. */
  settings: Map<string, unknown>;
  /** What the host hands `createApiHandler(ctx)` and every action's `deps.appContext`. */
  appContext: RomeAppContext;
  /** The deps an action's `createAction(config, deps)` receives. */
  deps: { appContext: RomeAppContext; channelsService: ChannelsService } & Record<string, unknown>;
  /**
   * Instantiate an action from its module's factory and register it, so
   * {@link TestApp.runAction} and `appContext.runAction` reach it by name.
   */
  action<TDeps>(
    name: string,
    factory: ActionFactory<TDeps>,
    config?: Partial<ActionConfig>,
  ): Promise<Action>;
  /**
   * Run a registered action the way the host does: arguments and result cross
   * a JSON boundary, so a `Date` arrives as a string and an unserializable
   * value fails with {@link ActionInvocationError}.
   */
  runAction(name: string, args?: Record<string, unknown>): Promise<ActionResult>;
  /** Run `fn` as a turn in a channel conversation; see {@link withChannelContext}. */
  inChannel<T>(channelContext: ThreadContext, fn: () => Promise<T>): Promise<T>;
  /** Run the app's `app-started` hook from its `createHook(deps)` factory. */
  start(
    createHook: (deps: AppStartedHookDeps) => AppStartedHook,
    appVersion?: string,
  ): Promise<void>;
  /** Call the app's API handler from its `createApiHandler(ctx)` factory. */
  api(createApiHandler: (ctx: RomeAppContext) => RomeAppApiHandler): {
    request(
      method: string,
      path: string,
      init?: { body?: unknown; caller?: RomeAppCaller; headers?: Record<string, string> },
    ): Promise<TestApiResponse>;
  };
  close(): void;
}

/**
 * One app wired the way the host wires it, minus the daemon: a migrated
 * in-memory database, a fake channels service, in-memory settings, and an
 * action registry behind `appContext.runAction`.
 *
 * Host services an app cannot meaningfully use in a test (favors, routines,
 * the agent runner) reject with a message naming the service, so a test that
 * reaches one fails loudly instead of passing on a stub.
 */
export async function createTestApp(options: {
  appId: string;
  tablePrefix?: string;
  migrationsFolder?: string | URL;
  channelHistory?: ChannelMessage[];
  /** Extra deps merged into every action's `deps`, after the defaults. */
  deps?: Record<string, unknown>;
  /** Answers `runAction` for a name no `app.action` registered, such as a
   *  `system:` action. Left out, such a call rejects with `not_found`. */
  unknownAction?: (name: string, args: Record<string, unknown>) => Promise<ActionResult>;
  /** Replaces host services on `appContext`, such as `listRoutines`. */
  appContext?: Partial<Pick<RomeAppContext, "favors" | "listRoutines" | "repositories">>;
  /** The `better-sqlite3` default export; see {@link createTestDb}. */
  Database?: SqliteConstructor;
}): Promise<TestApp> {
  const tablePrefix = options.tablePrefix ?? options.appId.replaceAll("-", "_");
  const { db, close } = await createTestDb({
    tablePrefix,
    ...(options.migrationsFolder ? { migrationsFolder: options.migrationsFolder } : {}),
    ...(options.Database ? { Database: options.Database } : {}),
  });
  const channels = createFakeChannels(options.channelHistory);
  const logger = createRecordingLogger();
  const settings = new Map<string, unknown>();
  const actions = new Map<string, Action>();

  const unavailable = (service: string) => () =>
    Promise.reject(
      new Error(`${service} is not available in createTestApp; pass a fake through options.deps`),
    );

  const repositories: AppRuntimeRepositories = {
    settings: {
      async get<T>(key: string) {
        return (settings.has(key) ? settings.get(key) : null) as T | null;
      },
      async set(key, value) {
        settings.set(key, value);
      },
    },
  };

  const runAction = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ActionResult> => {
    const action = actions.get(name);
    if (!action && options.unknownAction) {
      const result = await options.unknownAction(name, toWireShape(args, name, "args"));
      return toWireShape(result, name, "result");
    }
    if (!action) {
      throw new ActionInvocationError(
        name,
        "not_found",
        `No action "${name}" is registered; call app.action("${name}", createAction) first`,
      );
    }
    const wireArgs = toWireShape(args, name, "args");
    try {
      const result = await action.execute(wireArgs);
      return toWireShape(result, name, "result");
    } catch (err) {
      if (err instanceof ActionInvocationError) throw err;
      throw new ActionInvocationError(
        name,
        "handler_error",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const appContext: RomeAppContext = {
    app: { id: options.appId, version: "0.0.0-test", description: options.appId },
    controller: undefined,
    db,
    log: logger,
    repositories,
    favors: { requestAction: unavailable("favors.requestAction") },
    runAction: runAction as RomeAppContext["runAction"],
    invokeAction<TEvent extends { type: string }, TOutput>(
      name: string,
      args: Record<string, unknown>,
    ) {
      return {
        events: (async function* () {})(),
        result: runAction(name, args),
      } as unknown as ActionInvocation<TEvent, TOutput>;
    },
    listRoutines: unavailable("listRoutines"),
    ...options.appContext,
  };

  const deps = { channelsService: channels.service, ...options.deps, appContext };

  return {
    appId: options.appId,
    db,
    channels,
    logger,
    settings,
    appContext,
    deps,
    async action(name, factory, config) {
      const action = await factory(testActionConfig(name, config), deps as never);
      actions.set(name, action);
      return action;
    },
    runAction,
    inChannel: withChannelContext,
    async start(createHook, appVersion = "0.0.0-test") {
      const hook = createHook({ appId: options.appId, logger, appContext });
      await hook.onAppStarted({
        type: "app-started",
        version: 1,
        appId: options.appId,
        appVersion,
      });
    },
    api(createApiHandler) {
      const handler = createApiHandler(appContext);
      return {
        async request(method, path, init = {}) {
          const url = new URL(path.replace(/^\/+/, ""), "http://app.test/");
          const body =
            init.body === undefined
              ? undefined
              : init.body instanceof Uint8Array
                ? init.body
                : new TextEncoder().encode(
                    typeof init.body === "string" ? init.body : JSON.stringify(init.body),
                  );
          const response = await handler.handle({
            method: method.toUpperCase(),
            path: url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
            query: url.searchParams,
            ...(body ? { body } : {}),
            caller: init.caller ?? { kind: "guardian", userId: "guardian", via: "cookie" },
          });
          const text = await response.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Not JSON; the raw text is the body.
          }
          return { status: response.status, headers: response.headers, body: parsed };
        },
      };
    },
    close,
  };
}

function toWireShape<T>(value: T, actionName: string, what: "args" | "result"): T {
  try {
    return (value === undefined ? value : JSON.parse(JSON.stringify(value))) as T;
  } catch (err) {
    throw new ActionInvocationError(
      actionName,
      "unserializable",
      `Action ${what} for "${actionName}" cannot cross a process boundary: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
