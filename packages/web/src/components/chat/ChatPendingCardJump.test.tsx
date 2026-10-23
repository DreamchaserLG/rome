// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { ChatPendingCardJump } from "./ChatPendingCardJump";
import { RoutineDraftCard } from "./entries/RoutineDraftCard";
import { QuestionCard } from "./entries/QuestionCard";
import { createRoutine, listRoutineRefs } from "@/lib/chat-api";
import "@/i18n";

rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineRefs: rs.fn(),
}));

let cardTop = -200;
const scrollTo = rs.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

function Harness({ questionResult }: { questionResult?: Record<string, unknown> }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [floor, setFloor] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <div ref={setScroller} data-testid="scroller">
        <div ref={setContent}>
          {questionResult ? (
            <QuestionCard
              toolUseId="question"
              props={{ questions: [{ id: "q", question: "When?", type: "text" }] }}
              result={questionResult.resolved as Record<string, unknown> | undefined}
              onSubmit={() => {}}
              onDismiss={() => {}}
            />
          ) : (
            <RoutineDraftCard
              routineKey="chat-routine:test"
              draft={{
                name: "Weekly update",
                sentence: "Every Monday, remind me to send an update.",
                watchLabel: "Mondays",
                thenSummary: "Send a reminder",
                trigger: { type: "manual" },
                actionName: "summon",
                args: {},
              }}
            />
          )}
        </div>
        <div ref={setFloor} data-testid="floor">
          <ChatPendingCardJump scroller={scroller} content={content} floor={floor} />
        </div>
      </div>
    </MemoryRouter>
  );
}

beforeEach(() => {
  cardTop = -200;
  rs.mocked(listRoutineRefs).mockResolvedValue([]);
  rs.mocked(createRoutine).mockResolvedValue({ ok: true, status: 201, routineId: "routine" });
  rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const top =
      this.dataset.testid === "scroller" ? 0 : this.dataset.testid === "floor" ? 500 : cardTop;
    const height = this.dataset.testid === "scroller" ? 600 : 100;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      scrollTo(options);
      cardTop = 0;
      fireEvent.scroll(screen.getByTestId("scroller"));
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  rs.restoreAllMocks();
  rs.clearAllMocks();
});

describe("ChatPendingCardJump", () => {
  it("finds an unresolved routine above the viewport and brings it into view", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Jump to waiting card" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: -200, behavior: "instant" });
    expect(document.activeElement?.hasAttribute("data-chat-pending-card")).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull(),
    );
  });

  it("finds a card covered by the sticky composer even inside the scroller's bounds", async () => {
    cardTop = 510;
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Jump to waiting card" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 510, behavior: "instant" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull(),
    );
  });

  it("hides while visible and after turning on the routine, including after reload", async () => {
    cardTop = 20;
    const view = render(<Harness />);
    await screen.findByRole("button", { name: "Turn it on" });
    expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull();
    cardTop = -200;
    fireEvent.scroll(screen.getByTestId("scroller"));
    await screen.findByRole("button", { name: "Jump to waiting card" });
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull(),
    );
    view.unmount();
    rs.mocked(listRoutineRefs).mockResolvedValue([
      { id: "routine", key: "chat-routine:test", name: "Weekly update", enabled: true },
    ]);
    render(<Harness />);
    await screen.findByText("On");
    expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull();
  });

  for (const resolved of [
    { answers: [{ questionId: "q", value: "Monday" }] },
    { dismissed: true },
  ]) {
    it(`removes an off-screen question after ${"dismissed" in resolved ? "dismissal" : "an answer"}`, async () => {
      const view = render(<Harness questionResult={{}} />);
      await screen.findByRole("button", { name: "Jump to waiting card" });
      view.rerender(<Harness questionResult={{ resolved }} />);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Jump to waiting card" })).toBeNull(),
      );
    });
  }
});
