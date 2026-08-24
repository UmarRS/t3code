import {
  activeAutonomousIssues,
  blockedAutonomousIssues,
  isProviderAvailable,
  issueNeedsAttention,
  reachableAutonomousProjectIds,
  startableAutonomousIssues,
  unfinishedIssueDependencies,
  type AutonomousIssueView,
  type AutonomousScope,
  type EnvironmentId,
  type IssueAttentionKind,
  type IssueId,
  type IssueReviewVerdict,
  type IssueStatus,
  type ProjectId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

import { sidebarProjectPrefKey } from "~/sidebarProjectPrefsStore";

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

/**
 * The switch's label where the surrounding UI already names autonomous mode —
 * the overview's Agent column says what the run is doing, so its button only
 * has to say what pressing it does.
 */
export function autonomousRunCompactActionLabel(state: AutonomousRunState): string {
  switch (state.kind) {
    case "running":
      return "Stop";
    case "stopped":
      return "Resume";
    case "finished":
    case "idle":
      return "Start";
  }
}

export interface AutonomousProgress {
  /** Backlog issues the run can pick up right now. */
  readonly queued: number;
  /**
   * Backlog issues waiting on unfinished work. Worth its own number now that a
   * dependency may sit on another board: a run with nothing queued and nothing
   * in flight is not idle, it is waiting, and this is what says so.
   */
  readonly blocked: number;
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

/**
 * One board's progress. `issues` may span boards — pass the environment's when
 * a dependency can cross between them — with `scope` naming the board being
 * summarised: dependencies resolve over everything given, counts cover the
 * board alone.
 */
export function summarizeAutonomousProgress(
  issues: ReadonlyArray<ProgressIssueView>,
  scope?: AutonomousScope,
): AutonomousProgress {
  const board =
    scope?.projectId === undefined
      ? issues
      : issues.filter((issue) => issue.projectId === scope.projectId);
  const active = activeAutonomousIssues(issues, scope);
  // needsAttention is counted over every issue, archived included, before the
  // in-scope filter below — flagged work must never be hidden by its siblings
  // archiving out from under it. In practice this never matters: a flagged
  // issue is rarely `done`, so it is rarely eligible to archive at all.
  const needsAttention = board.filter((issue) => issueNeedsAttention(issue)).length;
  const inScope = board.filter((issue) => issue.status !== "archived");
  return {
    queued: startableAutonomousIssues(issues, scope).length,
    blocked: blockedAutonomousIssues(issues, scope).length,
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
  if (progress.blocked > 0) segments.push(`${progress.blocked} blocked`);
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

/**
 * The finished run's dismissal key for the "Review results" button — the same
 * physical-project key the sidebar prefs use, extended with `finishedAt` so a
 * dismissal only ever covers the run that earned it. Null when the run has no
 * `finishedAt` to key on, which leaves the button un-dismissable rather than
 * accidentally shared across runs.
 */
export function autonomousFinishedRunReviewKey(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly finishedAt: string | null;
}): string | null {
  if (input.finishedAt === null) return null;
  return `${sidebarProjectPrefKey(input)}:${input.finishedAt}`;
}

/**
 * Whether the "Review results" button should render. Additive to the rule
 * that keeps it on the raw run state rather than the badge tone: dismissal
 * only ever hides a run the user has already acknowledged, never a fresh one.
 */
export function shouldShowFinishedRunReviewButton(input: {
  readonly runState: AutonomousRunState;
  readonly reviewKey: string | null;
  readonly dismissedKeys: ReadonlySet<string>;
}): boolean {
  if (input.runState.kind !== "finished") return false;
  return input.reviewKey === null || !input.dismissedKeys.has(input.reviewKey);
}

export interface ReviewIssueView {
  readonly id: IssueId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly threadId?: ThreadId | null | undefined;
  readonly pullRequestUrl?: string | null | undefined;
  readonly needsAttentionAt?: string | null | undefined;
  readonly needsAttentionReason?: string | null | undefined;
  /** Null on issues parked before kinds existed; see `resolveIssueAttentionKind`. */
  readonly needsAttentionKind?: IssueAttentionKind | null | undefined;
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

/** Both halves of the flag, which is all classifying one takes. */
type AttentionKindView = Pick<
  ReviewIssueView,
  "needsAttentionReason" | "needsAttentionKind" | "reviewVerdict"
>;

/**
 * The kind an issue was parked with, for rows that predate the structured
 * kind. Everything the server writes now carries one; a null kind is history,
 * and the only honest thing left to read is the reason text the reactor wrote.
 * The substrings below are exactly the phrases the reactor used at the time,
 * so this is a fallback for old rows and not a second classifier.
 */
function inferAttentionKindFromReason(issue: AttentionKindView): IssueAttentionKind {
  const reason = issue.needsAttentionReason?.toLowerCase() ?? "";
  if (
    reason.includes("could not open a pull request") ||
    reason.includes("without producing a pull request")
  ) {
    return "pull_request_failed";
  }
  if (
    reason.includes("the code has not been reviewed") ||
    reason.includes("no claude provider is available to review") ||
    reason.includes("no worktree to review") ||
    reason.includes("could not start the review") ||
    reason.includes("could not restart the review")
  ) {
    return "review_unavailable";
  }
  if (reason.includes("blocked by")) return "blocked";
  if (
    reason.includes("could not start work") ||
    reason.includes("the work could not be started") ||
    reason.includes("no provider is configured to do this work")
  ) {
    return "start_failed";
  }
  // A recorded refusal is the one kind the read model can still prove without
  // the reason text: the reviewer wrote a verdict.
  if (issue.reviewVerdict === "needs_attention") return "review_needs_attention";
  return "other";
}

/**
 * The kind to branch on. Structured when the server recorded one, inferred
 * from the reason text only for rows flagged before kinds existed.
 */
export function resolveIssueAttentionKind(issue: AttentionKindView): IssueAttentionKind {
  return issue.needsAttentionKind ?? inferAttentionKindFromReason(issue);
}

export interface IssueAttentionPresentation {
  readonly reason: string;
  /** What sort of park this is, so the UI can word an outage unlike a verdict. */
  readonly kind: IssueAttentionKind;
  /** The badge text. Short enough for a board card. */
  readonly label: string;
  /**
   * One line naming what actually happened, in front of the reactor's own
   * reason text. `review_unavailable` says outright that nobody read the code,
   * because the reason alone reads like a complaint about the change.
   */
  readonly headline: string;
  /**
   * Whether this park is a statement about the machinery rather than about the
   * code. The UI uses it to pick an icon that does not look like a judgement.
   */
  readonly infrastructure: boolean;
}

export function resolveIssueAttentionPresentation(
  issue: ReviewIssueView,
): IssueAttentionPresentation | null {
  if (!issueNeedsAttention(issue)) return null;
  const kind = resolveIssueAttentionKind(issue);
  return {
    reason: issue.needsAttentionReason?.trim() || DEFAULT_ATTENTION_REASON,
    kind,
    label: ATTENTION_LABEL[kind],
    headline: ATTENTION_HEADLINE[kind],
    infrastructure: INFRASTRUCTURE_ATTENTION_KINDS.has(kind),
  };
}

const ATTENTION_LABEL: Record<IssueAttentionKind, string> = {
  review_needs_attention: "Review needs attention",
  review_unavailable: "Not reviewed",
  pull_request_failed: "No pull request",
  blocked: "Blocked",
  start_failed: "Could not start",
  other: "Needs you",
};

const ATTENTION_HEADLINE: Record<IssueAttentionKind, string> = {
  review_needs_attention: "The reviewer read this change and left it unmerged.",
  review_unavailable: "This code was never reviewed — no reviewer could run.",
  pull_request_failed: "The work is done, but no pull request could be opened.",
  blocked: "This is waiting on work nothing is doing.",
  start_failed: "This issue never got started.",
  other: "Autonomous mode stopped short of finishing this issue.",
};

/**
 * The parks that say nothing about the change itself. Grouping them is what
 * keeps an outage from being drawn with the same warning triangle a reviewer's
 * refusal earns.
 */
const INFRASTRUCTURE_ATTENTION_KINDS: ReadonlySet<IssueAttentionKind> = new Set<IssueAttentionKind>(
  ["review_unavailable", "pull_request_failed", "start_failed"],
);

/**
 * What deciding a flagged issue's affordance needs to read: its position, and
 * both halves of the flag — the kind when there is one, the reason text as the
 * fallback for rows that predate it.
 */
type AttentionRetryView = AttentionKindView & Pick<ReviewIssueView, "status" | "threadId">;

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

export function planIssueAttentionRetry(issue: AttentionRetryView): ReadonlyArray<IssueRetryStep> {
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
export function issueRetryRestartsWork(issue: AttentionRetryView): boolean {
  return planIssueAttentionRetry(issue).length > 1;
}

/**
 * What the affordance on a flagged issue actually is.
 *
 * A pull request that failed to open is the one park where the worker's own
 * output is still good: retrying it must keep the thread and the branch, not
 * throw the work away. That decision now reads the kind; the reason text is
 * only consulted for rows flagged before kinds existed, which is what keeps
 * history behaving.
 */
export function issueAttentionRetryKind(
  issue: AttentionRetryView,
): "clear" | "pull-request" | "restart-work" {
  if (
    issue.status === "in_progress" &&
    issue.threadId != null &&
    resolveIssueAttentionKind(issue) === "pull_request_failed"
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

/**
 * Boards, as the run switch talks about them: a plan that spans repositories is
 * worked by more than one run, and the switch has to name the others.
 */
export interface AutonomousBoardRef {
  readonly id: ProjectId;
  readonly title: string;
}

export interface AutonomousBoardView extends AutonomousBoardRef {
  readonly autonomousStartedAt?: string | null | undefined;
}

/** Sorted by title so the same set always reads the same way. */
function toBoardRefs(
  projectIds: Iterable<ProjectId>,
  byId: ReadonlyMap<ProjectId, AutonomousBoardView>,
): ReadonlyArray<AutonomousBoardRef> {
  const boards: AutonomousBoardRef[] = [];
  for (const projectId of projectIds) {
    const board = byId.get(projectId);
    if (board === undefined) continue;
    boards.push({ id: board.id, title: board.title });
  }
  return boards.toSorted((left, right) => left.title.localeCompare(right.title));
}

/** "Acme", "Acme and Acme Web", "Acme, Acme Web and Acme API". */
export function formatBoardTitles(boards: ReadonlyArray<AutonomousBoardRef>): string {
  const titles = boards.map((board) => board.title);
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

export interface AutonomousPlanBoards {
  /**
   * The other boards to name in the confirmation, already filtered to the ones
   * this action would actually change: boards it is about to start, or boards
   * it is about to stop. Empty when the plan does not leave this board, which
   * is what leaves the ordinary single-board dialog unchanged.
   */
  readonly boards: ReadonlyArray<AutonomousBoardRef>;
  /**
   * What to send as the command's `additionalProjectIds`: every other board the
   * plan reaches, whatever state it is in. The server drops the ones the action
   * cannot change (already running, already stopped, gone), so this stays the
   * plan's shape rather than a snapshot of liveness the client raced to read.
   */
  readonly additionalProjectIds: ReadonlyArray<ProjectId>;
}

/**
 * The boards one press of the run switch acts on.
 *
 * Starting offers the boards this board's plan waits on that are not already
 * running — enabling them separately is what leaves the window where this board
 * ticks, finds its work blocked by a board that is still off, and flags it.
 *
 * Stopping is symmetric, and deliberately narrower: only boards that are still
 * live *and* still reachable from this plan come back, so a board the user
 * started on its own is never swept up by stopping this one.
 */
export function resolveAutonomousPlanBoards(input: {
  readonly issues: ReadonlyArray<AutonomousIssueView>;
  readonly projects: ReadonlyArray<AutonomousBoardView>;
  readonly projectId: ProjectId;
  readonly action: "enable" | "stop";
}): AutonomousPlanBoards {
  const byId = new Map(input.projects.map((project) => [project.id, project] as const));
  const reachable = [...reachableAutonomousProjectIds(input.issues, input.projectId)].filter(
    (projectId) => projectId !== input.projectId,
  );
  const named = reachable.filter((projectId) => {
    const board = byId.get(projectId);
    if (board === undefined) return false;
    return input.action === "enable"
      ? board.autonomousStartedAt == null
      : board.autonomousStartedAt != null;
  });
  return { boards: toBoardRefs(named, byId), additionalProjectIds: reachable };
}

/** The sentence the confirmation dialog adds when a plan spans boards. */
export function describeAutonomousPlanBoards(
  plan: AutonomousPlanBoards,
  action: "enable" | "stop",
): string | null {
  if (plan.boards.length === 0) return null;
  const titles = formatBoardTitles(plan.boards);
  return action === "enable"
    ? `Also starts ${titles}, which this plan depends on.`
    : `Also stops ${titles}, started with this run.`;
}

/**
 * Whether switching a blocker's board on is what would move it.
 *
 * Mirrors the one branch of the run's own `canAdvance` that turns on board
 * liveness: unstarted backlog work with nobody already on it. A blocker that is
 * canceled, flagged, or already carried by a thread is stuck for a reason a run
 * cannot fix, so offering to start its board would clear this issue's flag and
 * restart boards only for the run to give up again on the next tick.
 */
function blockerWaitsOnItsBoard(blocker: AutonomousIssueView): boolean {
  return (
    blocker.status === "backlog" &&
    !issueNeedsAttention(blocker) &&
    blocker.threadId == null &&
    blocker.delegatedFromThreadId == null
  );
}

/**
 * The boards to start from a flagged issue's card: the ones holding what it is
 * blocked on, that nobody is running. This is the dead end `describeStall`
 * names on the server — a blocker sitting in a backlog with no run — offered
 * back as an action rather than only as an explanation.
 *
 * `additionalProjectIds` carries each blocking board's own plan too, since a
 * board started here can be stuck behind a third board in exactly the same way.
 * Null when nothing is stuck behind an idle board, which is every other reason
 * an issue is flagged.
 */
export function resolveStalledDependencyBoards(input: {
  readonly issue: AutonomousIssueView;
  readonly issues: ReadonlyArray<AutonomousIssueView>;
  readonly projects: ReadonlyArray<AutonomousBoardView>;
}): AutonomousPlanBoards | null {
  const byId = new Map(input.projects.map((project) => [project.id, project] as const));
  const blocking = new Set<ProjectId>();
  for (const blocker of unfinishedIssueDependencies(input.issue, input.issues)) {
    if (blocker.projectId === input.issue.projectId) continue;
    if (!blockerWaitsOnItsBoard(blocker)) continue;
    const board = byId.get(blocker.projectId);
    if (board === undefined || board.autonomousStartedAt != null) continue;
    blocking.add(blocker.projectId);
  }
  if (blocking.size === 0) return null;
  const additionalProjectIds = new Set<ProjectId>(blocking);
  for (const projectId of blocking) {
    for (const reached of reachableAutonomousProjectIds(input.issues, projectId)) {
      if (reached !== input.issue.projectId) additionalProjectIds.add(reached);
    }
  }
  return { boards: toBoardRefs(blocking, byId), additionalProjectIds: [...additionalProjectIds] };
}
