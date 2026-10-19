// @rstest-environment jsdom
import { useEffect } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { SlotProvider } from "@/components/slot";
import { FreeGrid } from "./FreeGrid";
import { setActiveSession } from "./use-free-cells";

const mounted = rs.hoisted(() => rs.fn());
rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: [] }) }));
rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => ({ sessionName: null }),
}));
rs.mock("@/components/chat/Chat", () => ({ Chat: () => null }));
rs.mock("./AppWidget", () => ({
  AppWidget: ({ placementId }: { placementId: string }) => {
    useEffect(() => {
      mounted(placementId);
    }, [placementId]);
    return <iframe title="Seeded app" />;
  },
}));

function NavigationProbe({ withProject }: { withProject: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location-state">{JSON.stringify(location.state)}</output>
      <button
        type="button"
        onClick={() =>
          navigate("/chat", {
            state: {
              widgets: [{ type: "app", appId: "notes" }],
              ...(withProject ? { projectPath: "project" } : {}),
              futureKey: { keep: true },
            },
          })
        }
      >
        Open notes
      </button>
    </>
  );
}

function renderGrid(withProject = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={queryClient}>
        <SlotProvider>
          <FreeGrid />
          <NavigationProbe withProject={withProject} />
        </SlotProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  mounted.mockClear();
  rs.stubGlobal(
    "fetch",
    rs.fn((input: RequestInfo | URL) =>
      Promise.resolve(Response.json(String(input) === "/api/settings" ? {} : [])),
    ),
  );
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "tool-workspace") {
          this.callback(
            [{ target, contentRect: { width: 1200 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  setActiveSession("reset");
  setActiveSession(null);
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("FreeGrid navigation seeds", () => {
  it("places widgets once and consumes widget and project prefill without changing selection", async () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const iframe = screen.getByTitle("Seeded app");
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("location-state").textContent!)).toEqual({
        futureKey: { keep: true },
      }),
    );
    expect(screen.getByTitle("Seeded app")).toBe(iframe);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/layout"), expect.anything());
  });

  it.each([
    true,
    false,
  ])("reopens and selects the same widget navigation (project: %s)", async (withProject) => {
    renderGrid(withProject);
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const first = screen.getByTitle("Seeded app");
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close notes" }));
    expect(screen.queryByTitle("Seeded app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(2));
    expect(screen.getByTitle("Seeded app")).not.toBe(first);
    expect(mounted.mock.calls[1][0]).not.toBe(mounted.mock.calls[0][0]);
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
    expect(JSON.parse(screen.getByTestId("location-state").textContent!)).toEqual({
      futureKey: { keep: true },
    });
  });
});
