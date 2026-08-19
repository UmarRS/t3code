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
import { CheckIcon, ListPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects } from "~/state/entities";
import { issueEnvironment, useEnvironmentIssues } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
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
  const [submitting, setSubmitting] = useState(false);
  const [completedIds, setCompletedIds] = useState<ReadonlySet<IssueId>>(new Set());

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
  const remainingByGroup = populatedGroups.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => {
      const issueId = issueIdByKey.get(entry.key);
      return issueId !== undefined && !existingIds.has(issueId) && !completedIds.has(issueId);
    }),
  }));
  const imported = remainingByGroup.every((group) => group.entries.length === 0);

  const handleImport = async () => {
    if (submitting || imported) return;
    setSubmitting(true);
    const createdIds = new Set(completedIds);
    for (const group of remainingByGroup) {
      for (const entry of group.entries) {
        const issueId = issueIdByKey.get(entry.key);
        if (issueId === undefined) continue;
        const result = await createIssue({
          environmentId,
          input: {
            issueId,
            projectId: group.projectId,
            title: entry.title,
            description: entry.description,
            priority: entry.priority ?? null,
            modelSelection: entry.modelSelection ?? null,
            // Dependencies never cross boards — the parser rejects a block
            // where they do — so every key here resolves within this group.
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
      <Button size="sm" disabled={submitting || imported} onClick={() => void handleImport()}>
        {imported ? <CheckIcon className="size-4" /> : <ListPlusIcon className="size-4" />}
        {imported ? "Added to board" : submitting ? "Adding…" : "Add to board"}
      </Button>
    </div>
  );
}
