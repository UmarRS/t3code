import type { EnvironmentId, OrchestrationIssue, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import {
  buildReviewSections,
  formatBoardTitles,
  issueAttentionRetryKind,
  issueRetryDiscardsReview,
  issueRetryRestartsWork,
  resolveIssueAttentionPresentation,
  type AutonomousPlanBoards,
} from "./autonomousRun.logic";
import { useIssueAttentionActions, useStalledDependencyBoards } from "./useIssueAttentionActions";

/**
 * What autonomous mode produced: work it merged, and work it parked. Reviewer
 * notes are unbounded and live on the detail read, so a card only fetches them
 * once the user expands it — a long backlog renders as a list of headers, not a
 * page of markdown.
 */
export function IssuesReviewTab({
  environmentId,
  issues,
  workspaceRoot,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly issues: ReadonlyArray<OrchestrationIssue>;
  readonly workspaceRoot: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const sections = useMemo(() => buildReviewSections(issues), [issues]);
  const attention = useIssueAttentionActions(environmentId);
  const stalledDependencyBoards = useStalledDependencyBoards(environmentId);

  if (sections.completed.length === 0 && sections.needsAttention.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-base">Nothing reviewed yet</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            When autonomous mode merges an issue, or parks one for you, it shows up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6">
      {sections.needsAttention.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">
            Needs you ({sections.needsAttention.length})
          </h2>
          <ul className="flex flex-col gap-2">
            {sections.needsAttention.map((issue) => (
              <li key={issue.id}>
                <ReviewCard
                  environmentId={environmentId}
                  issue={issue}
                  workspaceRoot={workspaceRoot}
                  onOpenThread={onOpenThread}
                  pending={attention.pendingIssueId === issue.id}
                  stalledBoards={stalledDependencyBoards(issue)}
                  onClearFlag={() => void attention.clearFlag(issue)}
                  onRetry={() => void attention.retry(issue)}
                  onStartStalledBoards={(plan) => void attention.startBlockingBoards(issue, plan)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sections.completed.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">
            Merged ({sections.completed.length})
          </h2>
          <ul className="flex flex-col gap-2">
            {sections.completed.map((issue) => (
              <li key={issue.id}>
                <ReviewCard
                  environmentId={environmentId}
                  issue={issue}
                  workspaceRoot={workspaceRoot}
                  onOpenThread={onOpenThread}
                  pending={false}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ReviewCard({
  environmentId,
  issue,
  workspaceRoot,
  onOpenThread,
  pending,
  stalledBoards = null,
  onClearFlag,
  onRetry,
  onStartStalledBoards,
}: {
  readonly environmentId: EnvironmentId;
  readonly issue: OrchestrationIssue;
  readonly workspaceRoot: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly pending: boolean;
  /** The idle boards holding this issue's blocker, when that is why it is flagged. */
  readonly stalledBoards?: AutonomousPlanBoards | null;
  readonly onClearFlag?: () => void;
  readonly onRetry?: () => void;
  readonly onStartStalledBoards?: (plan: AutonomousPlanBoards) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const openPrLink = useOpenPrLink();
  const attentionPresentation = resolveIssueAttentionPresentation(issue);
  const flagged = attentionPresentation !== null;
  // Retrying reviewed work throws the verdict away with it, and that is the
  // whole difference between the two buttons — so the card says it.
  const discardsReview = flagged && issueRetryDiscardsReview(issue);

  // One detail read per expanded card, never for the collapsed list.
  const detail = useEnvironmentQuery(
    expanded ? issueEnvironment.detail({ environmentId, input: { issueId: issue.id } }) : null,
  );
  const reviewNotes = detail.data?.issue?.reviewNotes ?? "";
  const timestamp = issue.reviewedAt ?? issue.needsAttentionAt ?? issue.updatedAt;

  return (
    <div
      className={cn(
        "rounded-lg border bg-background p-3 shadow-xs/5",
        flagged ? "border-warning/40" : "border-border/70",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{issue.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {flagged ? (
              // An outage and a verdict are drawn apart on purpose: a plug is
              // the machinery failing, a triangle is a call on the code.
              <Badge variant="warning" size="sm" className="gap-1">
                {attentionPresentation.infrastructure ? (
                  <UnplugIcon className="size-3" />
                ) : (
                  <TriangleAlertIcon className="size-3" />
                )}
                {attentionPresentation.label}
              </Badge>
            ) : (
              <Badge variant="success" size="sm" className="gap-1">
                <CircleCheckIcon className="size-3" />
                Merged
              </Badge>
            )}
            <span className="text-muted-foreground text-xs">
              {formatRelativeTimeLabel(timestamp)}
            </span>
            {issue.pullRequestUrl ? (
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
            {issue.threadId ? (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                onClick={() => issue.threadId && onOpenThread(issue.threadId)}
              >
                <MessageSquareIcon className="size-3" />
                Worker thread
              </button>
            ) : null}
            {issue.reviewerThreadId ? (
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                onClick={() => issue.reviewerThreadId && onOpenThread(issue.reviewerThreadId)}
              >
                <MessageSquareIcon className="size-3" />
                Reviewer thread
              </button>
            ) : null}
          </div>
        </div>

        {flagged && onClearFlag && onRetry ? (
          <div className="flex shrink-0 items-center gap-2">
            {/* Clearing alone leaves the work where it is, which is what you
                want after taking the thread over yourself. Retry is only a
                distinct action once there is a thread or a status to reset. */}
            {issueRetryRestartsWork(issue) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                title={
                  discardsReview
                    ? "Unflag this issue and keep the reviewer's verdict."
                    : "Unflag this issue and leave the work where it is."
                }
                onClick={onClearFlag}
              >
                Clear flag
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title={
                discardsReview
                  ? "Discard this review and start the work again from the backlog."
                  : undefined
              }
              onClick={onRetry}
            >
              {pending ? <Spinner className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
              {issueAttentionRetryKind(issue) === "pull-request"
                ? "Retry pull request"
                : discardsReview
                  ? "Discard review & retry"
                  : issueRetryRestartsWork(issue)
                    ? "Clear & retry"
                    : "Clear flag"}
            </Button>
          </div>
        ) : null}
      </div>

      {attentionPresentation ? (
        <div className="mt-2 rounded-md bg-warning/8 px-2 py-1.5 text-xs text-warning-foreground">
          {/* The headline names what happened; the reactor's own reason stays
              underneath it, because that is the part with the detail in it. */}
          <p className="font-medium">{attentionPresentation.headline}</p>
          <p className="mt-0.5 opacity-90">{attentionPresentation.reason}</p>
          {discardsReview && onRetry ? (
            <p className="mt-1 opacity-90">
              Retry discards this review and starts the work over from the backlog. Clear flag keeps
              the review as it stands.
            </p>
          ) : null}
          {/* The stall says "start a run there". This is that run: the boards
              holding the blocker, plus whatever their own plans depend on,
              started together with this one. */}
          {stalledBoards === null || onStartStalledBoards === undefined ? null : (
            <Button
              size="sm"
              variant="outline"
              className="mt-1.5"
              disabled={pending}
              onClick={() => onStartStalledBoards(stalledBoards)}
            >
              {pending ? <Spinner className="size-3.5" /> : <BotIcon className="size-3.5" />}
              {stalledBoards.boards.length <= 2
                ? `Start ${formatBoardTitles(stalledBoards.boards)} too`
                : `Start ${stalledBoards.boards.length} other boards too`}
            </Button>
          )}
        </div>
      ) : null}

      <div className="mt-2">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDownIcon className={cn("size-3.5 transition-none", expanded && "rotate-180")} />
          {expanded ? "Hide reviewer notes" : "Reviewer notes"}
        </button>
        {expanded ? (
          detail.isPending && reviewNotes.length === 0 ? (
            <span className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs">
              <Spinner className="size-3" />
              Loading notes...
            </span>
          ) : reviewNotes.trim().length === 0 ? (
            <p className="mt-2 text-muted-foreground/70 text-xs">
              The reviewer left no notes for this issue.
            </p>
          ) : (
            <div className="mt-2 border-t border-border/55 pt-2">
              <ChatMarkdown cwd={workspaceRoot} isStreaming={false} text={reviewNotes} />
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
