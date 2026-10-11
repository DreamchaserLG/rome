import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it, expect, rs, afterEach } from "@rstest/core";
import {
  ActionEngine,
  resolveActionWorkerEntryPath,
  type ActionRunContext,
  type ApprovalCreatedEvent,
} from "./engine.js";
import { actionExecutionContext } from "./context.js";
import { hashArgs, replayContext, type JournalEntry } from "./replay.js";
import { ActionRegistryImpl } from "./registry.js";
import type { Action, ActionResult } from "./types.js";
import { callAction } from "./call-action.js";
import type { IpcRpc } from "./ipc.js";
import type { WorkerRpcServer } from "./worker-rpc.js";
import { emitAgentMessage, type ActionRuntimeEvent } from "./runtime-events.js";
import {
  getCurrentHookInvocationContext,
  runWithHookInvocationContext,
} from "../core/hook-recursion.js";
import {
  currentSessionActor,
  runWithSessionActor,
  type SessionActor,
} from "../lib/session-actor.js";
import {
  createTestRome,
  buildAction,
  recordingAction,
  FakeClock,
  type TestRome,
} from "../test/kit/index.js";
import { createActionEngineRepos } from "../test/helpers.js";

// ActionEngine tests through the real wiring (testkit): the production engine
// over real repositories on an in-memory DB. Assertions read execution rows,
// journal entries, and approval rows back from the DB — not stub call shapes.
// The only faked seam is `executeInSubprocess` (the worker fork — a process
// boundary), and only in the tests that exercise the fork orchestration.

interface SubprocessEngine {
  executeInSubprocess(...args: unknown[]): Promise<ActionResult>;
}

describe("ActionEngine", () => {
  let rome: TestRome;

  afterEach(async () => {
    await rome?.cleanup();
  });

  async function setup(options: Parameters<typeof createTestRome>[0] = {}) {
    rome = await createTestRome(options);
    return rome;
  }

  /** The persisted journal of the most recent root run of `rootActionName`. */
  async function journalOf(rootActionName: string): Promise<JournalEntry[]> {
    const [row] = await rome.repos.actionExecutions.findByAction(rootActionName);
    expect(row, `no execution row for ${rootActionName}`).toBeDefined();
    return rome.repos.executionJournal.loadJournal(row.rootExecutionId);
  }

  describe("resolveActionWorkerEntryPath", () => {
    it("uses the TypeScript worker beside the source engine", () => {
      expect(resolveActionWorkerEntryPath("file:///app/packages/core/src/actions/engine.ts")).toBe(
        "/app/packages/core/src/actions/worker-bootstrap.ts",
      );
    });

    it("uses the JavaScript worker beside the compiled engine", () => {
      expect(resolveActionWorkerEntryPath("file:///app/packages/core/dist/actions/engine.js")).toBe(
        "/app/packages/core/dist/actions/worker-bootstrap.js",
      );
    });

    it("uses the compiled worker from a bundled root entrypoint", () => {
      expect(resolveActionWorkerEntryPath("file:///app/packages/core/dist/index.js")).toBe(
        "/app/packages/core/dist/actions/worker-bootstrap.js",
      );
    });

    it("uses the compiled worker from a bundled daemon entrypoint", () => {
      expect(resolveActionWorkerEntryPath("file:///app/packages/core/dist/daemon/index.js")).toBe(
        "/app/packages/core/dist/actions/worker-bootstrap.js",
      );
    });
  });

  describe("worker warm pool", () => {
    class FakeWorkerChild extends EventEmitter {
      pid = 12345;
      connected = true;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      sent: unknown[] = [];
      pendingActionNames: string[] = [];

      // A real ChildProcess runs its callbacks in the async context of fork().
      private readonly forkContext = new AsyncResource("FakeWorkerChild");

      constructor(private readonly autoRespond = true) {
        super();
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        return this.forkContext.runInAsyncScope(() => super.emit(event, ...args));
      }

      send(message: unknown, cb?: (err: Error | null) => void): boolean {
        this.sent.push(message);
        cb?.(null);
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "shutdown"
        ) {
          this.connected = false;
          this.exitCode = 0;
          queueMicrotask(() => this.emit("exit", 0, null));
          return true;
        }
        if (
          typeof message === "object" &&
          message !== null &&
          typeof (message as { actionName?: unknown }).actionName === "string"
        ) {
          const actionName = (message as { actionName: string }).actionName;
          if (this.autoRespond) {
            queueMicrotask(() => this.completeNext(actionName));
          } else {
            this.pendingActionNames.push(actionName);
          }
        }
        return true;
      }

      completeNext(actionName = this.pendingActionNames.shift() ?? "unknown"): void {
        this.emit("message", { type: "result", result: { status: "ok", data: actionName } });
      }
    }

    function actionMessages(child: FakeWorkerChild): unknown[] {
      return child.sent.filter((msg) => (msg as { actionName?: string }).actionName);
    }

    function installFakeWorkerFactory(
      engine: ActionEngine,
      factoryOptions: { autoRespond?: boolean } = {},
    ) {
      const children: FakeWorkerChild[] = [];
      const createWorkerProcess = rs
        .spyOn(
          engine as unknown as {
            createWorkerProcess(options: { pooled: boolean; detached: boolean }): unknown;
          },
          "createWorkerProcess",
        )
        .mockImplementation((options) => {
          const child = new FakeWorkerChild(factoryOptions.autoRespond ?? true);
          children.push(child);
          return {
            child,
            state: "starting",
            pooled: options.pooled,
            generation: (engine as unknown as { workerPoolGeneration: number })
              .workerPoolGeneration,
            retireAfterRun: false,
            useCount: 0,
            hasBeenReady: false,
            attached: false,
          };
        });
      return { children, createWorkerProcess };
    }

    function installFakeChildProcessFactory(factoryOptions: { autoRespond?: boolean } = {}) {
      const children: FakeWorkerChild[] = [];
      const actionWorkerFork = rs.fn(() => {
        const child = new FakeWorkerChild(factoryOptions.autoRespond ?? true);
        children.push(child);
        return child as unknown as ChildProcess;
      });
      return { children, actionWorkerFork };
    }

    it("returns successful warm workers to idle and reuses them", async () => {
      const registry = new ActionRegistryImpl();
      registry.register(buildAction("root"));
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 1,
      });
      const { children, createWorkerProcess } = installFakeWorkerFactory(engine);

      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);
      children[0].emit("message", { type: "ready" });

      await expect(engine.run("root", {})).resolves.toEqual({ status: "ok", data: "root" });
      await expect(engine.run("root", {})).resolves.toEqual({ status: "ok", data: "root" });

      expect(createWorkerProcess).toHaveBeenCalledTimes(1);
      expect(actionMessages(children[0])).toHaveLength(2);
      expect(children[0].sent).not.toContainEqual({ type: "shutdown" });

      await engine.stopWorkerWarmPool();
      expect(children[0].sent).toContainEqual({ type: "shutdown" });
    });

    it("recycles idle warm workers on pool restart", async () => {
      const registry = new ActionRegistryImpl();
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 1,
      });
      const { children, createWorkerProcess } = installFakeWorkerFactory(engine);

      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);
      children[0].emit("message", { type: "ready" });

      await engine.restartWorkerWarmPool();

      expect(createWorkerProcess).toHaveBeenCalledTimes(2);
      expect(children[0].sent).toContainEqual({ type: "shutdown" });
      expect(children[0].connected).toBe(false);

      await engine.stopWorkerWarmPool();
    });

    it("does not refill pooled workers that exit before becoming idle", async () => {
      const registry = new ActionRegistryImpl();
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 1,
      });
      const { children, createWorkerProcess } = installFakeWorkerFactory(engine);

      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);

      children[0].exitCode = 1;
      children[0].emit("exit", 1, null);

      expect(createWorkerProcess).toHaveBeenCalledTimes(1);
      await engine.stopWorkerWarmPool();
    });

    it("retires a running warm worker after pool restart", async () => {
      const registry = new ActionRegistryImpl();
      registry.register(buildAction("root"));
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 1,
      });
      const { children, createWorkerProcess } = installFakeWorkerFactory(engine, {
        autoRespond: false,
      });

      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);
      children[0].emit("message", { type: "ready" });

      const run = engine.run("root", {});
      await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));

      await engine.restartWorkerWarmPool();

      expect(createWorkerProcess).toHaveBeenCalledTimes(2);
      expect(children[0].sent).not.toContainEqual({ type: "shutdown" });
      children[1].emit("message", { type: "ready" });

      children[0].completeNext();
      await expect(run).resolves.toEqual({ status: "ok", data: "root" });
      expect(children[0].sent).toContainEqual({ type: "shutdown" });

      await engine.stopWorkerWarmPool();
      expect(children[1].sent).toContainEqual({ type: "shutdown" });
    });

    it("counts warm and delegated workers against the configured process cap", async () => {
      const registry = new ActionRegistryImpl();
      registry.register(buildAction("root"));
      const { children, actionWorkerFork } = installFakeChildProcessFactory({
        autoRespond: false,
      });
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 1,
        maxWorkerProcesses: 1,
        actionWorkerFork,
      });

      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);
      children[0].emit("message", { type: "ready" });

      const rootRun = engine.run("root", {});
      await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));

      let delegatedError: unknown;
      try {
        engine.startDelegatedAction({
          actionName: "root",
          args: {},
          context: { executionId: "child", rootExecutionId: "root" },
          forkStartedAt: 0,
        });
      } catch (error) {
        delegatedError = error;
      }
      expect(delegatedError).toMatchObject({ name: "ActionWorkerCapacityError" });
      expect(actionWorkerFork).toHaveBeenCalledTimes(1);

      children[0].completeNext();
      await expect(rootRun).resolves.toEqual({ status: "ok", data: "root" });
      await engine.stopWorkerWarmPool();
    });

    it("rejects a second root instead of cold-forking past the process cap", async () => {
      const registry = new ActionRegistryImpl();
      registry.register(buildAction("root"));
      const { children, actionWorkerFork } = installFakeChildProcessFactory({
        autoRespond: false,
      });
      const engine = new ActionEngine(registry, createActionEngineRepos(), {
        processRole: "main",
        workerWarmPoolSize: 0,
        maxWorkerProcesses: 1,
        actionWorkerFork,
      });

      const first = engine.run("root", {});
      await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));

      await expect(engine.run("root", {})).rejects.toMatchObject({
        name: "ActionWorkerCapacityError",
      });
      expect(actionWorkerFork).toHaveBeenCalledTimes(1);

      children[0].completeNext();
      await expect(first).resolves.toEqual({ status: "ok", data: "root" });
    });

    describe("queued roots", () => {
      const queue: ActionRunContext = { whenWorkersBusy: "queue" };

      function createQueueingEngine(maxWorkerProcesses: number, clock = new FakeClock()) {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 0,
          maxWorkerProcesses,
          queuedRootMaxWaitMs: 60_000,
          actionWorkerFork,
          clock,
        });
        return { engine, children, actionWorkerFork, clock };
      }

      it("waits for a free worker instead of failing", async () => {
        const { engine, children, actionWorkerFork } = createQueueingEngine(1);

        const first = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));

        const queued = engine.run("root", {}, queue);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(actionWorkerFork).toHaveBeenCalledTimes(1);

        children[0].completeNext();
        await expect(first).resolves.toEqual({ status: "ok", data: "root" });
        await rs.waitFor(() => expect(actionWorkerFork).toHaveBeenCalledTimes(2));
        children[1].completeNext();
        await expect(queued).resolves.toEqual({ status: "ok", data: "root" });
      });

      it("forks a single-use worker in the async context of the root it serves", async () => {
        const { engine, children } = createQueueingEngine(1);
        // Stands in for the dispatcher's trace span and other request-scoped stores.
        const requestScope = new AsyncLocalStorage<string>();
        engine.setWorkerRpcServer({
          register(rpc: IpcRpc) {
            rpc.handle("probe", async () => requestScope.getStore() ?? null);
          },
        } as unknown as WorkerRpcServer);
        const probe = async (child: FakeWorkerChild, reqId: string, expected: string) => {
          child.emit("message", { type: "rpc_request", reqId, method: "probe", params: {} });
          await rs.waitFor(() =>
            expect(child.sent).toContainEqual({ type: "rpc_response", reqId, result: expected }),
          );
        };

        const first = requestScope.run("request-1", () => engine.run("root", {}));
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        const queued = requestScope.run("request-2", () => engine.run("root", {}, queue));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await probe(children[0], "r1", "request-1");

        // The queued root's fork starts from the first worker's exit callback,
        // which runs in request-1, but serves the root queued in request-2.
        children[0].completeNext();
        await first;
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));
        await probe(children[1], "r2", "request-2");
        children[1].completeNext();
        await expect(queued).resolves.toEqual({ status: "ok", data: "root" });
      });

      it("admits queued roots in arrival order", async () => {
        const { engine, children } = createQueueingEngine(1);

        const blocker = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(1));
        const registry = (engine as unknown as { registry: ActionRegistryImpl }).registry;
        registry.register(buildAction("second"));
        registry.register(buildAction("third"));
        const second = engine.run("second", {}, queue);
        const third = engine.run("third", {}, queue);
        await new Promise((resolve) => setTimeout(resolve, 0));

        children[0].completeNext();
        await blocker;
        await rs.waitFor(() => expect(children).toHaveLength(2));
        expect(actionMessages(children[1])).toMatchObject([{ actionName: "second" }]);

        children[1].completeNext();
        await second;
        await rs.waitFor(() => expect(children).toHaveLength(3));
        expect(actionMessages(children[2])).toMatchObject([{ actionName: "third" }]);
        children[2].completeNext();
        await third;
      });

      it("leaves the reserved slots to fail-fast roots", async () => {
        // Cap 3 keeps two slots back, so queued roots run one at a time.
        const { engine, children, actionWorkerFork } = createQueueingEngine(3);

        const queuedFirst = engine.run("root", {}, queue);
        await rs.waitFor(() => expect(children).toHaveLength(1));
        const queuedSecond = engine.run("root", {}, queue);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(actionWorkerFork).toHaveBeenCalledTimes(1);

        const failFast = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(2));
        children[1].completeNext();
        await expect(failFast).resolves.toEqual({ status: "ok", data: "root" });
        expect(actionWorkerFork).toHaveBeenCalledTimes(2);

        children[0].completeNext();
        await queuedFirst;
        await rs.waitFor(() => expect(children).toHaveLength(3));
        children[2].completeNext();
        await expect(queuedSecond).resolves.toEqual({ status: "ok", data: "root" });
      });

      it("fails with a capacity error once the queue deadline passes", async () => {
        const { engine, children, clock } = createQueueingEngine(1);

        const blocker = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(1));
        const queued = engine.run("root", {}, queue);
        const outcome = queued.catch((err: unknown) => err);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await clock.advance(60_000);
        await expect(outcome).resolves.toMatchObject({
          name: "ActionWorkerCapacityError",
          message: expect.stringContaining("queued 60s"),
        });

        children[0].completeNext();
        await blocker;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(children).toHaveLength(1);
      });

      it("cancels a root while it waits in the queue", async () => {
        const { engine, children } = createQueueingEngine(1);

        const blocker = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(1));
        const queued = engine.run("root", {}, { ...queue, executionId: "queued-root" });
        const outcome = queued.catch((err: unknown) => err);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(engine.cancel("queued-root")).resolves.toBe(true);
        await expect(outcome).resolves.toMatchObject({ name: "ActionCancelledError" });

        children[0].completeNext();
        await blocker;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(children).toHaveLength(1);
      });

      it("accepts a detached dispatch while its root waits for a worker", async () => {
        const { engine, children } = createQueueingEngine(1);

        const blocker = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(1));

        await expect(engine.dispatch("root", {})).resolves.toMatchObject({
          executionId: expect.any(String),
        });
        expect(children).toHaveLength(1);

        children[0].completeNext();
        await blocker;
        await rs.waitFor(() => expect(children).toHaveLength(2));
        children[1].completeNext();
      });

      it("hands a queued root the warm worker, both when it becomes ready and when it returns", async () => {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          maxWorkerProcesses: 1,
          actionWorkerFork,
          clock: new FakeClock(),
        });

        // The starting warm worker fills the cap, so the root waits for it
        // rather than counting it as busy or forking past the cap.
        engine.startWorkerWarmPool();
        const first = engine.run("root", {}, queue);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(actionMessages(children[0])).toHaveLength(0);

        children[0].emit("message", { type: "ready" });
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));

        const second = engine.run("root", {}, queue);
        await new Promise((resolve) => setTimeout(resolve, 0));
        children[0].completeNext();
        await expect(first).resolves.toEqual({ status: "ok", data: "root" });
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(2));
        children[0].completeNext();
        await expect(second).resolves.toEqual({ status: "ok", data: "root" });

        expect(actionWorkerFork).toHaveBeenCalledTimes(1);
        await engine.stopWorkerWarmPool();
      });

      it("still fails a nested delegation at once while roots queue", async () => {
        const { engine, children } = createQueueingEngine(1);

        const blocker = engine.run("root", {});
        await rs.waitFor(() => expect(children).toHaveLength(1));

        expect(() =>
          engine.startDelegatedAction({
            actionName: "root",
            args: {},
            context: { executionId: "child", rootExecutionId: "parent" },
            forkStartedAt: 0,
          }),
        ).toThrow(expect.objectContaining({ name: "ActionWorkerCapacityError" }));

        children[0].completeNext();
        await blocker;
      });
    });

    describe("queued roots with a started warm pool", () => {
      const queue: ActionRunContext = { whenWorkersBusy: "queue" };
      const ready = { type: "ready" };
      const shutdown = { type: "shutdown" };

      async function settle(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      /** An engine with one ready warm worker, `children[0]`. */
      function createWarmEngine(maxWorkerProcesses = 8) {
        const registry = new ActionRegistryImpl();
        for (const name of ["submit", "explain", "root"]) registry.register(buildAction(name));
        const clock = new FakeClock();
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          maxWorkerProcesses,
          queuedRootMaxWaitMs: 10 * 60_000,
          actionWorkerFork,
          clock,
        });
        engine.startWorkerWarmPool();
        children[0].emit("message", ready);
        return { engine, children, actionWorkerFork, clock };
      }

      /** Starts `submit` on `submitWorker`, then dispatches `explain` while it runs.
       * Wraps the pending run in an object so the async return does not await it. */
      async function submitThenDispatch(engine: ActionEngine, submitWorker: FakeWorkerChild) {
        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() =>
          expect(actionMessages(submitWorker).at(-1)).toMatchObject({ actionName: "submit" }),
        );
        await expect(engine.dispatch("explain", {})).resolves.toMatchObject({
          executionId: expect.any(String),
        });
        return { submit };
      }

      it("hands a detached root the dispatcher's worker once it returns", async () => {
        const { engine, children, actionWorkerFork } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        expect(children).toHaveLength(2);
        expect(actionMessages(children[1])).toHaveLength(0);

        children[0].completeNext();
        await expect(submit).resolves.toEqual({ status: "ok", data: "submit" });
        await rs.waitFor(() =>
          expect(actionMessages(children[0]).at(-1)).toMatchObject({ actionName: "explain" }),
        );

        // The fork started for explain joins the pool instead of being discarded.
        children[1].emit("message", ready);
        children[0].completeNext();
        await settle();
        expect(children.flatMap((child) => child.sent)).not.toContainEqual(shutdown);

        // Later requests find a free worker for each hop and fork nothing.
        for (let i = 0; i < 3; i++) {
          const next = engine.run("submit", {}, queue);
          await settle();
          await engine.dispatch("explain", {});
          await settle();
          expect(children.map((child) => child.pendingActionNames.length)).toEqual([1, 1]);
          for (const child of children) child.completeNext();
          await expect(next).resolves.toMatchObject({ status: "ok" });
          await settle();
        }
        expect(actionWorkerFork).toHaveBeenCalledTimes(2);
        await engine.stopWorkerWarmPool();
      });

      it("runs the root on its new worker when the busy worker does not return", async () => {
        const { engine, children } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        children[1].emit("message", ready);
        await rs.waitFor(() =>
          expect(actionMessages(children[1])).toMatchObject([{ actionName: "explain" }]),
        );

        children[1].completeNext();
        children[0].completeNext();
        await expect(submit).resolves.toEqual({ status: "ok", data: "submit" });
        await settle();
        expect(children.flatMap((child) => child.sent)).not.toContainEqual(shutdown);
        await engine.stopWorkerWarmPool();
      });

      it("retires a surplus idle worker after it sits idle for five minutes", async () => {
        const { engine, children, clock } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        children[1].emit("message", ready);
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));
        children[1].completeNext();
        children[0].completeNext();
        await submit;
        await settle();

        await clock.advance("4m");
        expect(children.flatMap((child) => child.sent)).not.toContainEqual(shutdown);
        await clock.advance("1m");
        const retired = children.filter((child) =>
          child.sent.some((message) => (message as { type?: unknown }).type === "shutdown"),
        );
        expect(retired).toHaveLength(1);

        // The worker that stays is still the pool's warm worker.
        await engine.dispatch("root", {});
        await settle();
        expect(children.filter((child) => child.pendingActionNames.length === 1)).toHaveLength(1);
        await engine.stopWorkerWarmPool();
      });

      it("retires surplus workers after a burst while sparse traffic continues", async () => {
        const { engine, children, clock } = createWarmEngine();

        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        await engine.dispatch("explain", {});
        await engine.dispatch("explain", {});
        expect(children).toHaveLength(3);
        children[1].emit("message", ready);
        children[2].emit("message", ready);
        await rs.waitFor(() =>
          expect(children.map((child) => child.pendingActionNames.length)).toEqual([1, 1, 1]),
        );
        for (const child of children) child.completeNext();
        await submit;
        await settle();

        // One run a minute reuses the same worker, so the other two age out.
        for (let minute = 0; minute < 7; minute++) {
          const run = engine.run("root", {});
          await settle();
          const serving = children.filter((child) => child.pendingActionNames.length === 1);
          expect(serving).toHaveLength(1);
          serving[0].completeNext();
          await run;
          await clock.advance("1m");
        }
        const retired = children.filter((child) =>
          child.sent.some((message) => (message as { type?: unknown }).type === "shutdown"),
        );
        expect(retired).toHaveLength(2);
        expect(children).toHaveLength(3);
        await engine.stopWorkerWarmPool();
      });

      it("falls back to a single-use fork when the new worker exits before ready", async () => {
        const { engine, children, actionWorkerFork } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        children[1].exitCode = 1;
        children[1].emit("exit", 1, null);
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );

        children[2].completeNext();
        await rs.waitFor(() => expect(children[2].sent).toContainEqual(shutdown));
        children[0].completeNext();
        await submit;
        await settle();
        expect(actionWorkerFork).toHaveBeenCalledTimes(3);
        await engine.stopWorkerWarmPool();
      });

      it("waits for pooled workers again once a single-use fork reaches ready", async () => {
        const { engine, children } = createWarmEngine();

        const first = await submitThenDispatch(engine, children[0]);
        children[1].exitCode = 1;
        children[1].emit("exit", 1, null);
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );
        children[2].emit("message", ready);
        children[2].completeNext();
        await rs.waitFor(() => expect(children[2].sent).toContainEqual(shutdown));
        children[0].completeNext();
        await first.submit;
        await settle();

        const second = await submitThenDispatch(engine, children[0]);
        expect(children).toHaveLength(4);
        expect(actionMessages(children[3])).toHaveLength(0);
        children[0].completeNext();
        await second.submit;
        await rs.waitFor(() =>
          expect(actionMessages(children[0]).at(-1)).toMatchObject({ actionName: "explain" }),
        );

        children[0].completeNext();
        await engine.stopWorkerWarmPool();
      });

      it("falls back to a single-use fork when the new worker is slow to become ready", async () => {
        const { engine, children, clock } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        await clock.advance("59s");
        expect(children).toHaveLength(2);
        await clock.advance("1s");
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );
        expect(children[1].sent).not.toContainEqual(shutdown);

        // The slow worker still joins the pool once it reaches ready.
        children[1].emit("message", ready);
        children[2].completeNext();
        children[0].completeNext();
        await submit;
        await settle();
        expect(children[1].sent).not.toContainEqual(shutdown);
        await engine.dispatch("root", {});
        await settle();
        expect(children).toHaveLength(3);
        expect(children.filter((child) => child.pendingActionNames.length === 1)).toHaveLength(1);
        await engine.stopWorkerWarmPool();
      });

      it("keeps a boot-time pool worker that is slow to become ready", async () => {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const clock = new FakeClock();
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          actionWorkerFork,
          clock,
        });
        engine.startWorkerWarmPool();
        await clock.advance("2m");
        expect(children[0].sent).not.toContainEqual(shutdown);

        children[0].emit("message", ready);
        const run = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        children[0].completeNext();
        await expect(run).resolves.toEqual({ status: "ok", data: "root" });
        expect(actionWorkerFork).toHaveBeenCalledTimes(1);
        await engine.stopWorkerWarmPool();
      });

      it("takes single-use forks while a pooled worker is overdue for ready", async () => {
        const { engine, children, clock } = createWarmEngine();

        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        await engine.dispatch("explain", {});
        await clock.advance("1m");
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );
        children[2].emit("message", ready);
        children[2].completeNext();
        await rs.waitFor(() => expect(children[2].sent).toContainEqual(shutdown));

        // children[1] is still starting, so each later root forks a single-use
        // worker and no new pooled worker joins it in holding a slot.
        for (const child of [3, 4]) {
          await engine.dispatch("explain", {});
          await rs.waitFor(() =>
            expect(actionMessages(children[child])).toMatchObject([{ actionName: "explain" }]),
          );
          children[child].completeNext();
          await rs.waitFor(() => expect(children[child].sent).toContainEqual(shutdown));
        }
        const failFast = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[5])).toHaveLength(1));
        children[5].completeNext();
        await expect(failFast).resolves.toEqual({ status: "ok", data: "root" });

        children[0].completeNext();
        await submit;
        expect(children).toHaveLength(6);
        await engine.stopWorkerWarmPool();
      });

      it("stops a pooled worker that never becomes ready and keeps the healthy one", async () => {
        const { engine, children, actionWorkerFork, clock } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        await clock.advance("1m");
        await rs.waitFor(() => expect(actionMessages(children[2])).toHaveLength(1));
        children[2].completeNext();
        children[0].completeNext();
        await submit;
        await settle();

        await clock.advance("239s");
        expect(children[1].sent).not.toContainEqual(shutdown);
        await clock.advance("1s");
        expect(children[1].sent).toContainEqual(shutdown);

        // The healthy worker is not retired as surplus and still serves runs.
        await clock.advance("5m");
        expect(children[0].sent).not.toContainEqual(shutdown);
        const run = engine.run("root", {});
        await rs.waitFor(() =>
          expect(actionMessages(children[0]).at(-1)).toMatchObject({ actionName: "root" }),
        );
        children[0].completeNext();
        await expect(run).resolves.toEqual({ status: "ok", data: "root" });
        expect(actionWorkerFork).toHaveBeenCalledTimes(3);
        await engine.stopWorkerWarmPool();
      });

      it("keeps the reserved slots free while pooled workers are overdue for ready", async () => {
        const { engine, children, clock } = createWarmEngine();

        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        for (let i = 0; i < 5; i++) await engine.dispatch("explain", {});
        expect(children).toHaveLength(6);

        // The five overdue workers and the busy one fill the queued-root slots,
        // so the waiting roots fork nothing and both fail-fast roots still run.
        await clock.advance("1m");
        await settle();
        expect(children).toHaveLength(6);
        const failFast = [engine.run("root", {}), engine.run("root", {})];
        await rs.waitFor(() => expect(children).toHaveLength(8));
        children[6].completeNext();
        children[7].completeNext();
        await expect(Promise.all(failFast)).resolves.toEqual([
          { status: "ok", data: "root" },
          { status: "ok", data: "root" },
        ]);

        for (const child of children.slice(1, 6)) child.emit("message", ready);
        await rs.waitFor(() =>
          expect(children.slice(1, 6).map((child) => actionMessages(child).length)).toEqual([
            1, 1, 1, 1, 1,
          ]),
        );
        for (const child of children) if (child.pendingActionNames.length) child.completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });

      it("refills the pool once a fork reaches ready after a stopped start", async () => {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const clock = new FakeClock();
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          actionWorkerFork,
          clock,
        });
        engine.startWorkerWarmPool();
        await clock.advance("5m");
        expect(children[0].sent).toContainEqual(shutdown);
        await settle();

        const run = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));
        expect(children).toHaveLength(2);
        children[1].emit("message", ready);
        expect(children).toHaveLength(3);
        children[1].completeNext();
        await run;

        children[2].emit("message", ready);
        const next = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[2])).toHaveLength(1));
        children[2].completeNext();
        await expect(next).resolves.toEqual({ status: "ok", data: "root" });
        expect(children).toHaveLength(3);
        await engine.stopWorkerWarmPool();
      });

      it("lets a fail-fast caller at the cap take a refill worker that is still starting", async () => {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        // Cap 3 keeps two slots back. The busy fallback fills the queued-root
        // slot and the recovery refill starts in a reserved one.
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          maxWorkerProcesses: 3,
          actionWorkerFork,
          clock: new FakeClock(),
        });
        engine.startWorkerWarmPool();
        children[0].exitCode = 1;
        children[0].emit("exit", 1, null);
        await settle();

        await engine.dispatch("root", {});
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));
        children[1].emit("message", ready);
        await rs.waitFor(() => expect(children).toHaveLength(3));

        const failFast = [engine.run("root", {}), engine.run("root", {})];
        await rs.waitFor(() => expect(children).toHaveLength(4));
        expect(actionMessages(children[3])).toHaveLength(1);
        expect(actionMessages(children[2])).toHaveLength(1);
        children[3].completeNext();
        children[2].emit("message", ready);
        children[2].completeNext();
        await expect(Promise.all(failFast)).resolves.toEqual([
          { status: "ok", data: "root" },
          { status: "ok", data: "root" },
        ]);

        // The taken worker returns to the pool, so the next run is warm.
        const next = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[2])).toHaveLength(2));
        children[2].completeNext();
        await expect(next).resolves.toEqual({ status: "ok", data: "root" });
        expect(children).toHaveLength(4);
        children[1].completeNext();
        await engine.stopWorkerWarmPool();
      });

      it("stops a taken starting worker that never becomes ready", async () => {
        const registry = new ActionRegistryImpl();
        registry.register(buildAction("root"));
        const clock = new FakeClock();
        const { children, actionWorkerFork } = installFakeChildProcessFactory({
          autoRespond: false,
        });
        const engine = new ActionEngine(registry, createActionEngineRepos(), {
          processRole: "main",
          workerWarmPoolSize: 1,
          maxWorkerProcesses: 3,
          actionWorkerFork,
          clock,
        });
        engine.startWorkerWarmPool();
        children[0].exitCode = 1;
        children[0].emit("exit", 1, null);
        await settle();

        await engine.dispatch("root", {});
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));
        children[1].emit("message", ready);
        await rs.waitFor(() => expect(children).toHaveLength(3));

        const failFast = [engine.run("root", {}), engine.run("root", {}).catch((err) => err)];
        await rs.waitFor(() => expect(children).toHaveLength(4));
        expect(actionMessages(children[2])).toHaveLength(1);
        children[3].completeNext();
        await expect(failFast[0]).resolves.toEqual({ status: "ok", data: "root" });

        // Its caller is waiting, so the taken worker gets the 60-second
        // deadline, not the five minutes an untaken slow start gets.
        await clock.advance("59s");
        expect(children[2].sent).not.toContainEqual(shutdown);
        await clock.advance("1s");
        expect(children[2].sent).toContainEqual(shutdown);
        await expect(failFast[1]).resolves.toMatchObject({ name: "ActionWorkerExitError" });
        children[1].completeNext();
        await engine.stopWorkerWarmPool();
      });

      it("treats a taken starting worker that dies before ready as a failed start", async () => {
        const { engine, children } = createWarmEngine(4);
        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        await engine.dispatch("explain", {});
        await rs.waitFor(() => expect(children).toHaveLength(2));
        const cold = [engine.run("root", {}), engine.run("root", {})];
        await rs.waitFor(() => expect(children).toHaveLength(4));
        const taken = engine.run("root", {}).catch((err: unknown) => err);
        await rs.waitFor(() =>
          expect(actionMessages(children[1])).toMatchObject([{ actionName: "root" }]),
        );

        children[1].exitCode = 1;
        children[1].emit("exit", 1, null);
        await expect(taken).resolves.toMatchObject({ name: "ActionWorkerExitError" });
        children[2].completeNext();
        children[3].completeNext();
        await Promise.all(cold);

        // A failed start sends the queued root to a single-use fork, which
        // gets its payload without waiting for ready.
        await rs.waitFor(() =>
          expect(actionMessages(children[4])).toMatchObject([{ actionName: "explain" }]),
        );
        children[4].completeNext();
        children[0].completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });

      it("does not treat a cancelled taken starting worker as a failed start", async () => {
        const { engine, children } = createWarmEngine(4);
        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        await engine.dispatch("explain", {});
        await rs.waitFor(() => expect(children).toHaveLength(2));
        const cold = [engine.run("root", {}), engine.run("root", {})];
        await rs.waitFor(() => expect(children).toHaveLength(4));
        const taken = engine
          .run("root", {}, { executionId: "taken-root" })
          .catch((err: unknown) => err);
        await rs.waitFor(() =>
          expect(actionMessages(children[1])).toMatchObject([{ actionName: "root" }]),
        );

        await expect(engine.cancel("taken-root")).resolves.toBe(true);
        children[1].signalCode = "SIGTERM";
        children[1].emit("exit", null, "SIGTERM");
        await expect(taken).resolves.toMatchObject({ name: "ActionCancelledError" });
        children[2].completeNext();
        children[3].completeNext();
        await Promise.all(cold);

        // The queued root still waits for a pooled worker's ready.
        await rs.waitFor(() => expect(children).toHaveLength(5));
        await settle();
        expect(actionMessages(children[4])).toHaveLength(0);
        children[4].emit("message", ready);
        await rs.waitFor(() =>
          expect(actionMessages(children[4])).toMatchObject([{ actionName: "explain" }]),
        );
        children[4].completeNext();
        children[0].completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });

      it("falls back to a single-use fork when the new worker fails to spawn", async () => {
        const { engine, children } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        (children[1] as { pid?: number }).pid = undefined;
        children[1].emit("error", new Error("spawn EAGAIN"));
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );

        children[2].completeNext();
        children[0].completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });

      it("leaves the new worker idle when the waiting root is cancelled", async () => {
        const { engine, children } = createWarmEngine();

        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        const queued = engine.run("explain", {}, { ...queue, executionId: "queued-root" });
        const outcome = queued.catch((err: unknown) => err);
        await settle();
        expect(children).toHaveLength(2);

        await expect(engine.cancel("queued-root")).resolves.toBe(true);
        await expect(outcome).resolves.toMatchObject({ name: "ActionCancelledError" });

        children[1].emit("message", ready);
        children[0].completeNext();
        await submit;
        await settle();
        expect(children.map((child) => actionMessages(child).length)).toEqual([1, 0]);
        await engine.stopWorkerWarmPool();
      });

      it("starts a current-generation worker for a root waiting through a pool restart", async () => {
        const { engine, children, actionWorkerFork } = createWarmEngine();

        const { submit } = await submitThenDispatch(engine, children[0]);
        await engine.restartWorkerWarmPool();
        expect(children[1].sent).toContainEqual(shutdown);
        expect(actionWorkerFork).toHaveBeenCalledTimes(3);

        children[2].emit("message", ready);
        await rs.waitFor(() =>
          expect(actionMessages(children[2])).toMatchObject([{ actionName: "explain" }]),
        );
        children[0].completeNext();
        await submit;
        await rs.waitFor(() => expect(children[0].sent).toContainEqual(shutdown));
        children[2].completeNext();
        await engine.stopWorkerWarmPool();
      });

      it("starts at most one worker per waiting root and keeps the reserved slots", async () => {
        // Cap 4 keeps two slots back, so queued roots hold at most two workers.
        const { engine, children } = createWarmEngine(4);

        const first = engine.run("root", {}, { ...queue, executionId: "first" });
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        const second = engine.run("root", {}, { ...queue, executionId: "second" });
        const third = engine.run("root", {}, { ...queue, executionId: "third" });
        await settle();
        expect(children).toHaveLength(2);

        const failFast = [engine.run("root", {}), engine.run("root", {})];
        await settle();
        expect(children).toHaveLength(4);
        expect(children.map((child) => actionMessages(child).length)).toEqual([1, 0, 1, 1]);

        // Two fail-fast roots still run, so the ready worker waits for a slot.
        children[1].emit("message", ready);
        await settle();
        expect(actionMessages(children[1])).toHaveLength(0);

        const completePending = () => {
          for (const child of children) if (child.pendingActionNames.length) child.completeNext();
        };
        completePending();
        await Promise.all([first, ...failFast]);
        await rs.waitFor(() =>
          expect(children.reduce((sum, child) => sum + actionMessages(child).length, 0)).toBe(5),
        );
        completePending();
        await Promise.all([second, third]);
        await engine.stopWorkerWarmPool();
      });

      it("keeps the forking request's async context out of a new worker's calls to main", async () => {
        const { engine, children } = createWarmEngine();
        // Stands in for every other request-scoped store: span, session, app API.
        const requestScope = new AsyncLocalStorage<string>();
        engine.setWorkerRpcServer({
          register(rpc: IpcRpc) {
            rpc.handle("probe", async () => ({
              actor: (await currentSessionActor()) ?? null,
              scope: requestScope.getStore() ?? null,
            }));
          },
        } as unknown as WorkerRpcServer);

        const guardian: SessionActor = { kind: "guardian", userId: "guardian-1", via: "cookie" };
        const { submit } = await requestScope.run("request-1", () =>
          runWithSessionActor(guardian, () => submitThenDispatch(engine, children[0])),
        );
        expect(children).toHaveLength(2);

        children[1].emit("message", {
          type: "rpc_request",
          reqId: "r1",
          method: "probe",
          params: {},
        });
        await rs.waitFor(() =>
          expect(children[1].sent).toContainEqual({
            type: "rpc_response",
            reqId: "r1",
            result: { actor: null, scope: null },
          }),
        );

        children[0].completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });

      it("still cold-forks a fail-fast root while the warm worker is busy", async () => {
        const { engine, children } = createWarmEngine();

        const submit = engine.run("submit", {}, queue);
        await rs.waitFor(() => expect(actionMessages(children[0])).toHaveLength(1));
        const failFast = engine.run("root", {});
        await rs.waitFor(() => expect(actionMessages(children[1])).toHaveLength(1));

        children[1].completeNext();
        await failFast;
        await rs.waitFor(() => expect(children[1].sent).toContainEqual(shutdown));
        children[0].completeNext();
        await submit;
        await engine.stopWorkerWarmPool();
      });
    });
  });

  // run() — root call, record mode
  describe("run() — root call, record mode", () => {
    it("executes the action and returns its result", async () => {
      await setup({
        actions: [buildAction("greet", { execute: async () => ({ status: "ok", data: "hello" }) })],
      });

      const result = await rome.actionEngine.run("greet", { name: "world" });
      expect(result).toEqual({ status: "ok", data: "hello" });
    });

    it("passes args to the action's execute()", async () => {
      const echo = recordingAction("echo");
      await setup({ actions: [echo.action] });

      await rome.actionEngine.run("echo", { msg: "test" });
      expect(echo.calls).toEqual([{ msg: "test" }]);
    });

    it("throws if action not found in registry", async () => {
      await setup();

      await expect(rome.actionEngine.run("nonexistent", {})).rejects.toThrow(
        'Action "nonexistent" not found',
      );
    });

    it("sets up actionExecutionContext with engine reference", async () => {
      let capturedStore: unknown;
      await setup({
        actions: [
          buildAction("ctx_check", {
            execute: async () => {
              capturedStore = actionExecutionContext.getStore();
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("ctx_check", {});
      const store = capturedStore as Record<string, unknown>;
      // The context carries the live engine; its contract is reference identity.
      // A deep matcher recursively traverses the engine's repositories and worker state.
      expect(store.engine).toBe(rome.actionEngine);
      expect(store).toMatchObject({
        executionId: expect.any(String),
        initiator: "unknown",
      });
      // Context fields should be undefined when no ActionRunContext is passed
      expect(store.channelContext).toBeUndefined();
      expect(store.sharedContext).toBeUndefined();
      expect(store.sessionId).toBeUndefined();
      expect(store.agentName).toBeUndefined();
      expect(store.channelThreadKey).toBeUndefined();
    }, 30_000);

    it("populates actionExecutionContext with channelContext from ActionRunContext", async () => {
      let capturedStore: unknown;
      await setup({
        actions: [
          buildAction("ctx_full", {
            execute: async () => {
              capturedStore = actionExecutionContext.getStore();
              return { status: "ok" };
            },
          }),
        ],
      });

      const context: ActionRunContext = {
        initiator: "channel:telegram",
        channelContext: {
          channel: "telegram",
          threadId: "t-1",
          threadPath: "/tmp/threads/t-1",
          channelUserId: "u-1",
          threadName: "Dev Chat",
          threadType: "group",
          projectName: "alpha",
        },
        sharedContext: {
          requestId: "req-ctx",
          tenantId: "tenant-alpha",
        },
        sessionId: "sess-99",
        agentName: "main",
        channelThreadKey: "telegram:t-1",
      };

      await rome.actionEngine.run("ctx_full", {}, context);
      const store = capturedStore as Record<string, unknown>;
      // Keep the live engine out of the structural matcher (see the test above).
      expect(store.engine).toBe(rome.actionEngine);
      expect(store).toMatchObject({
        executionId: expect.any(String),
        initiator: "channel:telegram",
        channelContext: context.channelContext,
        sharedContext: context.sharedContext,
        sessionId: "sess-99",
        agentName: "main",
        channelThreadKey: "telegram:t-1",
      });
    }, 30_000);

    it("preserves the current hook invocation context through direct actions", async () => {
      let capturedContext: unknown;
      await setup({
        actions: [
          buildAction("ctx_hook", {
            execute: async () => {
              capturedContext = getCurrentHookInvocationContext();
              return { status: "ok" };
            },
          }),
        ],
      });
      const hookContext = {
        rootInvocationId: "root-hook-1",
        depth: 1,
        chain: [
          {
            hookType: "lifecycle",
            appId: "app.recap",
            hookName: "agent-turn-finished",
          },
        ],
      };

      await runWithHookInvocationContext(hookContext, () => rome.actionEngine.run("ctx_hook", {}));

      expect(capturedContext).toEqual(hookContext);
    });

    it("delivers runtime events to the run observer", async () => {
      await setup({
        actions: [
          buildAction("streaming", {
            execute: async () => {
              emitAgentMessage({ type: "thinking", content: "working", agent: "main" });
              return { status: "ok" };
            },
          }),
        ],
      });
      const events: ActionRuntimeEvent[] = [];

      await rome.actionEngine.run("streaming", {}, undefined, {
        onRuntimeEvent: (event) => {
          events.push(event);
        },
      });

      expect(events).toEqual([
        {
          type: "agent_message",
          message: { type: "thinking", content: "working", agent: "main" },
        },
      ]);
    });

    it("inherits the runtime observer across nested actions", async () => {
      await setup({
        actions: [
          buildAction("child_stream", {
            execute: async () => {
              emitAgentMessage({
                type: "tool_result",
                toolUseId: "tu-engine-1",
                tool: "lookup",
                output: { ok: true },
                agent: "main",
              });
              return { status: "ok" };
            },
          }),
          buildAction("parent_stream", {
            execute: async () => {
              emitAgentMessage({
                type: "tool_use",
                id: "tu-engine-1",
                tool: "lookup",
                input: { id: 1 },
                agent: "main",
              });
              await callAction("child_stream", {});
              return { status: "ok" };
            },
          }),
        ],
      });
      const events: ActionRuntimeEvent[] = [];

      await rome.actionEngine.run("parent_stream", {}, undefined, {
        onRuntimeEvent: (event) => {
          events.push(event);
        },
      });

      expect(events).toEqual([
        {
          type: "agent_message",
          message: {
            type: "tool_use",
            id: "tu-engine-1",
            tool: "lookup",
            input: { id: 1 },
            agent: "main",
          },
        },
        {
          type: "agent_message",
          message: {
            type: "tool_result",
            toolUseId: "tu-engine-1",
            tool: "lookup",
            output: { ok: true },
            agent: "main",
          },
        },
      ]);
    });

    it("sets up replayContext in record mode", async () => {
      let capturedReplay: unknown;
      await setup({
        actions: [
          buildAction("replay_check", {
            execute: async () => {
              capturedReplay = replayContext.getStore();
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("replay_check", {});
      expect(capturedReplay).toMatchObject({
        mode: "record",
        journal: [],
        replayIndex: 0,
        nextSequence: 0,
      });
    });

    it("persists journal to DB when sub-actions were recorded", async () => {
      await setup({
        actions: [
          buildAction("child", { execute: async () => ({ status: "ok", data: "child-result" }) }),
          buildAction("parent", {
            execute: async () => {
              await callAction("child", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("parent", {});

      const journal = await journalOf("parent");
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        actionName: "child",
        status: "completed",
        result: { status: "ok", data: "child-result" },
      });
    });

    it("does not persist journal when no sub-actions occurred", async () => {
      await setup({
        actions: [buildAction("solo", { execute: async () => ({ status: "ok" }) })],
      });

      await rome.actionEngine.run("solo", {});
      expect(await journalOf("solo")).toEqual([]);
    });

    it("logs execution to executionsRepo on success", async () => {
      await setup({
        actions: [buildAction("logged", { type: "custom" })],
      });

      await rome.actionEngine.run("logged", { key: "val" });

      const rows = await rome.repos.actionExecutions.findByAction("logged");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionName: "logged",
        actionType: "custom",
        status: "success",
        args: { key: "val" },
      });
      expect(rows[0].finishedAt).not.toBeNull();
    });

    it("records the execution duration measured on the engine clock", async () => {
      const clock = new FakeClock(new Date("2026-01-15T10:00:00Z"));
      await setup({
        actions: [
          buildAction("slow", {
            execute: async () => {
              // Whole seconds: the timestamp columns are second-precision.
              await clock.advance("2s");
              return { status: "ok" };
            },
          }),
        ],
        engine: { clock },
      });

      await rome.actionEngine.run("slow", {});

      const [row] = await rome.repos.actionExecutions.findByAction("slow");
      expect(row.startedAt).toEqual(new Date("2026-01-15T10:00:00Z"));
      expect(row.finishedAt).toEqual(new Date("2026-01-15T10:00:02Z"));
      expect(row.durationMs).toBe(2000);
    });

    it("stamps the ambient session actor on root and nested execution rows", async () => {
      const actor: SessionActor = {
        kind: "guardian",
        userId: "seat-1",
        email: "guardian@example.com",
        via: "cookie",
      };
      await setup({
        actions: [
          buildAction("audited-child", { execute: async () => ({ status: "ok" }) }),
          buildAction("audited-root", {
            execute: async () => {
              const r = await callAction("audited-child", {});
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok" };
            },
          }),
        ],
      });

      await runWithSessionActor(actor, () => rome.actionEngine.run("audited-root", {}));

      const [root] = await rome.repos.actionExecutions.findByAction("audited-root");
      const [child] = await rome.repos.actionExecutions.findByAction("audited-child");
      expect(root.actor).toEqual(actor);
      expect(child.actor).toEqual(actor);
    });

    it("prefers an explicit context actor over the ambient one", async () => {
      const ambient: SessionActor = { kind: "anonymous" };
      const explicit: SessionActor = { kind: "visitor", accountId: "a-1", email: "v@example.com" };
      await setup({ actions: [buildAction("explicit-actor")] });

      await runWithSessionActor(ambient, () =>
        rome.actionEngine.run("explicit-actor", {}, { actor: explicit }),
      );

      const [row] = await rome.repos.actionExecutions.findByAction("explicit-actor");
      expect(row.actor).toEqual(explicit);
    });

    it("leaves actor null when no session context exists", async () => {
      await setup({ actions: [buildAction("no-actor")] });

      await rome.actionEngine.run("no-actor", {}, { initiator: "agent:main" });

      const [row] = await rome.repos.actionExecutions.findByAction("no-actor");
      expect(row.actor).toBeNull();
    });

    it("re-stamps the approver on the reused root row when an approval is replayed", async () => {
      const visitor: SessionActor = {
        kind: "visitor",
        accountId: "acct-v",
        email: "visitor@example.com",
      };
      const guardian: SessionActor = {
        kind: "guardian",
        userId: "seat-1",
        email: "guardian@example.com",
        via: "cookie",
      };
      await setup({
        actions: [
          buildAction("approved-child", { execute: async () => ({ status: "ok" }) }),
          buildAction("guarded-root", {
            requiresApproval: true,
            execute: async () => {
              const r = await callAction("approved-child", {});
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok" };
            },
          }),
        ],
      });

      // Visitor triggers the sensitive root: it short-circuits pending.
      const first = await runWithSessionActor(visitor, () =>
        rome.actionEngine.run("guarded-root", {}),
      );
      if (first.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${first.status}`);
      }
      const [pendingRow] = await rome.repos.actionExecutions.findByAction("guarded-root");
      expect(pendingRow.status).toBe("pending_approval");
      expect(pendingRow.actor).toEqual(visitor);

      // Replay exactly as ApprovalHandler does — same journal, same execution
      // id — but inside the approver's session scope.
      const approval = await rome.repos.approvals.findById(first.approval.approvalId);
      const payload = approval!.payload as {
        rootActionName: string;
        rootArgs: Record<string, unknown>;
        rootExecutionId: string;
        replayJournal: JournalEntry[];
      };
      const replayed = await runWithSessionActor(guardian, () =>
        rome.actionEngine.run(payload.rootActionName, payload.rootArgs, {
          initiator: `approval:${first.approval.approvalId}`,
          replayJournal: payload.replayJournal,
          replayRootExecutionId: payload.rootExecutionId,
        }),
      );
      if (replayed.status !== "ok") throw new Error(`expected ok, got ${replayed.status}`);

      // The reused root row and the freshly executed child both carry the
      // approver, so the tree attributes the run to one accountable session.
      const root = await rome.repos.actionExecutions.findById(payload.rootExecutionId);
      expect(root!.status).toBe("success");
      expect(root!.actor).toEqual(guardian);
      const [child] = await rome.repos.actionExecutions.findByAction("approved-child");
      expect(child.actor).toEqual(guardian);
    });

    it("restores the requester into an actorless approval replay (root kept, children inherit)", async () => {
      const visitor: SessionActor = {
        kind: "visitor",
        accountId: "acct-v",
        email: "visitor@example.com",
      };
      await setup({
        actions: [
          buildAction("solo-child", { execute: async () => ({ status: "ok" }) }),
          buildAction("guarded-solo", {
            requiresApproval: true,
            execute: async () => {
              const r = await callAction("solo-child", {});
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok" };
            },
          }),
        ],
      });

      const first = await runWithSessionActor(visitor, () =>
        rome.actionEngine.run("guarded-solo", {}),
      );
      if (first.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${first.status}`);
      }

      // Approval granted outside any HTTP/WS scope (e.g. a channel flow): the
      // requester stays on the reused root row rather than being wiped to
      // null, and is inherited by children executed during the replay.
      const approval = await rome.repos.approvals.findById(first.approval.approvalId);
      const payload = approval!.payload as {
        rootActionName: string;
        rootArgs: Record<string, unknown>;
        rootExecutionId: string;
        replayJournal: JournalEntry[];
      };
      const replayed = await rome.actionEngine.run(payload.rootActionName, payload.rootArgs, {
        initiator: `approval:${first.approval.approvalId}`,
        replayJournal: payload.replayJournal,
        replayRootExecutionId: payload.rootExecutionId,
      });
      if (replayed.status !== "ok") throw new Error(`expected ok, got ${replayed.status}`);

      const root = await rome.repos.actionExecutions.findById(payload.rootExecutionId);
      expect(root!.status).toBe("success");
      expect(root!.actor).toEqual(visitor);
      const [child] = await rome.repos.actionExecutions.findByAction("solo-child");
      expect(child.actor).toEqual(visitor);
    });

    it("logs execution to executionsRepo on error", async () => {
      await setup({
        actions: [
          buildAction("fail", {
            execute: async () => {
              throw new Error("boom");
            },
          }),
        ],
      });

      await expect(rome.actionEngine.run("fail", {})).rejects.toThrow("boom");

      const rows = await rome.repos.actionExecutions.findByAction("fail");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionName: "fail",
        status: "error",
        error: "boom",
      });
    });

    it("runs nested cancellable actions in a subprocess", async () => {
      const childExecute = rs.fn(
        async (): Promise<ActionResult> => ({ status: "ok", data: "in-process" }),
      );
      await setup({
        actions: [
          buildAction("child", { cancellable: true, execute: childExecute }),
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child", { x: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });
      const executeInSubprocess = rs
        .spyOn(rome.actionEngine as unknown as SubprocessEngine, "executeInSubprocess")
        .mockResolvedValue({ status: "ok", data: "child-result" });

      const result = await rome.actionEngine.run("parent", {});

      expect(result).toEqual({ status: "ok", data: "child-result" });
      expect(executeInSubprocess).toHaveBeenCalledTimes(1);
      expect(childExecute).not.toHaveBeenCalled();
    });

    it("passes the runtime observer through the subprocess path", async () => {
      await setup({
        actions: [buildAction("root_stream")],
        engine: { processRole: "main" },
      });
      rs.spyOn(
        rome.actionEngine as unknown as SubprocessEngine,
        "executeInSubprocess",
      ).mockImplementation(async (...args: unknown[]) => {
        const observer = args[1] as { onRuntimeEvent?: (event: unknown) => void } | undefined;
        observer?.onRuntimeEvent?.({
          type: "agent_message",
          message: { type: "thinking", content: "subprocess", agent: "main" },
        });
        return { status: "ok" };
      });
      const events: ActionRuntimeEvent[] = [];

      await rome.actionEngine.run("root_stream", {}, undefined, {
        onRuntimeEvent: (event) => {
          events.push(event);
        },
      });

      expect(events).toEqual([
        {
          type: "agent_message",
          message: { type: "thinking", content: "subprocess", agent: "main" },
        },
      ]);
    });

    it("preserves pending_approval when a subprocess returns it", async () => {
      await setup({
        actions: [buildAction("root")],
        engine: { processRole: "main" },
      });
      rs.spyOn(
        rome.actionEngine as unknown as SubprocessEngine,
        "executeInSubprocess",
      ).mockResolvedValue({
        status: "pending_approval",
        approval: {
          approvalId: "approval-1",
          actionName: "child",
          description: "child requires approval",
        },
      });

      const result = await rome.actionEngine.run("root", { x: 1 });

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(result.approval).toMatchObject({
        approvalId: "approval-1",
        actionName: "child",
      });
      // The root execution row stays parked: pending_approval, not finished.
      const rows = await rome.repos.actionExecutions.findByAction("root");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "pending_approval", error: null });
      expect(rows[0].finishedAt).toBeNull();
    });

    it("marks running descendants as errored when a root worker crashes", async () => {
      await setup({
        actions: [buildAction("root")],
        engine: { processRole: "main" },
      });
      // The fake worker leaves a descendant row mid-flight, then crashes.
      rs.spyOn(
        rome.actionEngine as unknown as SubprocessEngine,
        "executeInSubprocess",
      ).mockImplementation(async (...args: unknown[]) => {
        const invocation = args[0] as { rootExecutionId: string };
        await rome.repos.actionExecutions.create({
          id: "descendant-1",
          rootExecutionId: invocation.rootExecutionId,
          actionName: "descendant",
          status: "running",
        });
        throw new Error("worker crashed");
      });

      await expect(rome.actionEngine.run("root", { x: 1 })).rejects.toThrow("worker crashed");

      const [rootRow] = await rome.repos.actionExecutions.findByAction("root");
      expect(rootRow).toMatchObject({ status: "error", error: "worker crashed" });
      expect(rootRow.finishedAt).not.toBeNull();
      expect(rootRow.durationMs).toEqual(expect.any(Number));

      const descendant = await rome.repos.actionExecutions.findById("descendant-1");
      expect(descendant).toMatchObject({ status: "error", error: "worker crashed" });
    });
  });

  // run() — root call, action requires approval
  describe("run() — root call, action requires approval", () => {
    it("creates a pending approval row and returns pending_approval result when root action requires approval", async () => {
      await setup({ actions: [buildAction("risky", { requiresApproval: true })] });

      const result = await rome.actionEngine.run("risky", { target: "prod" });

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(result.approval.actionName).toBe("risky");

      const row = await rome.repos.approvals.findById(result.approval.approvalId);
      expect(row).toMatchObject({ type: "action_execution", status: "pending" });
      expect(row!.payload).toMatchObject({ actionName: "risky", args: { target: "prod" } });
    });

    it("persists journal with pending_approval entry", async () => {
      await setup({ actions: [buildAction("risky", { requiresApproval: true })] });

      await rome.actionEngine.run("risky", { x: 1 });

      const journal = await journalOf("risky");
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ actionName: "risky", status: "pending_approval" });
    });

    it("includes channel context, shared context, and session info in approval payload", async () => {
      await setup({ actions: [buildAction("risky", { requiresApproval: true })] });

      const context: ActionRunContext = {
        initiator: "channel:telegram",
        channelContext: {
          channel: "telegram",
          threadId: "t-1",
          channelUserId: "u-1",
          projectName: "alpha",
        },
        sharedContext: {
          requestId: "req-approval",
          selectedProjectPath: "/tmp/projects/alpha",
        },
        sessionId: "sess-1",
        agentName: "main",
      };
      const result = await rome.actionEngine.run("risky", { target: "prod" }, context);

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      const row = await rome.repos.approvals.findById(result.approval.approvalId);
      expect(row!.payload).toMatchObject({
        channelContext: context.channelContext,
        sharedContext: context.sharedContext,
        sessionId: "sess-1",
        agentName: "main",
      });
    });

    it("fires onApprovalCreated with the approval id, action args, and channel context", async () => {
      const created: ApprovalCreatedEvent[] = [];
      await setup({
        actions: [buildAction("risky", { requiresApproval: true })],
        engine: {
          onApprovalCreated: async (event) => {
            created.push(event);
          },
        },
      });

      const result = await rome.actionEngine.run(
        "risky",
        { target: "prod" },
        {
          channelContext: {
            channel: "webchat",
            threadId: "t-9",
            channelUserId: "u-9",
          },
        },
      );

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(created).toEqual([
        {
          approvalId: result.approval.approvalId,
          actionName: "risky",
          args: { target: "prod" },
          preview: undefined,
          channelContext: {
            channel: "webchat",
            threadId: "t-9",
            channelUserId: "u-9",
          },
        },
      ]);
    });

    it("invokes the action's preview() renderer and forwards the payload to onApprovalCreated", async () => {
      const previewArgs: Record<string, unknown>[] = [];
      const risky: Action = {
        ...buildAction("risky", { requiresApproval: true }),
        preview: (args) => {
          previewArgs.push(args);
          return {
            kind: "generic" as const,
            title: "Risky Thing",
            summary: `target=${String(args.target)}`,
          };
        },
      };
      const created: ApprovalCreatedEvent[] = [];
      await setup({
        actions: [risky],
        engine: {
          onApprovalCreated: async (event) => {
            created.push(event);
          },
        },
      });

      await rome.actionEngine.run("risky", { target: "prod" });

      expect(previewArgs).toEqual([{ target: "prod" }]);
      expect(created).toHaveLength(1);
      expect(created[0].preview).toEqual({
        kind: "generic",
        title: "Risky Thing",
        summary: "target=prod",
      });
    });

    it("forwards reason from sensitive_message preview through onApprovalCreated", async () => {
      const sendSensitive: Action = {
        ...buildAction("send_sensitive", { requiresApproval: true, sideEffects: "write" }),
        preview: (args: Record<string, unknown>) => ({
          kind: "sensitive_message" as const,
          channel: String(args.channel),
          threadId: String(args.threadId),
          text: String(args.text),
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        }),
      };
      const created: ApprovalCreatedEvent[] = [];
      await setup({
        actions: [sendSensitive],
        engine: {
          onApprovalCreated: async (event) => {
            created.push(event);
          },
        },
      });

      await rome.actionEngine.run("send_sensitive", {
        channel: "telegram",
        threadId: "t-1",
        text: "be cool",
        reason: "preempt awkwardness",
      });

      expect(created).toHaveLength(1);
      expect(created[0].preview).toEqual({
        kind: "sensitive_message",
        channel: "telegram",
        threadId: "t-1",
        text: "be cool",
        reason: "preempt awkwardness",
      });
    });

    it("does not fail the run when onApprovalCreated throws", async () => {
      await setup({
        actions: [buildAction("risky", { requiresApproval: true })],
        engine: {
          onApprovalCreated: async () => {
            throw new Error("callback boom");
          },
        },
      });

      const result = await rome.actionEngine.run("risky", {});

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      const row = await rome.repos.approvals.findById(result.approval.approvalId);
      expect(row!.status).toBe("pending");
    });
  });

  // run() — nested call, record mode
  describe("run() — nested call, record mode", () => {
    it("inherits and merges sharedContext for nested actions", async () => {
      let childContext: Record<string, unknown> | undefined;
      await setup({
        actions: [
          buildAction("child", {
            execute: async () => {
              childContext = actionExecutionContext.getStore()?.sharedContext;
              return { status: "ok", data: "done" };
            },
          }),
          buildAction("parent", {
            execute: async () => {
              const child = await callAction("child", { k: "v" });
              if (child.status !== "ok") throw new Error(`expected ok, got ${child.status}`);
              return { status: "ok", data: child.data };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run(
        "parent",
        {},
        {
          sharedContext: {
            requestId: "req-root",
            tenantId: "tenant-alpha",
          },
        },
      );

      expect(result).toEqual({ status: "ok", data: "done" });
      expect(childContext).toEqual({
        requestId: "req-root",
        tenantId: "tenant-alpha",
      });
    });

    it("records completed sub-action in journal", async () => {
      await setup({
        actions: [
          buildAction("child", { execute: async () => ({ status: "ok", data: "done" }) }),
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child", { k: "v" });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run("parent", {});
      expect(result).toEqual({ status: "ok", data: "done" });

      const journal = await journalOf("parent");
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        actionName: "child",
        argsHash: hashArgs({ k: "v" }),
        status: "completed",
        result: { status: "ok", data: "done" },
      });
    });

    it("creates approval record and surfaces pending_approval for nested requiresApproval action", async () => {
      await setup({
        actions: [
          buildAction("needs_approval", { requiresApproval: true }),
          buildAction("parent", {
            execute: async () => {
              await callAction("needs_approval", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run("parent", {});

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(result.approval.actionName).toBe("needs_approval");

      const row = await rome.repos.approvals.findById(result.approval.approvalId);
      expect(row).toMatchObject({ type: "action_execution", status: "pending" });
    });

    it("returns pending_approval as the ActionResult from callAction, not an exception", async () => {
      let childResult: ActionResult | undefined;
      await setup({
        actions: [
          buildAction("needs_approval", { requiresApproval: true }),
          buildAction("parent", {
            execute: async () => {
              childResult = await callAction("needs_approval", { x: 1 });
              return { status: "ok", data: "parent-reached-return" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("parent", {});
      expect(childResult).toBeDefined();
      if (childResult?.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${childResult?.status}`);
      }
      expect(childResult.approval.actionName).toBe("needs_approval");
    });

    it("creates approval payload with root action name, args, replay journal, and channel context", async () => {
      await setup({
        actions: [
          buildAction("needs_approval", { requiresApproval: true }),
          buildAction("parent", {
            execute: async () => {
              await callAction("needs_approval", { target: "prod" });
              return { status: "ok" };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run(
        "parent",
        { launch: true },
        {
          channelContext: {
            channel: "webchat",
            threadId: "t-1",
            channelUserId: "u-1",
          },
          sessionId: "sess-7",
          agentName: "main",
          channelThreadKey: "webchat:t-1",
        },
      );

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      const row = await rome.repos.approvals.findById(result.approval.approvalId);
      const payload = row!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        actionName: "needs_approval",
        args: { target: "prod" },
        rootActionName: "parent",
        rootArgs: { launch: true },
        channelContext: { channel: "webchat", threadId: "t-1", channelUserId: "u-1" },
        sessionId: "sess-7",
        agentName: "main",
        channelThreadKey: "webchat:t-1",
      });
      expect(Array.isArray(payload.replayJournal)).toBe(true);
      expect((payload.replayJournal as unknown[]).length).toBeGreaterThan(0);
    });

    it("fires onApprovalCreated with preview for a nested requiresApproval action", async () => {
      const needsApproval: Action = {
        ...buildAction("needs_approval", { requiresApproval: true }),
        preview: () => ({
          kind: "generic" as const,
          title: "Nested",
          summary: "nested approval card",
        }),
      };
      const created: ApprovalCreatedEvent[] = [];
      await setup({
        actions: [
          needsApproval,
          buildAction("parent", {
            execute: async () => {
              await callAction("needs_approval", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
        engine: {
          onApprovalCreated: async (event) => {
            created.push(event);
          },
        },
      });

      const result = await rome.actionEngine.run(
        "parent",
        {},
        {
          channelContext: { channel: "webchat", threadId: "t-2", channelUserId: "u-2" },
        },
      );

      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(created).toEqual([
        {
          approvalId: result.approval.approvalId,
          actionName: "needs_approval",
          args: { x: 1 },
          preview: { kind: "generic", title: "Nested", summary: "nested approval card" },
          channelContext: { channel: "webchat", threadId: "t-2", channelUserId: "u-2" },
        },
      ]);
    });

    it("records pending_approval entry in journal for requiresApproval sub-action", async () => {
      await setup({
        actions: [
          buildAction("needs_approval", { requiresApproval: true }),
          buildAction("parent", {
            execute: async () => {
              await callAction("needs_approval", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("parent", {});

      const journal = await journalOf("parent");
      expect(journal.some((e) => e.status === "pending_approval")).toBe(true);
    });

    it("sibling actions after a pending approval still execute in the same turn", async () => {
      const a = recordingAction("a");
      const c = recordingAction("c");
      await setup({
        actions: [
          a.action,
          buildAction("b", { requiresApproval: true }),
          c.action,
          buildAction("parent", {
            execute: async () => {
              await callAction("a", { id: 1 });
              await callAction("b", { id: 2 });
              await callAction("c", { id: 3 });
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("parent", {});

      expect(a.calls).toEqual([{ id: 1 }]);
      expect(c.calls).toEqual([{ id: 3 }]);

      const journal = await journalOf("parent");
      expect(journal.map((e) => e.actionName)).toEqual(["a", "b", "c"]);
      expect(journal.map((e) => e.status)).toEqual(["completed", "pending_approval", "completed"]);
    });

    it("increments sequence numbers for each nested call", async () => {
      await setup({
        actions: [
          buildAction("a"),
          buildAction("b"),
          buildAction("parent", {
            execute: async () => {
              await callAction("a", {});
              await callAction("b", {});
              return { status: "ok" };
            },
          }),
        ],
      });

      await rome.actionEngine.run("parent", {});

      const journal = await journalOf("parent");
      expect(journal).toHaveLength(2);
      expect(journal[0].sequence).toBe(0);
      expect(journal[1].sequence).toBe(1);
    });

    it("executes and records multiple sub-actions in sequence", async () => {
      await setup({
        actions: [
          buildAction("a", { execute: async () => ({ status: "ok", data: "A" }) }),
          buildAction("b", { execute: async () => ({ status: "ok", data: "B" }) }),
          buildAction("parent", {
            execute: async () => {
              const rA = await callAction("a", { id: 1 });
              const rB = await callAction("b", { id: 2 });
              if (rA.status !== "ok") throw new Error(`expected ok, got ${rA.status}`);
              if (rB.status !== "ok") throw new Error(`expected ok, got ${rB.status}`);
              return { status: "ok", data: [rA.data, rB.data] };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run("parent", {});
      expect(result).toEqual({ status: "ok", data: ["A", "B"] });

      const journal = await journalOf("parent");
      expect(journal).toHaveLength(2);
      expect(journal[0].actionName).toBe("a");
      expect(journal[1].actionName).toBe("b");
    });
  });

  // run() — nested call, replay mode, matching entries
  describe("run() — nested call, replay mode, matching entries", () => {
    it("returns cached result for completed journal entry (skips execution)", async () => {
      const child = recordingAction("child", {
        execute: async () => ({ status: "ok", data: "fresh" }),
      });
      await setup({
        actions: [
          child.action,
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child", { x: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: { status: "ok", data: "cached" },
          status: "completed",
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.data).toBe("cached");
      expect(child.calls).toEqual([]);
    });

    it("executes pending_approval entry for real and returns result", async () => {
      const child = recordingAction("child", {
        execute: async () => ({ status: "ok", data: "executed" }),
      });
      await setup({
        actions: [
          child.action,
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child", { x: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.data).toBe("executed");
      expect(child.calls).toEqual([{ x: 1 }]);
    });

    it("switches to record mode after executing pending_approval entry", async () => {
      let modeAfterApproval: string | undefined;
      await setup({
        actions: [
          buildAction("child"),
          buildAction("child_new", {
            execute: async () => {
              modeAfterApproval = replayContext.getStore()?.mode;
              return { status: "ok" };
            },
          }),
          buildAction("parent", {
            execute: async () => {
              await callAction("child", { x: 1 });
              await callAction("child_new", { y: 2 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ];

      await rome.actionEngine.run("parent", {}, { replayJournal });
      expect(modeAfterApproval).toBe("record");
    });

    it("updates the persisted journal entry after executing pending_approval", async () => {
      await setup({
        actions: [
          buildAction("child", { execute: async () => ({ status: "ok", data: "done" }) }),
          buildAction("parent", {
            execute: async () => {
              await callAction("child", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const rootExecutionId = "replay-root-1";
      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ];
      // The journal a prior record-mode run would have left behind.
      await rome.repos.executionJournal.saveJournal(rootExecutionId, replayJournal);

      await rome.actionEngine.run(
        "parent",
        {},
        {
          replayJournal,
          replayRootExecutionId: rootExecutionId,
        },
      );

      const journal = await rome.repos.executionJournal.loadJournal(rootExecutionId);
      expect(journal[0]).toMatchObject({
        sequence: 0,
        actionName: "child",
        status: "completed",
        result: { status: "ok", data: "done" },
      });
      // The replayed execution is currently double-journaled: besides the
      // in-place update above, it is re-appended as a fresh completed entry.
      expect(journal).toHaveLength(2);
      expect(journal[1]).toMatchObject({
        sequence: 1,
        actionName: "child",
        status: "completed",
        result: { status: "ok", data: "done" },
      });
    });

    it("advances replayIndex after each matched entry", async () => {
      const a = recordingAction("a");
      const b = recordingAction("b", {
        execute: async () => ({ status: "ok", data: "B-fresh" }),
      });
      await setup({
        actions: [
          a.action,
          b.action,
          buildAction("parent", {
            execute: async () => {
              await callAction("a", {});
              const r = await callAction("b", { q: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "a",
          argsHash: hashArgs({}),
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "b",
          argsHash: hashArgs({ q: 1 }),
          args: { q: 1 },
          result: null,
          status: "pending_approval",
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      // "a" was cached (not re-executed), "b" was executed for real
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.data).toBe("B-fresh");
      expect(a.calls).toEqual([]);
      expect(b.calls).toEqual([{ q: 1 }]);
    });
  });

  // run() — nested call, replay mode, divergence
  describe("run() — nested call, replay mode, divergence", () => {
    it("records divergence entry when action name doesn't match", async () => {
      await setup({
        actions: [
          buildAction("child_x", { execute: async () => ({ status: "ok", data: "X" }) }),
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child_x", { a: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const rootExecutionId = "replay-root-name-div";
      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child_y",
          argsHash: hashArgs({ a: 1 }),
          args: { a: 1 },
          result: { status: "ok" },
          status: "completed",
        },
      ];

      await rome.actionEngine.run(
        "parent",
        {},
        {
          replayJournal,
          replayRootExecutionId: rootExecutionId,
        },
      );

      const journal = await rome.repos.executionJournal.loadJournal(rootExecutionId);
      const diverged = journal.find((e) => e.status === "diverged");
      expect(diverged).toBeDefined();
      expect(diverged!.expectedActionName).toBe("child_y");
      expect(diverged!.actualActionName).toBe("child_x");
      // The actual call was then recorded fresh.
      expect(journal.some((e) => e.actionName === "child_x" && e.status === "completed")).toBe(
        true,
      );
    });

    it("records divergence entry when argsHash doesn't match", async () => {
      await setup({
        actions: [
          buildAction("child"),
          buildAction("parent", {
            execute: async () => {
              await callAction("child", { a: 2 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const rootExecutionId = "replay-root-args-div";
      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ a: 1 }), // different from { a: 2 }
          args: { a: 1 },
          result: { status: "ok" },
          status: "completed",
        },
      ];

      await rome.actionEngine.run(
        "parent",
        {},
        {
          replayJournal,
          replayRootExecutionId: rootExecutionId,
        },
      );

      const journal = await rome.repos.executionJournal.loadJournal(rootExecutionId);
      const diverged = journal.find((e) => e.status === "diverged");
      expect(diverged).toBeDefined();
      expect(diverged!.expectedArgsHash).toBe(hashArgs({ a: 1 }));
      expect(diverged!.actualArgsHash).toBe(hashArgs({ a: 2 }));
    });

    it("switches to record mode on divergence in fallthrough mode (default)", async () => {
      let capturedMode: string | undefined;
      await setup({
        actions: [
          buildAction("child_x", {
            execute: async () => {
              capturedMode = replayContext.getStore()?.mode;
              return { status: "ok" };
            },
          }),
          buildAction("parent", {
            execute: async () => {
              await callAction("child_x", {});
              return { status: "ok" };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child_y",
          argsHash: hashArgs({}),
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ];

      await rome.actionEngine.run("parent", {}, { replayJournal });
      expect(capturedMode).toBe("record");
    });

    it("continues execution normally after fallthrough divergence", async () => {
      await setup({
        actions: [
          buildAction("child_x", { execute: async () => ({ status: "ok", data: "X-result" }) }),
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child_x", {});
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child_y",
          argsHash: hashArgs({}),
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      expect(result).toEqual({ status: "ok", data: "X-result" });
    });

    it("skips previously diverged entry and switches to record mode", async () => {
      const child = recordingAction("child_x", {
        execute: async () => ({ status: "ok", data: "fresh" }),
      });
      await setup({
        actions: [
          child.action,
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child_x", { a: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child_x",
          argsHash: hashArgs({ a: 1 }),
          args: { a: 1 },
          result: null,
          status: "diverged",
          expectedActionName: "child_y",
          expectedArgsHash: hashArgs({ a: 1 }),
          actualActionName: "child_x",
          actualArgsHash: hashArgs({ a: 1 }),
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      // Should execute for real (record mode) and return fresh result
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.data).toBe("fresh");
      expect(child.calls).toEqual([{ a: 1 }]);
    });

    it("handles divergence when replay journal is exhausted (EOF)", async () => {
      await setup({
        actions: [
          buildAction("child_x", { execute: async () => ({ status: "ok", data: "X" }) }),
          buildAction("parent", {
            execute: async () => {
              const r = await callAction("child_x", { a: 1 });
              if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
              return { status: "ok", data: r.data };
            },
          }),
        ],
      });

      const rootExecutionId = "replay-root-eof";
      // Empty replay journal — any nested call is a divergence (EOF)
      const result = await rome.actionEngine.run(
        "parent",
        {},
        {
          replayJournal: [],
          replayRootExecutionId: rootExecutionId,
        },
      );
      expect(result).toEqual({ status: "ok", data: "X" });

      const journal = await rome.repos.executionJournal.loadJournal(rootExecutionId);
      const diverged = journal.find((e) => e.status === "diverged");
      expect(diverged).toBeDefined();
      expect(diverged!.expectedActionName).toBe("EOF");
    });
  });

  // run() — replay mode root call
  describe("run() — replay mode root call", () => {
    it("loads replay journal and starts in replay mode", async () => {
      let capturedMode: string | undefined;
      await setup({
        actions: [
          buildAction("child"),
          buildAction("parent", {
            execute: async () => {
              // Capture mode BEFORE making any nested calls that may switch it
              capturedMode = replayContext.getStore()?.mode;
              await callAction("child", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const journal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ];

      await rome.actionEngine.run("parent", {}, { replayJournal: journal });
      expect(capturedMode).toBe("replay");
    });

    it("reuses replayRootExecutionId when provided", async () => {
      let capturedRootId: string | undefined;
      await setup({
        actions: [
          buildAction("child"),
          buildAction("parent", {
            execute: async () => {
              capturedRootId = replayContext.getStore()?.rootExecutionId;
              await callAction("child", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const journal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ];

      await rome.actionEngine.run(
        "parent",
        {},
        {
          replayJournal: journal,
          replayRootExecutionId: "original-exec-id",
        },
      );

      expect(capturedRootId).toBe("original-exec-id");
      // The replayed run is recorded under the original execution id.
      const row = await rome.repos.actionExecutions.findById("original-exec-id");
      expect(row).toMatchObject({ actionName: "parent", status: "success" });
    });

    it("sets nextSequence past existing journal entries", async () => {
      let capturedNextSeq: number | undefined;
      await setup({
        actions: [
          buildAction("child"),
          buildAction("parent", {
            execute: async () => {
              capturedNextSeq = replayContext.getStore()?.nextSequence;
              await callAction("child", { x: 1 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const journal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "child",
          argsHash: hashArgs({ x: 1 }),
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
        {
          sequence: 5,
          actionName: "other",
          argsHash: hashArgs({}),
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ];

      await rome.actionEngine.run("parent", {}, { replayJournal: journal });
      // nextSequence should be max(0, 5) + 1 = 6
      expect(capturedNextSeq).toBe(6);
    });
  });

  // end-to-end action chains
  describe("end-to-end action chains", () => {
    it("parent calls A (ok) → B (approval) → journal has 2 entries, returns pending_approval", async () => {
      await setup({
        actions: [
          buildAction("a", { execute: async () => ({ status: "ok", data: "A" }) }),
          buildAction("b", { requiresApproval: true }),
          buildAction("parent", {
            execute: async () => {
              await callAction("a", { id: 1 });
              await callAction("b", { id: 2 });
              return { status: "ok" };
            },
          }),
        ],
      });

      const result = await rome.actionEngine.run("parent", {});
      if (result.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${result.status}`);
      }
      expect(result.approval.actionName).toBe("b");

      const journal = await journalOf("parent");
      expect(journal).toHaveLength(2);
      expect(journal[0]).toMatchObject({ actionName: "a", status: "completed" });
      expect(journal[1]).toMatchObject({ actionName: "b", status: "pending_approval" });
    });

    it("replay: parent calls A (cached) → B (executes) → C (new, recorded) → completes", async () => {
      const a = recordingAction("a", { execute: async () => ({ status: "ok", data: "A" }) });
      const b = recordingAction("b", { execute: async () => ({ status: "ok", data: "B" }) });
      const c = recordingAction("c", { execute: async () => ({ status: "ok", data: "C" }) });
      await setup({
        actions: [
          a.action,
          b.action,
          c.action,
          buildAction("parent", {
            execute: async () => {
              const rA = await callAction("a", { id: 1 });
              const rB = await callAction("b", { id: 2 });
              const rC = await callAction("c", { id: 3 });
              if (rA.status !== "ok") throw new Error(`expected ok, got ${rA.status}`);
              if (rB.status !== "ok") throw new Error(`expected ok, got ${rB.status}`);
              if (rC.status !== "ok") throw new Error(`expected ok, got ${rC.status}`);
              return { status: "ok", data: [rA.data, rB.data, rC.data] };
            },
          }),
        ],
      });

      const replayJournal: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "a",
          argsHash: hashArgs({ id: 1 }),
          args: { id: 1 },
          result: { status: "ok", data: "A-cached" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "b",
          argsHash: hashArgs({ id: 2 }),
          args: { id: 2 },
          result: null,
          status: "pending_approval",
        },
      ];

      const result = await rome.actionEngine.run("parent", {}, { replayJournal });
      expect(result).toEqual({
        status: "ok",
        data: ["A-cached", "B", "C"],
      });

      // A should NOT have been executed (cached)
      expect(a.calls).toEqual([]);
      // B should have been executed (previously pending_approval)
      expect(b.calls).toEqual([{ id: 2 }]);
      // C should have been executed (new, recorded)
      expect(c.calls).toEqual([{ id: 3 }]);
    });
  });
});
