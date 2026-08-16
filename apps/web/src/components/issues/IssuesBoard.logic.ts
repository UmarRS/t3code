import {
  findIssueDependencyCycle,
  isIssueDependencySatisfied,
  ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS,
  type IssueId,
  type IssuePriority,
  type IssueStatus,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Pure board derivations: what each column holds, which issues are gated on
 * unfinished work, and which issues a dependency picker may still offer. The
 * board component stays a renderer of these results.
 */

export interface BoardIssue {
  readonly id: IssueId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly priority: IssuePriority | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
  readonly createdAt: string;
}

export interface IssueBoardColumn<TIssue extends BoardIssue> {
  readonly status: IssueStatus;
  readonly label: string;
  /** Finished work reads as history: rendered muted and collapsed by default. */
  readonly muted: boolean;
  readonly issues: ReadonlyArray<TIssue>;
}

interface IssueStatusColumnDefinition {
  readonly status: IssueStatus;
  readonly label: string;
  readonly muted: boolean;
}

/** Left-to-right column order. Fixed: the board is a pipeline, not a filter. */
export const ISSUE_STATUS_COLUMNS: ReadonlyArray<IssueStatusColumnDefinition> = [
  { status: "backlog", label: "Backlog", muted: false },
  { status: "in_progress", label: "In Progress", muted: false },
  { status: "in_review", label: "In Review", muted: false },
  { status: "done", label: "Done", muted: true },
  { status: "canceled", label: "Canceled", muted: true },
];

export const ISSUE_STATUS_LABEL: Readonly<Record<IssueStatus, string>> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const ISSUE_PRIORITY_LABEL: Readonly<Record<IssuePriority, string>> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Highest first. `IssuePriority` carries no ordering, so the UI defines one. */
export const ISSUE_PRIORITY_ORDER: ReadonlyArray<IssuePriority> = [
  "urgent",
  "high",
  "medium",
  "low",
];

export function issuePriorityRank(priority: IssuePriority | null): number {
  const index = priority === null ? -1 : ISSUE_PRIORITY_ORDER.indexOf(priority);
  return index < 0 ? ISSUE_PRIORITY_ORDER.length : index;
}

/**
 * Groups the project backlog into its columns. Within a column the most urgent
 * work sorts first, then the oldest, so a column reads as a queue.
 */
export function buildIssueBoardColumns<TIssue extends BoardIssue>(
  issues: ReadonlyArray<TIssue>,
): ReadonlyArray<IssueBoardColumn<TIssue>> {
  return ISSUE_STATUS_COLUMNS.map((column) => ({
    status: column.status,
    label: column.label,
    muted: column.muted,
    issues: issues
      .filter((issue) => issue.status === column.status)
      .toSorted(
        (left, right) =>
          issuePriorityRank(left.priority) - issuePriorityRank(right.priority) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
  }));
}

export function indexIssuesById<TIssue extends BoardIssue>(
  issues: ReadonlyArray<TIssue>,
): ReadonlyMap<IssueId, TIssue> {
  return new Map(issues.map((issue) => [issue.id, issue] as const));
}

/**
 * The dependencies still standing between an issue and its start. A dependency
 * whose issue was deleted no longer blocks — the server agrees — and only
 * `done` satisfies one, so a canceled dependency still gates the work.
 */
export function resolveIssueBlockers<TIssue extends BoardIssue>(
  issue: BoardIssue,
  issuesById: ReadonlyMap<IssueId, TIssue>,
): ReadonlyArray<TIssue> {
  return issue.dependsOn.flatMap((dependencyId) => {
    const dependency = issuesById.get(dependencyId);
    if (dependency === undefined || isIssueDependencySatisfied(dependency.status)) {
      return [];
    }
    return [dependency];
  });
}

export function describeIssueBlockers(blockers: ReadonlyArray<BoardIssue>): string {
  if (blockers.length === 0) {
    return "";
  }
  const titles = blockers.map((blocker) => blocker.title);
  const listed = titles.slice(0, 3).join(", ");
  const remaining = titles.length - 3;
  return remaining > 0 ? `${listed} and ${remaining} more` : listed;
}

/**
 * Why the Start button is unavailable, or null when the issue can be started.
 * The server is the authority — this only keeps the user from firing a request
 * that is already known to be rejected.
 */
export function resolveIssueStartDisabledReason(input: {
  readonly issue: Pick<BoardIssue, "status"> & { readonly threadId: string | null };
  readonly blockers: ReadonlyArray<BoardIssue>;
}): string | null {
  if (input.issue.threadId !== null) {
    return "This issue already has a thread. Unlink it to start again.";
  }
  if (input.blockers.length > 0) {
    return `Blocked by ${describeIssueBlockers(input.blockers)}.`;
  }
  return null;
}

/**
 * The issues a dependency picker may still offer: everything in the project
 * except the issue itself and anything that would close a cycle once added to
 * the current selection.
 */
export function filterIssueDependencyCandidates<TIssue extends BoardIssue>(input: {
  readonly issues: ReadonlyArray<TIssue>;
  readonly issueId: IssueId;
  readonly selected: ReadonlyArray<IssueId>;
}): ReadonlyArray<TIssue> {
  const selected = new Set(input.selected);
  return input.issues.filter((candidate) => {
    if (candidate.id === input.issueId) {
      return false;
    }
    if (selected.has(candidate.id)) {
      return true;
    }
    return (
      findIssueDependencyCycle(input.issues, {
        issueId: input.issueId,
        dependsOn: [...input.selected, candidate.id],
      }) === null
    );
  });
}

/** The line the user replaces with the feature they want broken down. */
export const ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER =
  "Replace this line with the feature you want broken down.";

/**
 * The seed prompt for the story-decomposition thread: a place for the user's
 * feature description, then the canonical block instructions from contracts.
 */
export function buildIssueDecompositionPrompt(input: {
  readonly projectTitle: string;
  readonly availableModels?: ReadonlyArray<{ readonly instanceId: string; readonly model: string }>;
}): string {
  const availableModels = input.availableModels ?? [];
  return [
    `Break this work for ${input.projectTitle} into stories. Ask me every clarifying question you have before emitting the block — once the stories exist they are worked without my input.`,
    "",
    ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER,
    "",
    ...(availableModels.length > 0
      ? [
          "Configured worker models (choose only from this list when setting modelSelection):",
          ...availableModels.map((selection) => `- ${selection.instanceId}: ${selection.model}`),
          "Assign one of these modelSelection values to every story based on the work it requires.",
          "",
        ]
      : []),
    ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS.trim(),
    "",
  ].join("\n");
}

/**
 * Cross-project links for one issue.
 *
 * Delegation crosses boards in one direction — a worker in one project hands a
 * task to another, and the task lands there as an issue carrying the thread it
 * came from — so each side sees the other differently. The receiving issue
 * knows its origin thread outright; the sending issue has to be found by the
 * issues that name its thread. Both are worth a mark on the card: a board that
 * shows neither makes delegated work look like it appeared from nowhere.
 *
 * The outgoing half is therefore only as stable as the sender's thread: the
 * delegated issue records the thread that filed it, so unlinking that thread
 * and starting the issue again drops the sending card's mark while the
 * receiving one keeps pointing at the original thread. Carrying the link
 * across a restart would mean recording the sending issue, not its thread.
 */

export interface CrossProjectIssueView {
  readonly id: IssueId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly delegatedFromThreadId?: ThreadId | null | undefined;
}

export interface IssueDelegationOrigin {
  /** The thread that delegated the work, in whichever project owns it. */
  readonly threadId: ThreadId;
  /** Null when the origin thread is not in the loaded snapshot. */
  readonly projectId: ProjectId | null;
  readonly projectTitle: string | null;
}

export interface IssueDelegationTarget {
  readonly issueId: IssueId;
  readonly projectId: ProjectId;
  readonly projectTitle: string | null;
}

export interface IssueDelegationLinks {
  /** Set when this issue was filed here by another project's agent. */
  readonly origin: IssueDelegationOrigin | null;
  /** Issues this one's worker filed on other boards, in discovery order. */
  readonly targets: ReadonlyArray<IssueDelegationTarget>;
}

/** Delegated issues grouped by the thread that filed them. */
export type DelegationTargetsByOriginThread = ReadonlyMap<
  ThreadId,
  ReadonlyArray<IssueDelegationTarget>
>;

const NO_DELEGATION_LINKS: IssueDelegationLinks = { origin: null, targets: [] };
const NO_TARGETS: ReadonlyArray<IssueDelegationTarget> = [];

/**
 * Groups the environment's issues by the thread each was delegated from, so a
 * board resolves its outgoing links with a lookup per card rather than a scan
 * of every issue in the environment per card.
 */
export function indexDelegationTargetsByOriginThread(input: {
  readonly environmentIssues: ReadonlyArray<CrossProjectIssueView>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}): DelegationTargetsByOriginThread {
  const index = new Map<ThreadId, Array<IssueDelegationTarget>>();
  for (const issue of input.environmentIssues) {
    const originThreadId = issue.delegatedFromThreadId ?? null;
    if (originThreadId === null) continue;
    const target: IssueDelegationTarget = {
      issueId: issue.id,
      projectId: issue.projectId,
      projectTitle: input.projectTitleById.get(issue.projectId) ?? null,
    };
    const existing = index.get(originThreadId);
    if (existing === undefined) {
      index.set(originThreadId, [target]);
    } else {
      existing.push(target);
    }
  }
  return index;
}

export function resolveIssueDelegationLinks(input: {
  readonly issue: CrossProjectIssueView;
  readonly targetsByOriginThread: DelegationTargetsByOriginThread;
  /** Project of a thread id, for naming the far side of an incoming link. */
  readonly projectIdByThreadId: ReadonlyMap<ThreadId, ProjectId>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}): IssueDelegationLinks {
  const { issue } = input;
  const originThreadId = issue.delegatedFromThreadId ?? null;
  const origin =
    originThreadId === null
      ? null
      : ((): IssueDelegationOrigin => {
          const projectId = input.projectIdByThreadId.get(originThreadId) ?? null;
          return {
            threadId: originThreadId,
            projectId,
            projectTitle:
              projectId === null ? null : (input.projectTitleById.get(projectId) ?? null),
          };
        })();

  // Only a started issue can have delegated anything, and a delegation that
  // stayed on this board is ordinary work rather than a link between two of
  // them — so the issue's own project is filtered out.
  const filed =
    issue.threadId === null
      ? NO_TARGETS
      : (input.targetsByOriginThread.get(issue.threadId) ?? NO_TARGETS);
  const targets = filed.filter((target) => target.projectId !== issue.projectId);

  return origin === null && targets.length === 0 ? NO_DELEGATION_LINKS : { origin, targets };
}

/** How many distinct boards the targets span, for a one-glance card label. */
export function countDelegationTargetProjects(
  targets: ReadonlyArray<IssueDelegationTarget>,
): number {
  return new Set(targets.map((target) => target.projectId)).size;
}

/**
 * The card label for outgoing links. One board is worth naming; several are
 * only worth counting, because the chip has a line to say it in.
 */
export function describeDelegationTargets(targets: ReadonlyArray<IssueDelegationTarget>): string {
  const projectCount = countDelegationTargetProjects(targets);
  if (projectCount > 1) {
    return `To ${projectCount} projects`;
  }
  const [first] = targets;
  const title = first?.projectTitle ?? null;
  if (title === null) {
    return targets.length === 1 ? "To another project" : `To another project (${targets.length})`;
  }
  return targets.length === 1 ? `To ${title}` : `To ${title} (${targets.length})`;
}

/**
 * The boards the targets sit on, named once each, for the chip's tooltip.
 * Grouped by project rather than by title, so two boards that happen to share
 * a name still count as two and the tooltip agrees with the chip's own count.
 */
export function describeDelegationTargetProjects(
  targets: ReadonlyArray<IssueDelegationTarget>,
): string {
  const titleByProjectId = new Map<ProjectId, string>();
  for (const target of targets) {
    if (titleByProjectId.has(target.projectId)) continue;
    titleByProjectId.set(target.projectId, target.projectTitle ?? "another project");
  }
  return [...titleByProjectId.values()].join(", ");
}
