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
import { CheckIcon, ListPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { issueEnvironment, useProjectIssues } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { issueIdForDecompositionEntry } from "./issueDecompositionImport.logic";

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
  const issues = useProjectIssues({ environmentId, projectId });
  const createIssue = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const [submitting, setSubmitting] = useState(false);
  const [completedIds, setCompletedIds] = useState<ReadonlySet<IssueId>>(new Set());
  const issueIdByKey = useMemo(
    () =>
      new Map(
        entries.map((entry) => [entry.key, issueIdForDecompositionEntry(messageId, entry.key)]),
      ),
    [entries, messageId],
  );
  const existingIds = useMemo(() => new Set(issues.map((issue) => issue.id)), [issues]);
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
      if (issueId === undefined) continue;
      const result = await createIssue({
        environmentId,
        input: {
          issueId,
          projectId,
          title: entry.title,
          description: entry.description,
          priority: entry.priority ?? null,
          modelSelection: entry.modelSelection ?? null,
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
        entries.length === 1 ? "Story added to board" : `${entries.length} stories added to board`,
    });
  };

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/45 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {imported
            ? entries.length === 1
              ? "Story added to the issue board"
              : `${entries.length} stories added to the issue board`
            : entries.length === 1
              ? "1 story ready for the issue board"
              : `${entries.length} stories ready for the issue board`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {imported
            ? "You can open the board when you are ready to start work."
            : "Ask for revisions in chat, then add only the version you want to keep."}
        </p>
      </div>
      <Button size="sm" disabled={submitting || imported} onClick={() => void handleImport()}>
        {imported ? <CheckIcon className="size-4" /> : <ListPlusIcon className="size-4" />}
        {imported ? "Added to board" : submitting ? "Adding…" : "Add to board"}
      </Button>
    </div>
  );
}
