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
import {
  groupDecompositionEntriesByProject,
  type DecompositionRoutingProject,
} from "@t3tools/shared/issueDecompositionRouting";
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
import { issueIdForDecompositionEntry } from "./issueDecompositionImport.logic";
import { useDecompositionRoutingTargets } from "./useDecompositionRoutingTargets";

/** "3 in Atlas and 2 in web-client", for a plan that spans boards. */
function describeGroupCounts(
  groups: ReadonlyArray<{ readonly title: string; readonly entries: ReadonlyArray<unknown> }>,
): string {
  const parts = groups.map((group) => `${group.entries.length} in ${group.title}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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
  // are already-created there and must not be offered a second time.
  const issues = useEnvironmentIssues(environmentId);
  const linkedProjects = useDecompositionRoutingTargets({ environmentId, projectId });
  const createIssue = useAtomCommand(issueEnvironment.create, { reportFailure: false });
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

  const issueIdByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.key, issueIdForDecompositionEntry(messageId, entry.key)]),
      ),
    [entries, messageId],
  );

  const groups = useMemo(
    () => groupDecompositionEntriesByProject({ entries, currentProject, linkedProjects }),
    [currentProject, entries, linkedProjects],
  );
  // An empty requesting-project group is real when every story routed away, and
  // should not be shown as a board receiving nothing.
  const populatedGroups = useMemo(
    () => groups.filter((group) => group.entries.length > 0),
    [groups],
  );
  const unroutablePaths = groups[0]?.unroutablePaths ?? [];

  const existingIds = useMemo(() => new Set(issues.map((issue) => issue.id)), [issues]);
  /**
   * Every story still to create, in the order the parser put them: dependencies
   * first. One pass across all the boards rather than a pass per board, because
   * a story may wait on one filed on a different board and an issue cannot name
   * a dependency that does not exist yet.
   */
  const projectIdByKey = useMemo(
    () =>
      new Map(
        populatedGroups.flatMap((group) =>
          group.entries.map((entry) => [entry.key, group.projectId] as const),
        ),
      ),
    [populatedGroups],
  );
  const remaining = entries.filter((entry) => {
    const issueId = issueIdByKey.get(entry.key);
    return issueId !== undefined && !existingIds.has(issueId) && !completedIds.has(issueId);
  });
  const imported = remaining.length === 0;

  const handleImport = async () => {
    if (submitting || imported) return;
    setSubmitting(true);
    const createdIds = new Set(completedIds);
    for (const entry of remaining) {
      const issueId = issueIdByKey.get(entry.key);
      const entryProjectId = projectIdByKey.get(entry.key);
      if (issueId === undefined || entryProjectId === undefined) continue;
      const result = await createIssue({
        environmentId,
        input: {
          issueId,
          projectId: entryProjectId,
          title: entry.title,
          description: entry.description,
          priority: entry.priority ?? null,
          modelSelection: entry.modelSelection ?? null,
          // A dependency may name a story on another board; the ordered pass
          // above is what guarantees it already exists by the time this runs.
          dependsOn: (entry.dependsOn ?? []).flatMap((key) => {
            const dependencyId = issueIdByKey.get(key);
            return dependencyId === undefined ? [] : [dependencyId];
          }),
        },
      });
      if (result._tag === "Failure") {
        setSubmitting(false);
        setCompletedIds(createdIds);
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not add all stories",
              description:
                failure instanceof Error
                  ? failure.message
                  : "The remaining stories can be retried.",
            }),
          );
        }
        return;
      }
      createdIds.add(issueId);
      setCompletedIds(new Set(createdIds));
    }
    setSubmitting(false);
    toastManager.add({
      type: "success",
      title:
        populatedGroups.length > 1
          ? `${entries.length} stories added across ${populatedGroups.length} boards`
          : entries.length === 1
            ? "Story added to board"
            : `${entries.length} stories added to board`,
    });
  };

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

  const headline = imported
    ? populatedGroups.length > 1
      ? `${entries.length} stories added across ${populatedGroups.length} boards`
      : entries.length === 1
        ? "Story added to the issue board"
        : `${entries.length} stories added to the issue board`
    : populatedGroups.length > 1
      ? `${entries.length} stories ready for ${populatedGroups.length} boards`
      : entries.length === 1
        ? "1 story ready for the issue board"
        : `${entries.length} stories ready for the issue board`;

  const detail =
    populatedGroups.length > 1
      ? `${describeGroupCounts(populatedGroups)}. Each story is created on the board of the project that owns the code.`
      : imported
        ? "You can open the board when you are ready to start work."
        : "Ask for revisions in chat, then add only the version you want to keep.";

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/45 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{headline}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        {unroutablePaths.length > 0 ? (
          <p className="mt-0.5 text-warning text-xs">
            {unroutablePaths.join(", ")} {unroutablePaths.length === 1 ? "is" : "are"} not a linked
            project here, so{" "}
            {unroutablePaths.length === 1 ? "that story stays" : "those stories stay"} on{" "}
            {currentProject.title}'s board.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {imported && runnableBoards.length > 0 ? (
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
        <Button size="sm" disabled={submitting || imported} onClick={() => void handleImport()}>
          {imported ? <CheckIcon className="size-4" /> : <ListPlusIcon className="size-4" />}
          {imported ? "Added to board" : submitting ? "Adding…" : "Add to board"}
        </Button>
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
