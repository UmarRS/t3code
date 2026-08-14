import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationIssue, ProjectId } from "@t3tools/contracts";
import { BotIcon, CircleCheckIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { primaryServerProvidersAtom } from "~/state/server";
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
  autonomousRunActionLabel,
  describeAutonomousRunStatus,
  hasAutonomousReviewerProvider,
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
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issues: ReadonlyArray<OrchestrationIssue>;
  readonly runState: AutonomousRunState;
  readonly onOpenReview: () => void;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const enableAutonomous = useAtomCommand(projectEnvironment.enableAutonomous, {
    reportFailure: false,
  });
  const disableAutonomous = useAtomCommand(projectEnvironment.disableAutonomous, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState<"enable" | "stop" | null>(null);
  const [pending, setPending] = useState(false);

  const progress = useMemo(() => summarizeAutonomousProgress(issues), [issues]);
  const status = useMemo(
    () => describeAutonomousRunStatus({ progress, state: runState }),
    [progress, runState],
  );
  const running = runState.kind === "running";
  const reviewerAvailable = useMemo(() => hasAutonomousReviewerProvider(providers), [providers]);
  const startableCount = progress.queued;

  // The palette navigates here and then asks for the prompt, so starting a run
  // always goes through the same confirmation.
  useEffect(
    () => onAutonomousRunPrompt(() => setConfirming(running ? "stop" : "enable")),
    [running],
  );

  const dispatchRunChange = useCallback(
    async (next: "enable" | "stop") => {
      setPending(true);
      const result =
        next === "enable"
          ? await enableAutonomous({ environmentId, input: { projectId } })
          : await disableAutonomous({ environmentId, input: { projectId } });
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
    [disableAutonomous, enableAutonomous, environmentId, projectId],
  );

  return (
    <>
      <div className="flex items-center gap-2">
        {runState.kind !== "idle" ? (
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

        {runState.kind === "finished" ? (
          <Button size="sm" variant="ghost" onClick={onOpenReview}>
            Review results
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="outline"
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
          {autonomousRunActionLabel(runState)}
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
