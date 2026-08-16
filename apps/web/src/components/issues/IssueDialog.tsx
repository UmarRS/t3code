import {
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_MAX_DEPENDENCIES,
  ISSUE_TITLE_MAX_LENGTH,
  type EnvironmentId,
  type IssueId,
  type IssuePriority,
  type ModelSelection,
  type OrchestrationIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { newIssueId } from "~/lib/utils";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "~/providerInstances";
import { issueEnvironment } from "~/state/issues";
import { primaryServerProvidersAtom } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  filterIssueDependencyCandidates,
  ISSUE_PRIORITY_LABEL,
  ISSUE_PRIORITY_ORDER,
} from "./IssuesBoard.logic";

const NO_PRIORITY_VALUE = "none";
const INHERIT_MODEL_VALUE = "inherit";

export interface IssueDialogTarget {
  /** The issue being edited, or null when composing a new one. */
  readonly issue: OrchestrationIssue | null;
}

interface IssueDialogProps {
  readonly target: IssueDialogTarget | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issues: ReadonlyArray<OrchestrationIssue>;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Create and edit surface for one issue. The markdown body is not carried on
 * the shell snapshot, so editing fetches it once per open and seeds the form
 * from the point read.
 */
export function IssueDialog({
  target,
  environmentId,
  projectId,
  issues,
  onOpenChange,
}: IssueDialogProps) {
  const open = target !== null;
  const editingIssue = target?.issue ?? null;
  const [draftIssueId, setDraftIssueId] = useState<IssueId>(newIssueId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<IssueId>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const modelOptions = useMemo(
    () =>
      deriveProviderInstanceEntries(providers)
        .filter(isProviderInstancePickerReady)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            value: `${provider.instanceId}:${model.slug}`,
            label: `${provider.displayName} · ${model.shortName ?? model.name}`,
            selection: {
              instanceId: provider.instanceId,
              model: model.slug,
            } satisfies ModelSelection,
          })),
        ),
    [providers],
  );

  const detail = useEnvironmentQuery(
    open && editingIssue !== null
      ? issueEnvironment.detail({ environmentId, input: { issueId: editingIssue.id } })
      : null,
  );
  const loadedDescription = detail.data?.issue?.description ?? null;

  const createIssue = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const updateIssue = useAtomCommand(issueEnvironment.update, { reportFailure: false });

  // Re-seed whenever the dialog opens on a different issue. A fresh id per
  // create keeps a retry after a rejected dispatch from colliding with itself.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTitle(editingIssue?.title ?? "");
    setPriority(editingIssue?.priority ?? null);
    setModelSelection(editingIssue?.modelSelection ?? null);
    setDependsOn(editingIssue?.dependsOn ?? []);
    setDescription("");
    if (editingIssue === null) {
      setDraftIssueId(newIssueId());
    }
  }, [editingIssue, open]);

  // The body arrives after the form is already usable; only fill an untouched
  // field so a fast typist never loses what they wrote.
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  useEffect(() => {
    if (!open || descriptionTouched || loadedDescription === null) return;
    setDescription(loadedDescription);
  }, [descriptionTouched, loadedDescription, open]);
  useEffect(() => {
    if (!open) setDescriptionTouched(false);
  }, [open]);

  const issueId = editingIssue?.id ?? draftIssueId;
  const dependencyCandidates = useMemo(
    () => filterIssueDependencyCandidates({ issues, issueId, selected: dependsOn }),
    [dependsOn, issueId, issues],
  );
  const selectedDependencies = useMemo(
    () => issues.filter((issue) => dependsOn.includes(issue.id)),
    [dependsOn, issues],
  );

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result =
      editingIssue === null
        ? await createIssue({
            environmentId,
            input: {
              issueId,
              projectId,
              title: trimmedTitle,
              description,
              priority,
              modelSelection,
              dependsOn,
            },
          })
        : await updateIssue({
            environmentId,
            input: {
              issueId,
              title: trimmedTitle,
              description,
              priority,
              modelSelection,
              dependsOn,
            },
          });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The issue could not be saved.");
      return;
    }
    // The body is a point read, not a subscription: drop the cached one so the
    // next open shows what was just saved.
    if (editingIssue !== null) {
      detail.refresh();
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editingIssue === null ? "New issue" : "Edit issue"}</DialogTitle>
          <DialogDescription>
            Describe the work. Starting the issue opens a thread in its own worktree and seeds the
            first turn from this text.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Title</span>
            <Input
              autoFocus
              maxLength={ISSUE_TITLE_MAX_LENGTH}
              placeholder="What needs to happen?"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Description</span>
            {/*
              A fixed height, not a minimum: the control sizes itself to its
              content, and an issue's body arrives from a point read after the
              dialog is already on screen. Letting it grow then would resize the
              popup around a description that can be hundreds of lines, and
              because the popup is centred in the viewport its top edge — and
              the close button pinned to it — jumps out from under the pointer
              just as the user reaches for it.
            */}
            <Textarea
              className="h-64"
              maxLength={ISSUE_DESCRIPTION_MAX_LENGTH}
              placeholder="Markdown. Acceptance criteria, constraints, anything that must not break."
              value={description}
              onChange={(event) => {
                setDescriptionTouched(true);
                setDescription(event.target.value);
              }}
            />
            {editingIssue !== null && detail.isPending && loadedDescription === null ? (
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <Spinner className="size-3" />
                Loading description...
              </span>
            ) : null}
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Priority</span>
              <Select
                value={priority ?? NO_PRIORITY_VALUE}
                onValueChange={(value) => {
                  setPriority(value === NO_PRIORITY_VALUE ? null : (value as IssuePriority));
                }}
              >
                <SelectTrigger aria-label="Priority">
                  <SelectValue>
                    {priority === null ? "None" : ISSUE_PRIORITY_LABEL[priority]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={NO_PRIORITY_VALUE}>None</SelectItem>
                  {ISSUE_PRIORITY_ORDER.map((option) => (
                    <SelectItem key={option} value={option}>
                      {ISSUE_PRIORITY_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Depends on</span>
              <Menu>
                <MenuTrigger
                  disabled={dependencyCandidates.length === 0}
                  render={<Button variant="outline" className="justify-between font-normal" />}
                >
                  <span className="truncate">
                    {dependsOn.length === 0 ? "Nothing" : `${dependsOn.length} selected`}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-icon-muted" />
                </MenuTrigger>
                <MenuPopup align="start" className="max-h-72 w-72 overflow-y-auto">
                  {dependencyCandidates.map((candidate) => {
                    const checked = dependsOn.includes(candidate.id);
                    return (
                      <MenuCheckboxItem
                        key={candidate.id}
                        checked={checked}
                        closeOnClick={false}
                        onCheckedChange={(nextChecked) => {
                          setDependsOn((current) =>
                            nextChecked
                              ? current.includes(candidate.id)
                                ? current
                                : [...current, candidate.id].slice(0, ISSUE_MAX_DEPENDENCIES)
                              : current.filter((id) => id !== candidate.id),
                          );
                        }}
                      >
                        <span className="truncate">{candidate.title}</span>
                      </MenuCheckboxItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            </div>
          </div>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Worker model</span>
            <Select
              value={
                modelSelection === null
                  ? INHERIT_MODEL_VALUE
                  : `${modelSelection.instanceId}:${modelSelection.model}`
              }
              onValueChange={(value) => {
                setModelSelection(
                  value === INHERIT_MODEL_VALUE
                    ? null
                    : (modelOptions.find((option) => option.value === value)?.selection ?? null),
                );
              }}
            >
              <SelectTrigger aria-label="Worker model">
                <SelectValue>
                  {modelSelection === null
                    ? "Project default"
                    : (modelOptions.find(
                        (option) =>
                          option.selection.instanceId === modelSelection.instanceId &&
                          option.selection.model === modelSelection.model,
                      )?.label ?? `${modelSelection.instanceId} · ${modelSelection.model}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem value={INHERIT_MODEL_VALUE}>Project default</SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-xs text-muted-foreground">
              Used for manual starts and autonomous runs. Project default stays editable in
              Settings.
            </span>
          </label>

          {selectedDependencies.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {selectedDependencies.map((dependency) => (
                <li key={dependency.id}>
                  <button
                    type="button"
                    className="inline-flex max-w-64 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-muted/24 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setDependsOn((current) => current.filter((id) => id !== dependency.id));
                    }}
                  >
                    <CheckIcon className="size-3 shrink-0" />
                    <span className="truncate">{dependency.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? <Spinner className="size-3.5" /> : null}
            {editingIssue === null ? "Create issue" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
