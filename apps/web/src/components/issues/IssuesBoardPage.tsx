import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  issueNeedsAttention,
  type EnvironmentId,
  type IssueStatus,
  type OrchestrationIssue,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LockIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { resolveNewDraftStartFromOrigin } from "~/lib/chatThreadActions";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn, newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useProject, useProjects, useThreadShells } from "~/state/entities";
import { issueEnvironment, useEnvironmentIssues, useProjectIssues } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { waitForStartedServerThread } from "../ChatView.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutonomousRunControl } from "./AutonomousRunControl";
import {
  issueAttentionRetryKind,
  issueRetryRestartsWork,
  resolveAutonomousRunState,
  resolveIssueAttentionPresentation,
} from "./autonomousRun.logic";
import { IssueDialog, type IssueDialogTarget } from "./IssueDialog";
import { IssuesReviewTab } from "./IssuesReviewTab";
import { IssuesProjectMenuGroup } from "./IssuesProjectMenuGroup";
import { useIssueAttentionActions } from "./useIssueAttentionActions";
import {
  buildIssueBoardColumns,
  buildIssueDecompositionPrompt,
  countDelegationTargetProjects,
  describeDelegationTargets,
  describeIssueBlockers,
  indexIssuesById,
  ISSUE_PRIORITY_LABEL,
  ISSUE_STATUS_COLUMNS,
  resolveIssueBlockers,
  resolveIssueDelegationLinks,
  resolveIssueStartDisabledReason,
  type IssueDelegationLinks,
} from "./IssuesBoard.logic";

const PRIORITY_DOT_CLASS: Record<NonNullable<OrchestrationIssue["priority"]>, string> = {
  urgent: "bg-destructive",
  high: "bg-amber-500",
  medium: "bg-sky-500",
  low: "bg-muted-foreground/50",
};

export type IssuesDashboardTab = "board" | "review";

export function IssuesBoardPage({
  environmentId,
  projectId,
  tab = "board",
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly tab?: IssuesDashboardTab;
}) {
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const projects = useProjects();
  const issues = useProjectIssues(projectRef);
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const startIssue = useAtomCommand(issueEnvironment.start, { reportFailure: false });
  const setIssueStatus = useAtomCommand(issueEnvironment.setStatus, { reportFailure: false });
  const deleteIssue = useAtomCommand(issueEnvironment.delete, { reportFailure: false });
  const updateIssue = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const threadShells = useThreadShells();
  const [dialogTarget, setDialogTarget] = useState<IssueDialogTarget | null>(null);
  const [issueToDelete, setIssueToDelete] = useState<OrchestrationIssue | null>(null);
  const [startingIssueId, setStartingIssueId] = useState<string | null>(null);
  const [stoppingIssueId, setStoppingIssueId] = useState<string | null>(null);
  const attention = useIssueAttentionActions(environmentId);
  const runState = useMemo(() => resolveAutonomousRunState(project), [project]);
  const runActive = runState.kind === "running";

  // The worktree forks from whatever the project has checked out. Reading the
  // ref name (rather than leaving the server on "HEAD") is what makes the
  // "start from origin" preference resolvable to a remote branch.
  const gitStatus = useEnvironmentQuery(
    project === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: project.workspaceRoot } }),
  );

  const columns = useMemo(() => buildIssueBoardColumns(issues), [issues]);
  const issuesById = useMemo(() => indexIssuesById(issues), [issues]);

  // Delegation reaches across boards, so the far side is resolved from the
  // whole environment rather than this project's slice.
  const environmentIssues = useEnvironmentIssues(environmentId);
  const projectIdByThreadId = useMemo(
    () =>
      new Map(
        threadShells
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => [thread.id as string, thread.projectId as string]),
      ),
    [environmentId, threadShells],
  );
  const projectTitleById = useMemo(
    () =>
      new Map(
        projects
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => [entry.id as string, entry.title]),
      ),
    [environmentId, projects],
  );

  const reportFailure = useCallback((title: string, failure: unknown) => {
    const error = squashAtomCommandFailure(
      failure as Parameters<typeof squashAtomCommandFailure>[0],
    );
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const handleStart = useCallback(
    async (issue: OrchestrationIssue) => {
      if (project === null || startingIssueId !== null) return;
      const modelSelection = resolveDefaultProviderModelSelection(
        providers,
        issue.modelSelection ?? project.defaultModelSelection,
      );
      if (modelSelection === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "No provider available",
            description: "Enable a provider in Settings to start work on an issue.",
          }),
        );
        return;
      }
      const threadId = newThreadId();
      const baseBranch = gitStatus.data?.refName ?? null;
      setStartingIssueId(issue.id);
      const result = await startIssue({
        environmentId,
        input: {
          issueId: issue.id,
          threadId,
          messageId: newMessageId(),
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          ...(baseBranch === null ? {} : { baseBranch }),
          startFromOrigin:
            baseBranch !== null &&
            resolveNewDraftStartFromOrigin({
              envMode: "worktree",
              newWorktreesStartFromOrigin: serverSettings.newWorktreesStartFromOrigin,
            }),
        },
      });
      setStartingIssueId(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not start work", result);
        }
        return;
      }
      await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    },
    [
      environmentId,
      gitStatus.data?.refName,
      navigate,
      project,
      providers,
      reportFailure,
      serverSettings.newWorktreesStartFromOrigin,
      startIssue,
      startingIssueId,
    ],
  );

  const handleStatusChange = useCallback(
    async (issue: OrchestrationIssue, status: IssueStatus) => {
      if (issue.status === status) return;
      const result = await setIssueStatus({
        environmentId,
        input: { issueId: issue.id, status },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not move the issue", result);
      }
    },
    [environmentId, reportFailure, setIssueStatus],
  );

  // The way back out of a start: the thread stays, the issue becomes startable
  // again in a fresh worktree.
  const handleUnlinkThread = useCallback(
    async (issue: OrchestrationIssue) => {
      const result = await updateIssue({
        environmentId,
        input: { issueId: issue.id, threadId: null },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not unlink the thread", result);
      }
    },
    [environmentId, reportFailure, updateIssue],
  );

  // Gracefully stop the provider first, then free the issue for a clean restart.
  // The old thread and worktree remain available for inspection.
  const handleStop = useCallback(
    async (issue: OrchestrationIssue) => {
      if (issue.threadId === null || stoppingIssueId !== null) return;
      const threadId = issue.threadId;
      setStoppingIssueId(issue.id);
      const commands = [
        () => interruptTurn({ environmentId, input: { threadId } }),
        () => stopSession({ environmentId, input: { threadId } }),
        // Canceled is the durable stopped state. In particular, an active
        // autonomous run must not immediately pick the issue back up.
        () => setIssueStatus({ environmentId, input: { issueId: issue.id, status: "canceled" } }),
        () => updateIssue({ environmentId, input: { issueId: issue.id, threadId: null } }),
      ];
      for (const command of commands) {
        const result = await command();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportFailure("Could not stop the issue", result);
          break;
        }
      }
      setStoppingIssueId(null);
    },
    [
      environmentId,
      interruptTurn,
      reportFailure,
      setIssueStatus,
      stopSession,
      stoppingIssueId,
      updateIssue,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (issueToDelete === null) return;
    const target = issueToDelete;
    setIssueToDelete(null);
    const result = await deleteIssue({
      environmentId,
      input: { issueId: target.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not delete the issue", result);
    }
  }, [deleteIssue, environmentId, issueToDelete, reportFailure]);

  // Story generation is an ordinary new thread whose composer is pre-filled:
  // the agent answers with a decomposition block and the server turns it into
  // issues, so this surface has nothing else to do afterwards.
  const handleGenerateStories = useCallback(async () => {
    if (project === null) return;
    await handleNewThread(projectRef);
    const store = useComposerDraftStore.getState();
    const session = store.getDraftSessionByProjectRef(projectRef);
    if (session === null) return;
    store.setPrompt(
      session.draftId,
      buildIssueDecompositionPrompt({
        projectTitle: project.title,
        availableModels: providers.flatMap((provider) =>
          provider.enabled && provider.status === "ready"
            ? provider.models.map((model) => ({
                instanceId: provider.instanceId,
                model: model.slug,
              }))
            : [],
        ),
      }),
    );
  }, [handleNewThread, project, projectRef, providers]);

  const openThreadById = useCallback(
    async (threadId: ThreadId) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    },
    [environmentId, navigate],
  );

  const openThread = useCallback(
    async (issue: OrchestrationIssue) => {
      if (issue.threadId === null) return;
      await openThreadById(issue.threadId);
    },
    [openThreadById],
  );

  /** Jump to the thread that delegated this issue here, wherever it lives. */
  const openDelegationOrigin = useCallback(
    async (origin: IssueDelegationLinks["origin"]) => {
      if (origin === null) return;
      await openThreadById(origin.threadId as ThreadId);
    },
    [openThreadById],
  );

  /**
   * Jump to the board holding the delegated work. Several targets on one board
   * still resolve to that board; targets spread over more than one leave the
   * choice to the user rather than guessing, so the chip only navigates when
   * there is one destination.
   */
  const openDelegationTargets = useCallback(
    async (targets: IssueDelegationLinks["targets"]) => {
      const [first] = targets;
      if (first === undefined || countDelegationTargetProjects(targets) !== 1) return;
      await navigate({
        to: "/issues/$environmentId/$projectId",
        params: { environmentId, projectId: first.projectId as ProjectId },
      });
    },
    [environmentId, navigate],
  );

  // Tabs are routes so the palette, the finished-run link, and a bookmark all
  // land on the same place.
  const openTab = useCallback(
    async (next: IssuesDashboardTab) => {
      if (next === tab) return;
      await navigate(
        next === "review"
          ? {
              to: "/issues/$environmentId/$projectId/review",
              params: { environmentId, projectId },
            }
          : { to: "/issues/$environmentId/$projectId", params: { environmentId, projectId } },
      );
    },
    [environmentId, navigate, projectId, tab],
  );

  const needsAttentionCount = useMemo(
    () => issues.filter((issue) => issueNeedsAttention(issue)).length,
    [issues],
  );

  const title = project?.title ?? "Issues";

  const projectPicker = (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-inherit outline-hidden hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
            aria-label={`Current project: ${title}. Choose another project board`}
          />
        }
      >
        <span className="truncate">{title}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <IssuesProjectMenuGroup
          currentProjectRef={projectRef}
          label="Project board"
          projects={projects}
          onSelect={(candidate) =>
            void navigate(
              tab === "review"
                ? {
                    to: "/issues/$environmentId/$projectId/review",
                    params: {
                      environmentId: candidate.environmentId,
                      projectId: candidate.id,
                    },
                  }
                : {
                    to: "/issues/$environmentId/$projectId",
                    params: {
                      environmentId: candidate.environmentId,
                      projectId: candidate.id,
                    },
                  },
            )
          }
        />
      </MenuPopup>
    </Menu>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron ? (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <h1 className="flex min-w-0 items-center text-xs font-medium tracking-wide text-muted-foreground/70">
              <span className="shrink-0">Issues ·&nbsp;</span>
              {projectPicker}
            </h1>
          </div>
        ) : (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <h1 className="flex min-w-0 items-center text-sm font-medium text-foreground">
              <span className="shrink-0">Issues ·&nbsp;</span>
              {projectPicker}
            </h1>
          </header>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                className={cn(
                  "cursor-pointer px-3 py-1.5 text-xs",
                  tab === "board"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => void openTab("board")}
              >
                Board
              </button>
              <button
                type="button"
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs",
                  tab === "review"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => void openTab("review")}
              >
                Review
                {needsAttentionCount > 0 ? (
                  <span className="rounded-full bg-warning/16 px-1.5 text-[.625rem] text-warning-foreground tabular-nums">
                    {needsAttentionCount}
                  </span>
                ) : null}
              </button>
            </div>
            <p className="text-muted-foreground text-sm max-sm:hidden">
              {issues.length === 0
                ? "No issues yet."
                : `${issues.length} issue${issues.length === 1 ? "" : "s"} in ${title}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {project === null ? null : (
              <AutonomousRunControl
                environmentId={environmentId}
                projectId={projectId}
                issues={issues}
                runState={runState}
                onOpenReview={() => void openTab("review")}
              />
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={project === null}
              onClick={() => void handleGenerateStories()}
            >
              <SparklesIcon className="size-4" />
              Generate stories
            </Button>
            <Button
              size="sm"
              disabled={project === null}
              onClick={() => setDialogTarget({ issue: null })}
            >
              <PlusIcon className="size-4" />
              New issue
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {tab === "review" ? (
            <IssuesReviewTab
              environmentId={environmentId}
              issues={issues}
              workspaceRoot={project?.workspaceRoot}
              onOpenThread={(threadId) => void openThreadById(threadId)}
            />
          ) : (
            <div className="flex min-h-0 items-start gap-3 px-5 py-4">
              {columns.map((column) => (
                <section
                  key={column.status}
                  aria-label={column.label}
                  className={cn(
                    "flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border/55 bg-card/20 p-2",
                    column.muted && "opacity-72",
                  )}
                >
                  <header className="flex items-center justify-between px-1 py-0.5">
                    <span className="text-xs font-medium text-foreground">{column.label}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {column.issues.length}
                    </span>
                  </header>
                  {column.issues.length === 0 ? (
                    <p className="px-1 pb-1 text-muted-foreground/70 text-xs">Nothing here</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {column.issues.map((issue) => {
                        const blockers = resolveIssueBlockers(issue, issuesById);
                        const startDisabledReason = resolveIssueStartDisabledReason({
                          issue,
                          blockers,
                        });
                        const linkedThread =
                          issue.threadId === null
                            ? null
                            : (threadShells.find(
                                (thread) =>
                                  thread.environmentId === environmentId &&
                                  thread.id === issue.threadId,
                              ) ?? null);
                        const delegationLinks = resolveIssueDelegationLinks({
                          issue,
                          environmentIssues,
                          projectIdByThreadId,
                          projectTitleById,
                        });
                        return (
                          <li key={issue.id}>
                            <IssueCard
                              issue={issue}
                              delegationLinks={delegationLinks}
                              onOpenDelegationOrigin={() =>
                                void openDelegationOrigin(delegationLinks.origin)
                              }
                              onOpenDelegationTargets={() =>
                                void openDelegationTargets(delegationLinks.targets)
                              }
                              blockedBy={
                                blockers.length === 0 ? null : describeIssueBlockers(blockers)
                              }
                              startDisabledReason={startDisabledReason}
                              starting={startingIssueId === issue.id}
                              stopping={stoppingIssueId === issue.id}
                              awaitingInput={linkedThread?.hasPendingUserInput === true}
                              onEdit={() => setDialogTarget({ issue })}
                              onOpenThread={() => void openThread(issue)}
                              onUnlinkThread={() => void handleUnlinkThread(issue)}
                              onStop={() => void handleStop(issue)}
                              onStart={() => void handleStart(issue)}
                              onStatusChange={(status) => void handleStatusChange(issue, status)}
                              onDelete={() => setIssueToDelete(issue)}
                              runActive={runActive}
                              attentionPending={attention.pendingIssueId === issue.id}
                              onClearAttention={() => void attention.clearFlag(issue)}
                              onRetryAttention={() => void attention.retry(issue)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      <IssueDialog
        target={dialogTarget}
        environmentId={environmentId}
        projectId={projectId}
        issues={issues}
        onOpenChange={(open) => {
          if (!open) setDialogTarget(null);
        }}
      />

      <AlertDialog
        open={issueToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setIssueToDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{issueToDelete?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Issues that depend on it lose the dependency. Any thread it opened stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void handleDelete()}>
              Delete issue
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
  );
}

function IssueCard({
  issue,
  blockedBy,
  startDisabledReason,
  starting,
  stopping,
  awaitingInput,
  runActive,
  attentionPending,
  onEdit,
  onOpenThread,
  onUnlinkThread,
  onStop,
  onStart,
  onStatusChange,
  onDelete,
  onClearAttention,
  onRetryAttention,
  delegationLinks,
  onOpenDelegationOrigin,
  onOpenDelegationTargets,
}: {
  readonly issue: OrchestrationIssue;
  readonly delegationLinks: IssueDelegationLinks;
  readonly onOpenDelegationOrigin: () => void;
  readonly onOpenDelegationTargets: () => void;
  readonly blockedBy: string | null;
  readonly startDisabledReason: string | null;
  readonly starting: boolean;
  readonly stopping: boolean;
  readonly awaitingInput: boolean;
  readonly runActive: boolean;
  readonly attentionPending: boolean;
  readonly onEdit: () => void;
  readonly onOpenThread: () => void;
  readonly onUnlinkThread: () => void;
  readonly onStop: () => void;
  readonly onStart: () => void;
  readonly onStatusChange: (status: IssueStatus) => void;
  readonly onDelete: () => void;
  readonly onClearAttention: () => void;
  readonly onRetryAttention: () => void;
}) {
  const openPrLink = useOpenPrLink();
  const attentionPresentation = resolveIssueAttentionPresentation(issue);
  // Only work the run is actually driving gets the marker: a flagged issue is
  // parked, and the run has moved on without it.
  const drivenByRun =
    runActive &&
    !issueNeedsAttention(issue) &&
    (issue.status === "in_progress" || issue.status === "in_review");
  return (
    <div
      className={cn(
        "group/issue rounded-lg border bg-background p-2.5 shadow-xs/5",
        attentionPresentation === null ? "border-border/70" : "border-warning/40",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer text-left text-sm text-foreground outline-none focus-visible:underline"
          onClick={onEdit}
        >
          <span className="line-clamp-3">{issue.title}</span>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={`Actions for ${issue.title}`}
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-icon-muted"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuRadioGroup
              value={issue.status}
              onValueChange={(value) => onStatusChange(value as IssueStatus)}
            >
              {ISSUE_STATUS_COLUMNS.map((column) => (
                <MenuRadioItem key={column.status} value={column.status} closeOnClick>
                  {column.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            {attentionPresentation !== null ? (
              <>
                <MenuItem disabled={attentionPending} onClick={onClearAttention}>
                  Clear flag
                </MenuItem>
                {issueAttentionRetryKind(issue) === "pull-request" ? (
                  <MenuItem disabled={attentionPending} onClick={onRetryAttention}>
                    Retry pull request
                  </MenuItem>
                ) : issueRetryRestartsWork(issue) ? (
                  <MenuItem disabled={attentionPending} onClick={onRetryAttention}>
                    Clear & retry
                  </MenuItem>
                ) : null}
              </>
            ) : null}
            <MenuItem onClick={onEdit}>Edit issue</MenuItem>
            {issue.threadId !== null ? (
              <>
                <MenuItem onClick={onOpenThread}>Open thread</MenuItem>
                <MenuItem disabled={stopping} onClick={onStop}>
                  {stopping ? "Stopping…" : "Stop issue"}
                </MenuItem>
                <MenuItem onClick={onUnlinkThread}>Unlink thread</MenuItem>
              </>
            ) : null}
            <MenuItem variant="destructive" onClick={onDelete}>
              Delete issue
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {issue.priority === null ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground/70 text-xs">
            <CircleDashedIcon className="size-3" />
            No priority
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <span className={cn("size-2 rounded-full", PRIORITY_DOT_CLASS[issue.priority])} />
            {ISSUE_PRIORITY_LABEL[issue.priority]}
          </span>
        )}

        {issue.modelSelection !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="secondary" size="sm" className="max-w-full gap-1">
                  <BotIcon className="size-3 shrink-0" />
                  <span className="truncate">{issue.modelSelection.model}</span>
                </Badge>
              }
            />
            <TooltipPopup side="bottom">
              {issue.modelSelection.instanceId} · {issue.modelSelection.model}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {attentionPresentation !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="warning" size="sm" className="gap-1">
                  <TriangleAlertIcon className="size-3" />
                  Needs you
                </Badge>
              }
            />
            <TooltipPopup side="bottom">{attentionPresentation.reason}</TooltipPopup>
          </Tooltip>
        ) : null}

        {awaitingInput ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="warning" size="sm" className="gap-1">
                  <MessageSquareIcon className="size-3" />
                  Awaiting answer
                </Badge>
              }
            />
            <TooltipPopup side="bottom">Open the thread to answer the agent.</TooltipPopup>
          </Tooltip>
        ) : null}

        {drivenByRun ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="info" size="sm" className="gap-1">
                  <BotIcon className="size-3" />
                  Auto
                </Badge>
              }
            />
            <TooltipPopup side="bottom">Autonomous mode is driving this issue.</TooltipPopup>
          </Tooltip>
        ) : null}

        {blockedBy !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="secondary" size="sm" className="gap-1 text-muted-foreground">
                  <LockIcon className="size-3" />
                  Blocked
                </Badge>
              }
            />
            <TooltipPopup side="bottom">Waiting on {blockedBy}</TooltipPopup>
          </Tooltip>
        ) : null}

        {delegationLinks.origin !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  render={<button type="button" onClick={onOpenDelegationOrigin} />}
                  variant="outline"
                  size="sm"
                  className="max-w-full cursor-pointer gap-1 text-info-foreground"
                >
                  <ArrowDownLeftIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    From {delegationLinks.origin.projectTitle ?? "another project"}
                  </span>
                </Badge>
              }
            />
            <TooltipPopup side="bottom">
              {delegationLinks.origin.projectTitle === null
                ? "An agent in a linked project delegated this work here. Open the thread that sent it."
                : `An agent in ${delegationLinks.origin.projectTitle} delegated this work here. Open the thread that sent it.`}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {delegationLinks.targets.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  render={<button type="button" onClick={onOpenDelegationTargets} />}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "max-w-full gap-1 text-info-foreground",
                    countDelegationTargetProjects(delegationLinks.targets) === 1 &&
                      "cursor-pointer",
                  )}
                >
                  <ArrowUpRightIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    {describeDelegationTargets(delegationLinks.targets)}
                  </span>
                </Badge>
              }
            />
            <TooltipPopup side="bottom">
              <span className="block max-w-64 text-left">
                This issue's agent delegated work to{" "}
                {delegationLinks.targets
                  .map((target) => target.projectTitle ?? "another project")
                  .filter((title, index, all) => all.indexOf(title) === index)
                  .join(", ")}
                . It is tracked as {delegationLinks.targets.length === 1 ? "an issue" : "issues"} on
                that board.
              </span>
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {issue.threadId !== null ? (
          <button
            type="button"
            aria-label="Open the thread for this issue"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
            onClick={onOpenThread}
          >
            <MessageSquareIcon className="size-3" />
            Thread
          </button>
        ) : null}

        {issue.pullRequestUrl !== null ? (
          <a
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
            href={issue.pullRequestUrl}
            rel="noreferrer"
            target="_blank"
            onClick={(event) => openPrLink(event, issue.pullRequestUrl ?? "")}
          >
            <ExternalLinkIcon className="size-3" />
            Pull request
          </a>
        ) : null}
      </div>

      {issue.status === "backlog" ? (
        <div className="mt-2">
          {startDisabledReason === null ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={starting}
              onClick={onStart}
            >
              {starting ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              {starting ? "Starting..." : "Start"}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="block">
                    <Button size="sm" variant="outline" className="w-full" disabled>
                      <PlayIcon className="size-3.5" />
                      Start
                    </Button>
                  </span>
                }
              />
              <TooltipPopup side="bottom">{startDisabledReason}</TooltipPopup>
            </Tooltip>
          )}
        </div>
      ) : null}
    </div>
  );
}
