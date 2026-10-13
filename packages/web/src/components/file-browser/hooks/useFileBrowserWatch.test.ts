// @rstest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { LiveEventsClient } from "@/lib/live-events";
import { asWebSocket, FakeWebSocket } from "@/test/fake-websocket";
import { useFileBrowserWatch } from "./useFileBrowserWatch";

const testState = rs.hoisted(() => ({
  config: { apiBasePath: "/api/projects", logicalRootPath: "projects" },
  tree: { loadRoot: rs.fn().mockResolvedValue([]) },
  selection: {
    selectedPath: null as string | null,
    selectedFolderPath: "projects" as string | null,
  },
  file: {
    hasUnsavedEdits: rs.fn().mockReturnValue(false),
    loadFile: rs.fn().mockResolvedValue("loaded"),
    isSelfOriginatedWatchEvent: rs.fn().mockReturnValue(false),
  },
  watch: { clearDeletedSelection: rs.fn() },
}));

rs.mock("../store/context", () => ({
  useFileBrowserStoreApi: () => ({ getState: () => testState }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly withCredentials: boolean;
  readonly close = rs.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    readonly url: string,
    init?: EventSourceInit,
  ) {
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type WatchProps = { apiBasePath: string; watchPaths: string[] };

const projectsWatch: WatchProps = { apiBasePath: "/api/projects", watchPaths: ["projects"] };

function renderWatch(live: LiveEventsClient, initialProps: WatchProps = projectsWatch) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(LiveEventsClientContext.Provider, { value: live }, children);
  return renderHook((props: WatchProps) => useFileBrowserWatch(props), { initialProps, wrapper });
}

function socketClient(): LiveEventsClient {
  return new LiveEventsClient({
    WebSocket: asWebSocket,
    url: () => "ws://rome.test/ws/events",
    reconnectDelayMs: () => 100,
    minFallbackMs: 0,
  });
}

type SubscribeFrame = { type: string; topic: string; params?: unknown };

describe("useFileBrowserWatch", () => {
  beforeEach(() => {
    rs.useFakeTimers();
    FakeWebSocket.instances = [];
    MockEventSource.instances = [];
    testState.selection.selectedPath = null;
    testState.selection.selectedFolderPath = "projects";
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    rs.useRealTimers();
    rs.unstubAllGlobals();
    rs.clearAllMocks();
  });

  it("watches over the socket, opening no EventSource, and reconciles its events", async () => {
    testState.selection.selectedPath = "projects/notes.md";
    const { rerender, unmount } = renderWatch(socketClient());
    const socket = FakeWebSocket.latest();
    act(() => socket.open());
    const [subscribe] = socket.sent as SubscribeFrame[];
    expect(subscribe).toEqual({
      type: "subscribe",
      topic: expect.stringMatching(/^files\.watch:projects:/),
      params: { watch: ["projects"] },
    });
    act(() => socket.receive({ type: "subscribed", topic: subscribe.topic }));

    await act(async () => {
      socket.receive({
        type: "event",
        topic: subscribe.topic,
        event: "ready",
        data: { at: 1, logicalRoot: "projects" },
      });
      await Promise.resolve();
    });
    expect(testState.tree.loadRoot).toHaveBeenCalledTimes(1);

    act(() =>
      socket.receive({
        type: "event",
        topic: subscribe.topic,
        event: "change",
        data: { at: 2, kind: "change", logicalRoot: "projects", path: "projects/notes.md" },
      }),
    );
    await act(async () => {
      await rs.advanceTimersByTimeAsync(150);
    });
    expect(testState.tree.loadRoot).toHaveBeenCalledTimes(2);
    expect(testState.file.loadFile).toHaveBeenCalledWith("projects/notes.md", {
      preserveDisplayedContent: true,
      preserveTreeSelection: true,
      syncUrl: false,
    });

    // A new path set is a new topic: the old one is withdrawn first.
    rerender({ apiBasePath: "/api/projects", watchPaths: ["projects", "projects/app"] });
    const [unsubscribe, resubscribe] = (socket.sent as SubscribeFrame[]).slice(1);
    expect(unsubscribe).toEqual({ type: "unsubscribe", topic: subscribe.topic });
    expect(resubscribe).toMatchObject({
      type: "subscribe",
      params: { watch: ["projects", "projects/app"] },
    });
    expect(resubscribe.topic).not.toBe(subscribe.topic);

    unmount();
    expect(socket.sent.at(-1)).toEqual({ type: "unsubscribe", topic: resubscribe.topic });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("streams the watch route when the socket never opens", () => {
    renderWatch(socketClient());
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => FakeWebSocket.latest().close());
      act(() => rs.advanceTimersByTime(100));
    }
    expect(MockEventSource.instances.map((source) => source.url)).toEqual([
      "/api/projects/events?watch=projects",
    ]);
  });

  it("keeps the share page's file API off the socket", () => {
    renderWatch(socketClient(), {
      apiBasePath: "/api/share/token/projects",
      watchPaths: ["projects"],
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(MockEventSource.instances.map((source) => source.url)).toEqual([
      "/api/share/token/projects/events?watch=projects",
    ]);
  });

  it("rebaselines the file tree when the watcher reports ready", async () => {
    rs.stubGlobal("WebSocket", undefined);
    const { unmount } = renderWatch(new LiveEventsClient());
    const source = MockEventSource.instances[0];
    expect(source.url).toBe("/api/projects/events?watch=projects");
    expect(source.withCredentials).toBe(true);

    await act(async () => {
      source.emit("ready", { at: 1, logicalRoot: "projects" });
      await Promise.resolve();
    });

    expect(testState.tree.loadRoot).toHaveBeenCalledWith({ preserveExpandedChildren: true });
    unmount();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("batches validated change events into tree and selected-file refreshes", async () => {
    testState.selection.selectedPath = "projects/notes.md";
    rs.stubGlobal("WebSocket", undefined);
    renderWatch(new LiveEventsClient());
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit("change", {
        at: 2,
        kind: "change",
        logicalRoot: "projects",
        path: "projects/notes.md",
      });
    });
    expect(testState.tree.loadRoot).not.toHaveBeenCalled();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(150);
    });

    expect(testState.tree.loadRoot).toHaveBeenCalledWith({ preserveExpandedChildren: true });
    expect(testState.file.loadFile).toHaveBeenCalledWith("projects/notes.md", {
      preserveDisplayedContent: true,
      preserveTreeSelection: true,
      syncUrl: false,
    });
  });
});
