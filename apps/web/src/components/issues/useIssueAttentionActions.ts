import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  issueNeedsAttention,
  type EnvironmentId,
  type IssueId,
  type OrchestrationIssue,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { issueEnvironment, useEnvironmentIssues } from "~/state/issues";
import { environmentProjects, projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  planIssueAttentionClear,
  planIssueAttentionRetry,
  resolveStalledDependencyBoards,
  type AutonomousPlanBoards,
  type IssueRetryStep,
} from "./autonomousRun.logic";

/**
 * Clearing a needs-attention flag, and the fuller "retry" that also hands the
 * issue back to the backlog so a run can pick it up again. Both the board cards
 * and the Review tab dispatch through here so the two surfaces cannot drift.
 */
export function useIssueAttentionActions(environmentId: EnvironmentId) {
  const clearAttention = useAtomCommand(issueEnvironment.clearAttention, { reportFailure: false });
  const enableAutonomous = useAtomCommand(projectEnvironment.enableAutonomous, {
    reportFailure: false,
  });
  const updateIssue = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setIssueStatus = useAtomCommand(issueEnvironment.setStatus, { reportFailure: false });
  const [pendingIssueId, setPendingIssueId] = useState<IssueId | null>(null);

  const runSteps = useCallback(
    async (issue: OrchestrationIssue, steps: ReadonlyArray<IssueRetryStep>) => {
      setPendingIssueId(issue.id);
      // Ordered and short-circuiting: leaving an issue half-reset (flag gone,
      // still linked to a dead thread) is worse than leaving it flagged.
      for (const step of steps) {
        const result =
          step.kind === "clear-attention"
            ? await clearAttention({ environmentId, input: { issueId: issue.id } })
            : step.kind === "unlink-thread"
              ? await updateIssue({
                  environmentId,
                  input: { issueId: issue.id, threadId: null },
                })
              : await setIssueStatus({
                  environmentId,
                  input: { issueId: issue.id, status: "backlog" },
                });
        if (result._tag === "Failure") {
          setPendingIssueId(null);
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not update the issue",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return false;
        }
      }
      setPendingIssueId(null);
      return true;
    },
    [clearAttention, environmentId, setIssueStatus, updateIssue],
  );

  const clearFlag = useCallback(
    (issue: OrchestrationIssue) => runSteps(issue, planIssueAttentionClear()),
    [runSteps],
  );

  const retry = useCallback(
    (issue: OrchestrationIssue) => runSteps(issue, planIssueAttentionRetry(issue)),
    [runSteps],
  );

  /**
   * The way out of a cross-board dead end: start the board holding the blocker,
   * with the rest of its own plan, and put this issue back in the run's way.
   *
   * The flag is cleared first and deliberately: it is what took the issue out
   * of the run in the first place, so re-enabling the boards without clearing
   * it would start them for work that is still parked. This board is the
   * command's own project, so a run that switched itself off when it gave up
   * comes back with them.
   */
  const startBlockingBoards = useCallback(
    async (issue: OrchestrationIssue, plan: AutonomousPlanBoards) => {
      if (!(await runSteps(issue, planIssueAttentionClear()))) return;
      setPendingIssueId(issue.id);
      const result = await enableAutonomous({
        environmentId,
        input: {
          projectId: issue.projectId,
          additionalProjectIds: plan.additionalProjectIds,
        },
      });
      setPendingIssueId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the other board",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [enableAutonomous, environmentId, runSteps],
  );

  return { clearFlag, pendingIssueId, retry, startBlockingBoards };
}

/**
 * Resolves, for a flagged issue, the idle boards holding what it waits on —
 * the "start a run there" the stall message asks for, as something a card can
 * offer. Reads the environment's issues and boards rather than taking them as
 * props, so both the board card and the Review tab can ask without either page
 * threading cross-board state down to its cards.
 */
export function useStalledDependencyBoards(environmentId: EnvironmentId) {
  const issues = useEnvironmentIssues(environmentId);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  return useCallback(
    (issue: OrchestrationIssue): AutonomousPlanBoards | null =>
      issueNeedsAttention(issue)
        ? resolveStalledDependencyBoards({ issue, issues, projects })
        : null,
    [issues, projects],
  );
}
