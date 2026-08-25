import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationIssue, ProjectId } from "@t3tools/contracts";
import { BotIcon, CircleCheckIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useSidebarProjectPrefsStore } from "~/sidebarProjectPrefsStore";
import { environmentProjects, projectEnvironment } from "~/state/projects";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { onAutonomousRunPrompt } from "./issuesDashboardBus";
import {
  autonomousFinishedRunReviewKey,
  autonomousRunActionLabel,
  autonomousRunCompactActionLabel,
  describeAutonomousPlanBoards,
  describeAutonomousRunStatus,
  hasAutonomousReviewerProvider,
  resolveAutonomousPlanBoards,
  shouldShowFinishedRunReviewButton,
  summarizeAutonomousProgress,
  type AutonomousRunState,
} from "./autonomousRun.logic";

const TONE_CLASS = {
  active: "border-info/40 bg-info/8 text-info-foreground",
  complete: "border-success/40 bg-success/8 text-success-foreground",
  stopped: "border-border/70 bg-muted/24 text-muted-foreground",
  idle: "border-border/70 bg-muted/16 text-muted-foreground",
} as const;

/**
 * The run switch and its live status. Deliberately a static badge: it re-renders
 * when the read model changes and never animates, because this sits on screen
 * for as long as a run lasts.
 */
export function AutonomousRunControl({
  environmentId,
  projectId,
  issues,
  runState,
  onOpenReview,
  listenForExternalPrompt = true,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /**
   * The environment's issues, not just this board's: a dependency may name an
   * issue another board tracks, and the readout scopes itself to `projectId`.
   */
  readonly issues: ReadonlyArray<OrchestrationIssue>;
  readonly runState: AutonomousRunState;
  readonly onOpenReview: () => void;
  /** Only the detailed board owns the command-palette prompt event. */
  readonly listenForExternalPrompt?: boolean;
  /**
   * Renders the switch alone. For callers that already show the run's status
   * and its review entry themselves — the overview's table gives each of them
   * a column — so the row does not say the same thing twice.
   */
  readonly compact?: boolean;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const enableAutonomous = useAtomCommand(projectEnvironment.enableAutonomous, {
    reportFailure: false,
  });
  const disableAutonomous = useAtomCommand(projectEnvironment.disableAutonomous, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState<"enable" | "stop" | null>(null);
  const [pending, setPending] = useState(false);

  const dismissedFinishedRunKeys = useSidebarProjectPrefsStore(
    (state) => state.dismissedFinishedRunKeys,
  );
  const dismissFinishedRun = useSidebarProjectPrefsStore((state) => state.dismissFinishedRun);
  const dismissedReviewKeys = useMemo(
    () => new Set(dismissedFinishedRunKeys),
    [dismissedFinishedRunKeys],
  );
  const finishedRunReviewKey = useMemo(
    () =>
      autonomousFinishedRunReviewKey({
        environmentId,
        projectId,
        finishedAt: runState.kind === "finished" ? runState.finishedAt : null,
      }),
    [environmentId, projectId, runState],
  );
  const showFinishedRunReview = useMemo(
    () =>
      shouldShowFinishedRunReviewButton({
        runState,
        reviewKey: finishedRunReviewKey,
        dismissedKeys: dismissedReviewKeys,
      }),
    [dismissedReviewKeys, finishedRunReviewKey, runState],
  );
  const dismissAndOpenReview = useCallback(() => {
    if (finishedRunReviewKey !== null) dismissFinishedRun(finishedRunReviewKey);
    onOpenReview();
  }, [dismissFinishedRun, finishedRunReviewKey, onOpenReview]);

  const progress = useMemo(
    () => summarizeAutonomousProgress(issues, { projectId }),
    [issues, projectId],
  );
  const status = useMemo(
    () => describeAutonomousRunStatus({ progress, state: runState }),
    [progress, runState],
  );
  const running = runState.kind === "running";
  const reviewerAvailable = useMemo(() => hasAutonomousReviewerProvider(providers), [providers]);
  const startableCount = progress.queued;
  // The rest of the plan: the boards this one's stories depend on. Resolved for
  // both directions up front so the dialog can name them and the dispatch can
  // send them, and so a board with no cross-board dependency gets neither.
  const enablePlan = useMemo(
    () => resolveAutonomousPlanBoards({ issues, projects, projectId, action: "enable" }),
    [issues, projectId, projects],
  );
  const stopPlan = useMemo(
    () => resolveAutonomousPlanBoards({ issues, projects, projectId, action: "stop" }),
    [issues, projectId, projects],
  );
  const enablePlanSummary = describeAutonomousPlanBoards(enablePlan, "enable");
  const stopPlanSummary = describeAutonomousPlanBoards(stopPlan, "stop");

  // The palette navigates here and then asks for the prompt, so starting a run
  // always goes through the same confirmation.
  useEffect(
    () =>
      listenForExternalPrompt
        ? onAutonomousRunPrompt(() => setConfirming(running ? "stop" : "enable"))
        : undefined,
    [listenForExternalPrompt, running],
  );

  const dispatchRunChange = useCallback(
    async (next: "enable" | "stop") => {
      setPending(true);
      const result =
        next === "enable"
          ? await enableAutonomous({
              environmentId,
              input: { projectId, additionalProjectIds: enablePlan.additionalProjectIds },
            })
          : await disableAutonomous({
              environmentId,
              input: { projectId, additionalProjectIds: stopPlan.additionalProjectIds },
            });
      setPending(false);
      setConfirming(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: next === "enable" ? "Could not start autonomous mode" : "Could not stop the run",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      disableAutonomous,
      enableAutonomous,
      enablePlan.additionalProjectIds,
      environmentId,
      projectId,
      stopPlan.additionalProjectIds,
    ],
  );

  return (
    <>
      <div className="flex items-center gap-2">
        {!compact && runState.kind !== "idle" ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              TONE_CLASS[status.tone],
            )}
            data-autonomous-state={runState.kind}
          >
            {status.tone === "complete" ? (
              <CircleCheckIcon className="size-3.5 shrink-0" />
            ) : (
              <BotIcon className="size-3.5 shrink-0" />
            )}
            <span className="font-medium">{status.label}</span>
            {status.detail ? (
              <span className="text-muted-foreground">· {status.detail}</span>
            ) : null}
          </span>
        ) : null}

        {/*
          Kept on the raw run state, not the badge's tone: archiving is filing,
          not deleting (see isIssueDueForArchive), so a run whose issues have
          all archived off the board's progress readout still has real merged
          and needs-attention history for the Review tab to show. The tab's own
          empty state covers the case where there is truly nothing to see.
        */}
        {!compact && showFinishedRunReview ? (
          <Button size="sm" variant="ghost" onClick={dismissAndOpenReview}>
            Review results
          </Button>
        ) : null}

        <Button
          size="sm"
          variant={compact ? "default" : "outline"}
          disabled={pending}
          onClick={() => setConfirming(running ? "stop" : "enable")}
        >
          {pending ? (
            <Spinner className="size-3.5" />
          ) : running ? (
            <SquareIcon className="size-3.5" />
          ) : (
            <BotIcon className="size-4" />
          )}
          {compact ? autonomousRunCompactActionLabel(runState) : autonomousRunActionLabel(runState)}
        </Button>
      </div>

      <AlertDialog
        open={confirming === "enable"}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Let Atlas work this backlog?</AlertDialogTitle>
            <AlertDialogDescription>
              Every unblocked issue starts in its own worktree, and finished work is reviewed and
              merged one at a time. The threads it opens run with permissions auto-approved — nobody
              is there to answer a prompt — so they can edit files and run commands without asking.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="-mt-2 space-y-2 px-6 pb-4 text-sm text-muted-foreground">
            <p>
              {startableCount === 0
                ? "Nothing is startable right now. The run stays on and picks up issues as they unblock."
                : `${startableCount} issue${startableCount === 1 ? "" : "s"} can start immediately.`}
              {enablePlanSummary === null ? null : <> {enablePlanSummary}</>}
            </p>
            {reviewerAvailable ? null : (
              <p className="flex items-start gap-1.5 text-warning-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                No Claude provider is set up, so reviews cannot run and finished work will be left
                for you instead of merged.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button disabled={pending} onClick={() => void dispatchRunChange("enable")}>
              {pending ? <Spinner className="size-3.5" /> : null}
              Start working
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={confirming === "stop"}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop starting new work?</AlertDialogTitle>
            <AlertDialogDescription>
              No further issues are started and no further reviews are run. Threads that are already
              working keep going — stopping the run does not interrupt them — and you can end those
              from their own threads.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {stopPlanSummary === null ? null : (
            <div className="-mt-2 px-6 pb-4 text-sm text-muted-foreground">
              <p>{stopPlanSummary}</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Keep running
            </AlertDialogClose>
            <Button disabled={pending} onClick={() => void dispatchRunChange("stop")}>
              {pending ? <Spinner className="size-3.5" /> : null}
              Stop starting work
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
