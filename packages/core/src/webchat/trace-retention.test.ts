import { describe, expect, it } from "@rstest/core";
import {
  isSessionTraceArchived,
  resolveSessionTraceCutoff,
  sessionTraceCutoff,
  TRACE_RETENTION_MS,
  TRACE_RETENTION_RECENT_ROOTS,
} from "./trace-retention.js";

const now = new Date("2026-10-24T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const rootsAt = (at: Date | null) => ({
  ranks: [] as number[],
  async getRecentRootActivityAt(rank: number) {
    this.ranks.push(rank);
    return at;
  },
});

describe("session trace retention", () => {
  it("archives at exactly seven idle days, not before", () => {
    const cutoff = sessionTraceCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(TRACE_RETENTION_MS);
    expect(isSessionTraceArchived(new Date(cutoff.getTime() + 1), cutoff)).toBe(false);
    expect(isSessionTraceArchived(cutoff, cutoff)).toBe(true);
    expect(isSessionTraceArchived(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
  });

  it("asks for the 20th most recently active root", async () => {
    const source = rootsAt(null);
    await resolveSessionTraceCutoff(source, now);
    expect(source.ranks).toEqual([TRACE_RETENTION_RECENT_ROOTS]);
    expect(TRACE_RETENTION_RECENT_ROOTS).toBe(20);
  });

  it("archives nothing with fewer than 20 active roots, however long idle", async () => {
    const cutoff = await resolveSessionTraceCutoff(rootsAt(null), now);
    expect(isSessionTraceArchived(new Date(now.getTime() - 60 * DAY), cutoff)).toBe(false);
    expect(isSessionTraceArchived(new Date(0), cutoff)).toBe(false);
  });

  it("keeps the seven-day boundary when the 20th root is also recent", async () => {
    const cutoff = await resolveSessionTraceCutoff(rootsAt(new Date(now.getTime() - DAY)), now);
    expect(cutoff).toEqual(sessionTraceCutoff(now));
  });

  it("keeps sessions at or after the 20th root's activity, and archives older ones", async () => {
    const t20 = new Date(now.getTime() - 30 * DAY);
    const cutoff = await resolveSessionTraceCutoff(rootsAt(t20), now);
    expect(isSessionTraceArchived(t20, cutoff)).toBe(false);
    expect(isSessionTraceArchived(new Date(t20.getTime() + 1), cutoff)).toBe(false);
    expect(isSessionTraceArchived(new Date(t20.getTime() - 1), cutoff)).toBe(true);
    // Anything newer than the 20th root stays visible, including under seven days.
    expect(isSessionTraceArchived(new Date(now.getTime() - 6 * DAY), cutoff)).toBe(false);
  });
});
