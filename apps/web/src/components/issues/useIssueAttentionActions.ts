import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueId, OrchestrationIssue } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  planIssueAttentionClear,
  planIssueAttentionRetry,
  type IssueRetryStep,
} from "./autonomousRun.logic";

/**
 * Clearing a needs-attention flag, and the fuller "retry" that also hands the
 * issue back to the backlog so a run can pick it up again. Both the board cards
 * and the Review tab dispatch through here so the two surfaces cannot drift.
 */
export function useIssueAttentionActions(environmentId: EnvironmentId) {
  const clearAttention = useAtomCommand(issueEnvironment.clearAttention, { reportFailure: false });
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
          return;
        }
      }
      setPendingIssueId(null);
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

  return { clearFlag, pendingIssueId, retry };
}
