// Settles routine runs parked on guardian approval once the approval resolves.
// Contract: docs/concepts/data.md#routines.
import type { ApprovalSettlement } from "../actions/approval-handler.js";
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";

interface ParkedRunRepos {
  executions: Pick<ActionExecutionsRepository, "findTreeRoot">;
  approvals: Pick<ApprovalsRepository, "hasActiveApprovalForRoot">;
  routineRuns: Pick<RoutineRunsRepository, "syncFromRoot">;
}

/**
 * Copies the outcome of the root execution onto the routine run rooted at it,
 * once no approval for the root is live, and returns whether a run changed.
 * `resolvedApprovalIds` name approvals known to have settled the root: they
 * count as resolved even while their own state still reads as live. A root
 * still running or parked leaves the run as it is, so the call is safe to
 * repeat.
 */
async function settleRoutineRunFromRoot(
  repos: ParkedRunRepos,
  rootExecutionId: string,
  resolvedApprovalIds: readonly string[] = [],
): Promise<boolean> {
  if (repos.approvals.hasActiveApprovalForRoot(rootExecutionId, resolvedApprovalIds)) return false;
  const root = await repos.executions.findTreeRoot(rootExecutionId);
  if (!root) return false;
  switch (root.status) {
    case "success":
      return repos.routineRuns.syncFromRoot(rootExecutionId, { status: "success" });
    case "error":
    case "cancelled":
      return repos.routineRuns.syncFromRoot(rootExecutionId, {
        status: root.status,
        ...(root.error ? { error: root.error } : {}),
      });
    default:
      return false;
  }
}

/** The ApprovalHandler settlement that keeps each routine run in step with
 * the root execution it parked on. */
export function routineRunApprovalSettlement(
  repos: ParkedRunRepos & {
    executions: Pick<ActionExecutionsRepository, "findTreeRoot" | "markParkedRootRejected">;
  },
): ApprovalSettlement {
  return {
    executions: repos.executions,
    onRootResolved: async (rootExecutionId, approvalId) => {
      await settleRoutineRunFromRoot(repos, rootExecutionId, [approvalId]);
    },
  };
}

/**
 * Settles every `pending_approval` routine run whose approvals have all
 * resolved, and returns how many runs it settled. This covers resolutions that
 * reached the approval but not the run: one made before Rome settled parked
 * runs, or one interrupted by a stop.
 *  - A root still parked behind a rejected approval is first recorded as
 *    rejected.
 *  - An approved action a stop interrupted is failed first, so the guardian
 *    can retry it. Its run then takes the root's outcome, as after an action
 *    that threw: endInterruptedRuns has already ended that root as an error.
 * Call at boot, after endInterruptedRuns and before any approval executes.
 */
export async function settleResolvedParkedRuns(
  repos: {
    executions: Pick<ActionExecutionsRepository, "findTreeRoot" | "markParkedRootRejected">;
    approvals: Pick<
      ApprovalsRepository,
      "hasActiveApprovalForRoot" | "hasRejectedApprovalForRoot" | "failInterruptedExecutions"
    >;
    routineRuns: Pick<RoutineRunsRepository, "findParkedExecutionIds" | "syncFromRoot">;
  },
  now: Date,
): Promise<number> {
  const interrupted = await repos.approvals.failInterruptedExecutions(
    "Rome stopped while the approved action was running",
  );
  let settled = 0;
  for (const rootExecutionId of await repos.routineRuns.findParkedExecutionIds()) {
    if (repos.approvals.hasActiveApprovalForRoot(rootExecutionId, interrupted)) continue;
    if (repos.approvals.hasRejectedApprovalForRoot(rootExecutionId)) {
      await repos.executions.markParkedRootRejected(rootExecutionId, now);
    }
    if (await settleRoutineRunFromRoot(repos, rootExecutionId, interrupted)) settled++;
  }
  return settled;
}
