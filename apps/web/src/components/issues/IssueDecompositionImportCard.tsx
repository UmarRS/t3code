import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type IssueDecompositionEntry,
  type IssueId,
  type MessageId,
  type ProjectId,
} from "@t3tools/contracts";
import { type DecompositionRoutingProject } from "@t3tools/shared/issueDecompositionRouting";
import { useAtomValue } from "@effect/atom-react";
import { BotIcon, CheckIcon, ListPlusIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects } from "~/state/entities";
import { issueEnvironment, useEnvironmentIssues } from "~/state/issues";
import { projectEnvironment } from "~/state/projects";
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
import { hasAutonomousReviewerProvider } from "./autonomousRun.logic";
import {
  isIssueDecompositionImportApplied,
  planIssueDecompositionImport,
  type IssueDecompositionImportGroup,
} from "./issueDecompositionImport.logic";
import { useDecompositionRoutingTargets } from "./useDecompositionRoutingTargets";

/** "3 in Atlas and 2 in web-client", for a plan that spans boards. */
function describeGroupCounts(
  groups: ReadonlyArray<{ readonly title: string; readonly count: number }>,
): string {
  const parts = groups.map((group) => `${group.count} in ${group.title}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** How many stories one section lists before the rest become a count. */
const SECTION_PREVIEW_LIMIT = 6;

/**
 * One of the three things applying can do, listed so the user reads the whole
 * change — including the stories it retires — before pressing the button.
 */
function PlanSection({
  label,
  items,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, SECTION_PREVIEW_LIMIT);
  const omitted = items.length - shown.length;
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-foreground">
        {label} · {items.length}
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {shown.map((item) => (
          <li key={item.id} className="truncate text-xs text-muted-foreground">
            {item.text}
          </li>
        ))}
        {omitted > 0 ? <li className="text-xs text-muted-foreground">and {omitted} more</li> : null}
      </ul>
    </div>
  );
}

export function IssueDecompositionImportCard({
  entries,
  environmentId,
  projectId,
  messageId,
}: {
  readonly entries: ReadonlyArray<IssueDecompositionEntry>;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly messageId: MessageId;
}) {
  const projects = useProjects();
  // The whole environment, not this project: stories routed to a linked board
  // are already-created there and must not be offered a second time, and a
  // revision names issues that may sit on any board the plan reaches.
  const issues = useEnvironmentIssues(environmentId);
  const linkedProjects = useDecompositionRoutingTargets({ environmentId, projectId });
  const createIssue = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const updateIssue = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const setIssueStatus = useAtomCommand(issueEnvironment.setStatus, { reportFailure: false });
  const enableAutonomous = useAtomCommand(projectEnvironment.enableAutonomous, {
    reportFailure: false,
  });
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [submitting, setSubmitting] = useState(false);
  const [completedIds, setCompletedIds] = useState<ReadonlySet<IssueId>>(new Set());
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [startingRun, setStartingRun] = useState(false);

  const currentProject = useMemo((): DecompositionRoutingProject => {
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    return {
      id: projectId,
      title: project?.title ?? "this project",
      workspaceRoot: project?.workspaceRoot ?? "",
    };
  }, [environmentId, projectId, projects]);

  const plan = useMemo(
    () =>
      planIssueDecompositionImport({
        entries,
        messageId,
        currentProject,
        linkedProjects,
        issues,
      }),
    [currentProject, entries, issues, linkedProjects, messageId],
  );

  const existingIds = useMemo(() => new Set(issues.map((issue) => issue.id)), [issues]);
  // An empty group is real when every story routed away, and should not be
  // shown as a board receiving nothing.
  const populatedGroups = useMemo(
    () =>
      (plan?.groups ?? []).filter(
        (group) => group.creates.length + group.updates.length + group.cancels.length > 0,
      ),
    [plan],
  );

  /**
   * The boards this plan landed on that are not already working. Starting a run
   * is per board — there is no cross-board run object — so a plan that spans
   * repositories starts one on each, and the cross-board dependencies are what
   * keep them in step: a story waits until the story it depends on has merged,
   * whichever board that one is tracked on.
   */
  const runnableBoards = useMemo(
    () =>
      populatedGroups.filter((group) => {
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.id === group.projectId,
        );
        return project !== undefined && project.autonomousStartedAt == null;
      }),
    [environmentId, populatedGroups, projects],
  );
  const reviewerAvailable = useMemo(() => hasAutonomousReviewerProvider(providers), [providers]);

  const handleStartRuns = async () => {
    if (startingRun) return;
    setStartingRun(true);
    const failures: string[] = [];
    for (const board of runnableBoards) {
      const result = await enableAutonomous({
        environmentId,
        input: { projectId: board.projectId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        failures.push(
          `${board.title}: ${failure instanceof Error ? failure.message : "An error occurred."}`,
        );
      }
    }
    setStartingRun(false);
    setConfirmingRun(false);
    if (failures.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            failures.length === runnableBoards.length
              ? "Could not start autonomous mode"
              : "Some boards did not start",
          description: failures.join(" · "),
        }),
      );
      return;
    }
    toastManager.add({
      type: "success",
      title:
        runnableBoards.length === 1
          ? `Autonomous mode started on ${runnableBoards[0]?.title}`
          : `Autonomous mode started on ${runnableBoards.length} boards`,
    });
  };

  // A block naming a story that has started, is gone, or belongs to another
  // board cannot be applied as a whole, so it stays ordinary chat.
  if (plan === null) return null;

  const applied = isIssueDecompositionImportApplied(plan, {
    existingIssueIds: existingIds,
    completedIds,
  });
  const boardOf = (group: IssueDecompositionImportGroup) =>
    populatedGroups.length > 1 ? ` (${group.title})` : "";
  const sectionItems = {
    create: populatedGroups.flatMap((group) =>
      group.creates.map((planned) => ({
        id: planned.issueId,
        text: `${planned.title}${boardOf(group)}`,
      })),
    ),
    update: populatedGroups.flatMap((group) =>
      group.updates.map((planned) => ({
        id: planned.issueId,
        text: `${planned.title} — rewrites “${planned.existing.title}”${boardOf(group)}`,
      })),
    ),
    cancel: populatedGroups.flatMap((group) =>
      group.cancels.map((planned) => ({
        id: planned.issue.id,
        text: `${planned.issue.title} — replaced by “${planned.replacedByTitle}”${boardOf(group)}`,
      })),
    ),
  };

  const handleImport = async () => {
    if (submitting || applied) return;
    setSubmitting(true);
    const done = new Set(completedIds);
    // Every step stops where it failed and leaves the rest to a retry: the
    // plan is derived from the message, so pressing the button again picks up
    // exactly where this one stopped.
    const fail = (label: string, interrupted: boolean, failure: unknown) => {
      setSubmitting(false);
      setCompletedIds(new Set(done));
      if (interrupted) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: label,
          description: failure instanceof Error ? failure.message : "The rest can be retried.",
        }),
      );
    };

    // Creations first, in dependency order, so every `dependsOn` already names
    // an issue that exists; then the rewrites, which may point at them; then
    // the cancellations, which retire what the plan replaced.
    for (const planned of plan.creates) {
      if (existingIds.has(planned.issueId) || done.has(planned.issueId)) continue;
      const result = await createIssue({
        environmentId,
        input: {
          issueId: planned.issueId,
          projectId: planned.projectId,
          title: planned.title,
          description: planned.description,
          priority: planned.priority,
          modelSelection: planned.modelSelection,
          dependsOn: planned.dependsOn,
        },
      });
      if (result._tag === "Failure") {
        return fail(
          "Could not add all stories",
          isAtomCommandInterrupted(result),
          squashAtomCommandFailure(result),
        );
      }
      done.add(planned.issueId);
      setCompletedIds(new Set(done));
    }

    for (const planned of plan.updates) {
      if (planned.applied || done.has(planned.issueId)) continue;
      const result = await updateIssue({
        environmentId,
        input: {
          issueId: planned.issueId,
          title: planned.title,
          description: planned.description,
          priority: planned.priority,
          modelSelection: planned.modelSelection,
          dependsOn: planned.dependsOn,
        },
      });
      if (result._tag === "Failure") {
        return fail(
          "Could not revise all stories",
          isAtomCommandInterrupted(result),
          squashAtomCommandFailure(result),
        );
      }
      done.add(planned.issueId);
      setCompletedIds(new Set(done));
    }

    for (const planned of plan.cancels) {
      if (planned.applied || done.has(planned.issue.id)) continue;
      const result = await setIssueStatus({
        environmentId,
        input: { issueId: planned.issue.id, status: "canceled" },
      });
      if (result._tag === "Failure") {
        return fail(
          "Could not cancel all stories",
          isAtomCommandInterrupted(result),
          squashAtomCommandFailure(result),
        );
      }
      done.add(planned.issue.id);
      setCompletedIds(new Set(done));
    }

    setSubmitting(false);
    toastManager.add({
      type: "success",
      title:
        populatedGroups.length > 1
          ? `Board updated across ${populatedGroups.length} boards`
          : plan.updates.length + plan.cancels.length === 0
            ? plan.creates.length === 1
              ? "Story added to board"
              : `${plan.creates.length} stories added to board`
            : "Board updated",
    });
  };

  const totalActions = plan.creates.length + plan.updates.length + plan.cancels.length;
  const revises = plan.updates.length + plan.cancels.length > 0;
  const headline = applied
    ? revises
      ? "Board updated"
      : populatedGroups.length > 1
        ? `${plan.creates.length} stories added across ${populatedGroups.length} boards`
        : plan.creates.length === 1
          ? "Story added to the issue board"
          : `${plan.creates.length} stories added to the issue board`
    : revises
      ? `${totalActions} changes ready for the issue board`
      : populatedGroups.length > 1
        ? `${plan.creates.length} stories ready for ${populatedGroups.length} boards`
        : plan.creates.length === 1
          ? "1 story ready for the issue board"
          : `${plan.creates.length} stories ready for the issue board`;

  const detail =
    populatedGroups.length > 1
      ? `${describeGroupCounts(
          populatedGroups.map((group) => ({
            title: group.title,
            count: group.creates.length + group.updates.length + group.cancels.length,
          })),
        )}. Each story is created on the board of the project that owns the code.`
      : applied
        ? "You can open the board when you are ready to start work."
        : "Ask for revisions in chat, then add only the version you want to keep.";

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-card/45 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{headline}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
          {plan.unroutablePaths.length > 0 ? (
            <p className="mt-0.5 text-warning text-xs">
              {plan.unroutablePaths.join(", ")} {plan.unroutablePaths.length === 1 ? "is" : "are"}{" "}
              not a linked project here, so{" "}
              {plan.unroutablePaths.length === 1 ? "that story stays" : "those stories stay"} on{" "}
              {currentProject.title}'s board.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {applied && runnableBoards.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={startingRun}
              onClick={() => setConfirmingRun(true)}
            >
              {startingRun ? <Spinner className="size-3.5" /> : <BotIcon className="size-4" />}
              {runnableBoards.length === 1
                ? "Autonomous mode"
                : `Autonomous mode · ${runnableBoards.length} boards`}
            </Button>
          ) : null}
          <Button size="sm" disabled={submitting || applied} onClick={() => void handleImport()}>
            {applied ? <CheckIcon className="size-4" /> : <ListPlusIcon className="size-4" />}
            {applied ? "Added to board" : submitting ? "Adding…" : "Add to board"}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-3">
        <PlanSection label="Create" items={sectionItems.create} />
        <PlanSection label="Update" items={sectionItems.update} />
        <PlanSection label="Cancel" items={sectionItems.cancel} />
      </div>

      <AlertDialog
        open={confirmingRun}
        onOpenChange={(open) => {
          if (!open && !startingRun) setConfirmingRun(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {runnableBoards.length === 1
                ? "Let Atlas work this backlog?"
                : `Let Atlas work ${runnableBoards.length} backlogs?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every unblocked issue starts in its own worktree, and finished work is reviewed and
              merged one at a time. The threads it opens run with permissions auto-approved — nobody
              is there to answer a prompt — so they can edit files and run commands without asking.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="-mt-2 space-y-2 px-6 pb-4 text-sm text-muted-foreground">
            <p>
              {runnableBoards.length === 1
                ? `A run starts on ${runnableBoards[0]?.title}.`
                : `A run starts on ${runnableBoards.map((board) => board.title).join(", ")}. A story that waits on one from another board stays queued until that story has merged.`}
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
            <AlertDialogClose disabled={startingRun} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button disabled={startingRun} onClick={() => void handleStartRuns()}>
              {startingRun ? <Spinner className="size-3.5" /> : null}
              Start working
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
