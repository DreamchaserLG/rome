/** A session's steps stay visible while its effective activity is younger than this window. */
export const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Older sessions stay visible while their effective activity is at least as recent as the Nth most
 * recently active root session, so a quiet user keeps their latest chats' steps past the window.
 */
export const TRACE_RETENTION_RECENT_ROOTS = 20;

// Notifications are real out-of-band conversation messages, not session metadata.
export const TRACE_ACTIVITY_ROLES = ["user", "assistant", "trace", "notification"] as const;

/**
 * Root sessions of these stored types rank toward the recent-roots rule: guardian chats and
 * channel threads, which are both `channel` rows. Action runs and handoffs have no parent but
 * are not conversations a person returns to, so they never push a chat out of the top ranks.
 */
export const TRACE_RANKED_ROOT_TYPES = ["channel"] as const;

/** A cutoff no activity time reaches, so nothing is archived. */
export const TRACE_NEVER_ARCHIVED_CUTOFF = new Date(-8.64e15);

/** The cutoff of the seven-day window alone, without the recent-roots rule. */
export function sessionTraceCutoff(now = new Date()): Date {
  return new Date(now.getTime() - TRACE_RETENTION_MS);
}

/** Reads how recently the root session at a rank last had conversation activity. */
export interface RecentRootActivitySource {
  /** Last activity of the root at the 1-based `rank` by recency, or null when fewer roots have any. */
  getRecentRootActivityAt(rank: number): Promise<Date | null>;
}

/**
 * The cutoff for one read: a session is archived when its effective activity is at or before it.
 * A session stays visible when it is under seven days idle or ties with or beats the
 * {@link TRACE_RETENTION_RECENT_ROOTS}th most recently active root. With fewer active roots than
 * that, nothing is archived.
 */
export async function resolveSessionTraceCutoff(
  source: RecentRootActivitySource,
  now = new Date(),
): Promise<Date> {
  const recentRootActivityAt = await source.getRecentRootActivityAt(TRACE_RETENTION_RECENT_ROOTS);
  if (!recentRootActivityAt) return TRACE_NEVER_ARCHIVED_CUTOFF;
  const windowCutoff = sessionTraceCutoff(now);
  const rankCutoff = new Date(recentRootActivityAt.getTime() - 1);
  return rankCutoff.getTime() < windowCutoff.getTime() ? rankCutoff : windowCutoff;
}

/** Pass the latest activity across the session and its ancestors. Exactly at the cutoff is archived. */
export function isSessionTraceArchived(
  lastMessageAt: Date,
  cutoff = sessionTraceCutoff(),
): boolean {
  return lastMessageAt.getTime() <= cutoff.getTime();
}
