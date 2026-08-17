import {
  activeAutonomousIssues,
  isProviderAvailable,
  issueNeedsAttention,
  startableAutonomousIssues,
  type AutonomousIssueView,
  type IssueId,
  type IssueReviewVerdict,
  type IssueStatus,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Pure derivations for autonomous mode: what state a project's run is in, how
 * far it has got, what the Review tab lists, and what "retry" actually has to
 * dispatch. The run rules themselves come from the shared contract helpers so
 * the badge and the server's reactor can never disagree.
 */

export interface AutonomousProjectView {
  readonly autonomousStartedAt?: string | null | undefined;
  readonly autonomousFinishedAt?: string | null | undefined;
  readonly autonomousFinishedReason?: "completed" | "disabled" | null | undefined;
}

export type AutonomousRunState =
  /** A run is live: the server is starting, reviewing and merging right now. */
  | { readonly kind: "running"; readonly startedAt: string | null }
  /** The server stopped itself because the backlog had nothing left to advance. */
  | { readonly kind: "finished"; readonly finishedAt: string | null }
  /** A user stopped it. In-flight threads may still be working. */
  | { readonly kind: "stopped"; readonly finishedAt: string | null }
  /** Never run on this project. */
  | { readonly kind: "idle" };

export function resolveAutonomousRunState(
  project: AutonomousProjectView | null | undefined,
): AutonomousRunState {
  if (!project) return { kind: "idle" };
  if (project.autonomousStartedAt != null) {
    return { kind: "running", startedAt: project.autonomousStartedAt };
  }
  const finishedAt = project.autonomousFinishedAt ?? null;
  if (project.autonomousFinishedReason === "completed") {
    return { kind: "finished", finishedAt };
  }
  if (project.autonomousFinishedReason === "disabled") {
    return { kind: "stopped", finishedAt };
  }
  return { kind: "idle" };
}

export function isAutonomousRunActive(state: AutonomousRunState): boolean {
  return state.kind === "running";
}

export function autonomousRunActionLabel(state: AutonomousRunState): string {
  switch (state.kind) {
    case "running":
      return "Stop";
    case "stopped":
      return "Resume";
    case "finished":
      return "Start";
    case "idle":
      return "Autonomous mode";
  }
}

export interface AutonomousProgress {
  /** Backlog issues the run can pick up right now. */
  readonly queued: number;
  readonly inProgress: number;
  readonly inReview: number;
  /**
   * Finished work still worth showing in this run's readout. An issue drops
   * out of this the moment the server files it away as `archived` (a day of
   * quiet in `done`): archived work belongs to project history, not to a
   * running or just-finished progress readout. Counting it forever was the
   * bug this replaced — every board eventually read "N done / M" for a run
   * whose actual issues had long since archived, with the header stuck
   * announcing "finished" indefinitely.
   */
  readonly done: number;
  readonly needsAttention: number;
  /** Everything the run counts as work: canceled and archived issues are out of scope. */
  readonly total: number;
}

interface ProgressIssueView extends AutonomousIssueView {
  readonly status: IssueStatus;
}

export function summarizeAutonomousProgress(
  issues: ReadonlyArray<ProgressIssueView>,
): AutonomousProgress {
  const active = activeAutonomousIssues(issues);
  // needsAttention is counted over every issue, archived included, before the
  // in-scope filter below — flagged work must never be hidden by its siblings
  // archiving out from under it. In practice this never matters: a flagged
  // issue is rarely `done`, so it is rarely eligible to archive at all.
  const needsAttention = issues.filter((issue) => issueNeedsAttention(issue)).length;
  const inScope = issues.filter((issue) => issue.status !== "archived");
  return {
    queued: startableAutonomousIssues(issues).length,
    inProgress: active.filter((issue) => issue.status === "in_progress").length,
    inReview: active.filter((issue) => issue.status === "in_review").length,
    done: inScope.filter((issue) => issue.status === "done").length,
    needsAttention,
    total: inScope.filter((issue) => issue.status !== "canceled").length,
  };
}

/**
 * The compact run summary, e.g. "3 in progress · 2 in review · 5 done / 12".
 * Empty segments are dropped so a quiet run does not read as a wall of zeros.
 */
export function formatAutonomousProgressLabel(progress: AutonomousProgress): string {
  const segments: string[] = [];
  if (progress.inProgress > 0) segments.push(`${progress.inProgress} in progress`);
  if (progress.inReview > 0) segments.push(`${progress.inReview} in review`);
  if (progress.queued > 0) segments.push(`${progress.queued} queued`);
  if (progress.needsAttention > 0) segments.push(`${progress.needsAttention} needs you`);
  segments.push(`${progress.done} done / ${progress.total}`);
  return segments.join(" · ");
}

export interface AutonomousStatusPresentation {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: "active" | "complete" | "stopped" | "idle";
}

/** What the header badge says for the current run state. */
export function describeAutonomousRunStatus(input: {
  readonly state: AutonomousRunState;
  readonly progress: AutonomousProgress;
}): AutonomousStatusPresentation {
  switch (input.state.kind) {
    case "running":
      return {
        label: "Autonomous",
        detail: formatAutonomousProgressLabel(input.progress),
        tone: "active",
      };
    case "finished": {
      // The finished badge retires when its work is filed away: once every
      // issue the run touched has archived (or the run never had any in
      // scope to begin with), `total` reads zero and there is nothing left
      // to announce — present as idle rather than an eternal "finished".
      // Flagged work is the one exception: it needs a human regardless of
      // what has archived around it, so it keeps the finished/needs-you
      // presentation even at total 0.
      if (input.progress.total === 0 && input.progress.needsAttention === 0) {
        return { label: "Autonomous", detail: null, tone: "idle" };
      }
      return {
        label: "Autonomous finished",
        detail:
          input.progress.needsAttention > 0
            ? input.progress.needsAttention === 1
              ? "1 issue needs you"
              : `${input.progress.needsAttention} issues need you`
            : `${input.progress.done} done / ${input.progress.total}`,
        tone: "complete",
      };
    }
    case "stopped":
      return {
        label: "Autonomous stopped",
        // Stopping does not kill in-flight threads, so say what is still moving.
        detail:
          input.progress.inProgress + input.progress.inReview > 0
            ? `${input.progress.inProgress + input.progress.inReview} still finishing`
            : null,
        tone: "stopped",
      };
    case "idle":
      return { label: "Autonomous", detail: null, tone: "idle" };
  }
}

export interface ReviewIssueView {
  readonly id: IssueId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly threadId?: ThreadId | null | undefined;
  readonly pullRequestUrl?: string | null | undefined;
  readonly needsAttentionAt?: string | null | undefined;
  readonly needsAttentionReason?: string | null | undefined;
  readonly reviewVerdict?: IssueReviewVerdict | null | undefined;
  readonly reviewerThreadId?: ThreadId | null | undefined;
  readonly reviewedAt?: string | null | undefined;
  readonly updatedAt: string;
}

export interface ReviewSections<TIssue extends ReviewIssueView> {
  /** Work the reviewer merged, newest first. */
  readonly completed: ReadonlyArray<TIssue>;
  /** Work parked for a human, newest flag first. */
  readonly needsAttention: ReadonlyArray<TIssue>;
}

function reviewSortKey(issue: ReviewIssueView): string {
  return issue.reviewedAt ?? issue.updatedAt;
}

/**
 * Splits the backlog into the two lists the Review tab shows. A flagged issue
 * only ever appears under "needs attention", even when it carries an earlier
 * verdict, so nothing is listed twice.
 */
export function buildReviewSections<TIssue extends ReviewIssueView>(
  issues: ReadonlyArray<TIssue>,
): ReviewSections<TIssue> {
  return {
    completed: issues
      .filter((issue) => !issueNeedsAttention(issue) && issue.reviewVerdict === "merged")
      .toSorted((left, right) => reviewSortKey(right).localeCompare(reviewSortKey(left))),
    needsAttention: issues
      .filter((issue) => issueNeedsAttention(issue))
      .toSorted((left, right) =>
        (right.needsAttentionAt ?? right.updatedAt).localeCompare(
          left.needsAttentionAt ?? left.updatedAt,
        ),
      ),
  };
}

const DEFAULT_ATTENTION_REASON = "Autonomous mode could not finish this issue.";

export interface IssueAttentionPresentation {
  readonly reason: string;
  /** True when a reviewer looked at the work and refused to merge it. */
  readonly fromReview: boolean;
}

export function resolveIssueAttentionPresentation(
  issue: ReviewIssueView,
): IssueAttentionPresentation | null {
  if (!issueNeedsAttention(issue)) return null;
  return {
    reason: issue.needsAttentionReason?.trim() || DEFAULT_ATTENTION_REASON,
    fromReview: issue.reviewVerdict === "needs_attention",
  };
}

/**
 * Clearing the flag is all a backlog issue needs; anything further along keeps
 * its thread and its status, so it becomes startable again only after the
 * thread link is dropped and it is put back in the backlog. These are the exact
 * commands each affordance has to dispatch, in order.
 */
export type IssueRetryStep =
  | { readonly kind: "clear-attention" }
  | { readonly kind: "unlink-thread" }
  | { readonly kind: "reset-to-backlog" };

export function planIssueAttentionClear(): ReadonlyArray<IssueRetryStep> {
  return [{ kind: "clear-attention" }];
}

export function planIssueAttentionRetry(
  issue: Pick<ReviewIssueView, "status" | "threadId" | "needsAttentionReason">,
): ReadonlyArray<IssueRetryStep> {
  const steps: IssueRetryStep[] = [{ kind: "clear-attention" }];
  if (issueAttentionRetryKind(issue) === "pull-request") {
    return steps;
  }
  if (issue.threadId != null) {
    steps.push({ kind: "unlink-thread" });
  }
  if (issue.status !== "backlog") {
    steps.push({ kind: "reset-to-backlog" });
  }
  return steps;
}

/** Whether "retry" would do more than clear the flag. */
export function issueRetryRestartsWork(
  issue: Pick<ReviewIssueView, "status" | "threadId" | "needsAttentionReason">,
): boolean {
  return planIssueAttentionRetry(issue).length > 1;
}

export function issueAttentionRetryKind(
  issue: Pick<ReviewIssueView, "status" | "threadId" | "needsAttentionReason">,
): "clear" | "pull-request" | "restart-work" {
  const reason = issue.needsAttentionReason?.toLowerCase() ?? "";
  if (
    issue.status === "in_progress" &&
    issue.threadId != null &&
    (reason.includes("could not open a pull request") ||
      reason.includes("without producing a pull request"))
  ) {
    return "pull-request";
  }
  return issue.threadId != null || issue.status !== "backlog" ? "restart-work" : "clear";
}

const REVIEWER_DRIVER = "claudeAgent";

/**
 * Pre-flight for the enable button: without a usable Claude provider the run
 * still starts work, but every review parks its issue instead of merging.
 * Mirrors the server's reviewer-model rule, and is a warning rather than a
 * block — the server stays the authority.
 */
export function hasAutonomousReviewerProvider(providers: ReadonlyArray<ServerProvider>): boolean {
  return providers.some(
    (provider) =>
      provider.driver === REVIEWER_DRIVER &&
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.models.length > 0,
  );
}
