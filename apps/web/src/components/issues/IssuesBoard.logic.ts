import {
  findIssueDependencyCycle,
  isIssueDependencySatisfied,
  isIssueOpenToRevision,
  issueNeedsAttention,
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
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly priority: IssuePriority | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
  readonly createdAt: string;
  /**
   * Optional so the dependency-picker views, which carry no attention state,
   * still satisfy this shape. Absent simply reads as "not flagged".
   */
  readonly needsAttentionAt?: string | null | undefined;
}

/**
 * What a column's colour is saying. Named for the state rather than the hue so
 * the palette stays a rendering decision: `waiting` work is parked, `active`
 * work has an agent on it, `review` is being checked by the reviewer agent, and
 * `finished` is history.
 *
 * Deliberately not a per-status colour. Six distinct hues across the board
 * would compete with the one signal that actually wants the user's eye — the
 * needs-attention flag, which is orthogonal to status and can land in any
 * column.
 */
export type IssueColumnAccent = "waiting" | "active" | "review" | "finished";

const ISSUE_STATUS_ACCENT: Readonly<Record<IssueStatus, IssueColumnAccent>> = {
  backlog: "waiting",
  in_progress: "active",
  in_review: "review",
  done: "finished",
  canceled: "finished",
  archived: "finished",
};

export interface IssueBoardColumn<TIssue extends BoardIssue> {
  readonly status: IssueStatus;
  readonly label: string;
  readonly accent: IssueColumnAccent;
  /**
   * Issues in this column flagged for a human. Surfaced per column so the
   * board can say where the work needing a person is without the user opening
   * every card.
   */
  readonly attentionCount: number;
  /** Finished work reads as history: rendered muted and collapsed by default. */
  readonly muted: boolean;
  readonly issues: ReadonlyArray<TIssue>;
}

interface IssueStatusColumnDefinition {
  readonly status: IssueStatus;
  readonly label: string;
  readonly muted: boolean;
}

/**
 * Left-to-right column order. Fixed: the board is a pipeline, not a filter.
 * Archived sits at the far right, past the other two finished columns, because
 * it is where work goes to stop being looked at — the server files a `done`
 * issue there after a day of quiet, and reaching it is the last thing that
 * happens to an issue.
 */
export const ISSUE_STATUS_COLUMNS: ReadonlyArray<IssueStatusColumnDefinition> = [
  { status: "backlog", label: "Backlog", muted: false },
  { status: "in_progress", label: "In Progress", muted: false },
  { status: "in_review", label: "In Review", muted: false },
  { status: "done", label: "Done", muted: true },
  { status: "canceled", label: "Canceled", muted: true },
  { status: "archived", label: "Archived", muted: true },
];

export const ISSUE_STATUS_LABEL: Readonly<Record<IssueStatus, string>> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  archived: "Archived",
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
  return ISSUE_STATUS_COLUMNS.map((column) => {
    const columnIssues = issues
      .filter((issue) => issue.status === column.status)
      .toSorted(
        (left, right) =>
          issuePriorityRank(left.priority) - issuePriorityRank(right.priority) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    return {
      status: column.status,
      label: column.label,
      muted: column.muted,
      accent: ISSUE_STATUS_ACCENT[column.status],
      attentionCount: columnIssues.filter((issue) => issueNeedsAttention(issue)).length,
      issues: columnIssues,
    };
  });
}

export function indexIssuesById<TIssue extends BoardIssue>(
  issues: ReadonlyArray<TIssue>,
): ReadonlyMap<IssueId, TIssue> {
  return new Map(issues.map((issue) => [issue.id, issue] as const));
}

/**
 * The dependencies still standing between an issue and its start. A dependency
 * whose issue was deleted no longer blocks — the server agrees — and only
 * finished work satisfies one (`done`, or the `archived` it becomes after a
 * day), so a canceled dependency still gates the work.
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

/**
 * The blockers as a phrase. A blocker tracked on another board is named with
 * that board — "Expose session endpoints (Acme API)" — because "blocked by
 * Expose session endpoints" is a confusing thing to read on a board that has
 * no such issue on it.
 */
export function describeIssueBlockers(
  blockers: ReadonlyArray<BoardIssue>,
  options?: {
    /** The board being looked at. Blockers from anywhere else get named. */
    readonly projectId?: ProjectId;
    readonly boardTitleById?: ReadonlyMap<ProjectId, string>;
  },
): string {
  if (blockers.length === 0) {
    return "";
  }
  const titles = blockers.map((blocker) => {
    if (options?.projectId === undefined || blocker.projectId === options.projectId) {
      return blocker.title;
    }
    const board = options.boardTitleById?.get(blocker.projectId);
    return board === undefined ? blocker.title : `${blocker.title} (${board})`;
  });
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
 * The issues a dependency picker may still offer: everything in the pool except
 * the issue itself and anything that would close a cycle once added to the
 * current selection.
 *
 * `graph` is what the cycle check reads, and defaults to the pool. They differ
 * once dependencies may cross boards: the pool is what this project is allowed
 * to point at (its own board and the linked ones), while a cycle can run
 * through an issue on a board the picker never offers, and missing that would
 * offer a choice the server then rejects.
 */
export function filterIssueDependencyCandidates<TIssue extends BoardIssue>(input: {
  readonly issues: ReadonlyArray<TIssue>;
  readonly issueId: IssueId;
  readonly selected: ReadonlyArray<IssueId>;
  readonly graph?: ReadonlyArray<BoardIssue>;
}): ReadonlyArray<TIssue> {
  const selected = new Set(input.selected);
  const graph = input.graph ?? input.issues;
  return input.issues.filter((candidate) => {
    if (candidate.id === input.issueId) {
      return false;
    }
    if (selected.has(candidate.id)) {
      return true;
    }
    return (
      findIssueDependencyCycle(graph, {
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
 * A linked project the user has put in scope for this decomposition, as the
 * prompt needs to describe it: the workspace root is the handle the agent
 * copies into a story's `project`, and the description is what tells it which
 * stories belong there.
 */
export interface IssueDecompositionLinkedProject {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly description: string;
  /**
   * That board's stories, so a plan reaching into this repository revises what
   * is already tracked there instead of filing it a second time.
   */
  readonly boardIssues?: ReadonlyArray<IssueDecompositionBoardIssue>;
}

/**
 * One story already on a board, as the prompt needs to state it. `started` is
 * the read-only mark: work someone or something has picked up, which a plan
 * may depend on but must not rewrite (`isIssueOpenToRevision`).
 */
export interface IssueDecompositionBoardIssue {
  readonly id: IssueId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly priority: IssuePriority | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
  readonly started: boolean;
}

/**
 * How many stories one board contributes to the prompt before the rest are
 * summarised as a count. A long-lived board would otherwise spend the whole
 * turn's context describing itself.
 */
export const ISSUE_DECOMPOSITION_BOARD_CONTEXT_LIMIT = 60;

/** Everything the decomposition prompt is built from, minus the user's own text. */
export interface IssueDecompositionPromptContext {
  readonly projectTitle: string;
  readonly availableModels?: ReadonlyArray<{ readonly instanceId: string; readonly model: string }>;
  /**
   * Linked projects the stories may be routed to. Empty — the common case —
   * leaves the routing section out entirely, so a single-project plan never
   * reads instructions about repositories it cannot see.
   */
  readonly linkedProjects?: ReadonlyArray<IssueDecompositionLinkedProject>;
  /**
   * The target project's own board. Empty — a first decomposition — leaves the
   * board section out entirely, so the common case reads exactly as it did
   * before boards had anything on them.
   */
  readonly boardIssues?: ReadonlyArray<IssueDecompositionBoardIssue>;
}

/**
 * Turns a board's issues into the summary lines the agent plans against. Each
 * line leads with the id, because the id is what the agent has to copy into
 * `dependsOn`, `updates` or `supersedes`, and marks whether the story is still
 * open to revision or is settled context.
 */
function describeBoardIssues(issues: ReadonlyArray<IssueDecompositionBoardIssue>): string[] {
  const shown = issues.slice(0, ISSUE_DECOMPOSITION_BOARD_CONTEXT_LIMIT);
  const omitted = issues.length - shown.length;
  return [
    ...shown.map((issue) => {
      const marks = [
        ISSUE_STATUS_LABEL[issue.status].toLowerCase(),
        ...(issue.priority === null ? [] : [issue.priority]),
        issue.started ? "started, read-only" : "not started",
      ];
      const dependsOn =
        issue.dependsOn.length === 0 ? "" : ` — waits on ${issue.dependsOn.join(", ")}`;
      return `- ${issue.id} [${marks.join(", ")}] ${issue.title}${dependsOn}`;
    }),
    ...(omitted > 0 ? [`- …and ${omitted} more not listed here.`] : []),
  ];
}

/**
 * The board as the prompt should see it: the work that is still part of the
 * plan, with the stories a new plan may still rewrite first so a board too long
 * to list keeps the revisable half.
 *
 * Canceled and archived issues are left out. Both are settled — an abandoned
 * decision and finished work filed away — and listing them would spend the
 * turn's context arguing with history rather than describing the plan.
 */
export function toIssueDecompositionBoardIssues(
  issues: ReadonlyArray<BoardIssue & { readonly threadId?: string | null | undefined }>,
): ReadonlyArray<IssueDecompositionBoardIssue> {
  return issues
    .filter((issue) => issue.status !== "canceled" && issue.status !== "archived")
    .map((issue, index) => ({
      index,
      issue: {
        id: issue.id,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        dependsOn: issue.dependsOn,
        started: !isIssueOpenToRevision(issue),
      } satisfies IssueDecompositionBoardIssue,
    }))
    .toSorted(
      (left, right) =>
        Number(left.issue.started) - Number(right.issue.started) ||
        issuePriorityRank(left.issue.priority) - issuePriorityRank(right.issue.priority) ||
        left.index - right.index,
    )
    .map((entry) => entry.issue);
}

/**
 * The board context one decomposition turn plans against: the target project's
 * stories and every linked project's, ready to spread into the prompt input.
 *
 * `issues` is every issue in the environment, because a plan that reaches into
 * a linked repository needs that board too and they arrive together.
 */
export function buildIssueDecompositionBoardContext<
  TProject extends IssueDecompositionLinkedProject & { readonly id: ProjectId },
>(input: {
  readonly issues: ReadonlyArray<BoardIssue & { readonly threadId?: string | null | undefined }>;
  readonly projectId: ProjectId;
  readonly linkedProjects: ReadonlyArray<TProject>;
}): Required<Pick<IssueDecompositionPromptContext, "boardIssues" | "linkedProjects">> {
  const forProject = (projectId: ProjectId) =>
    toIssueDecompositionBoardIssues(input.issues.filter((issue) => issue.projectId === projectId));
  return {
    boardIssues: forProject(input.projectId),
    linkedProjects: input.linkedProjects.map((project) => ({
      ...project,
      boardIssues: forProject(project.id),
    })),
  };
}

/**
 * The framing and rules for a story-decomposition turn: which project the
 * work belongs to, which worker models the agent may assign, which other
 * repositories the plan may reach into, and the canonical block-format
 * instructions from contracts. Shared by the board's prefill (which precedes
 * this with a placeholder line for the user to replace) and the composer's
 * "Generate stories" toggle (which appends it straight after the user's own
 * message, so there is no line to replace).
 */
export function buildIssueDecompositionInstructions(
  input: IssueDecompositionPromptContext,
): string {
  const availableModels = input.availableModels ?? [];
  const linkedProjects = input.linkedProjects ?? [];
  const boardIssues = input.boardIssues ?? [];
  const linkedBoards = linkedProjects.flatMap((project) =>
    (project.boardIssues ?? []).length === 0
      ? []
      : [{ project, issues: project.boardIssues ?? [] }],
  );
  const hasBoardContext = boardIssues.length > 0 || linkedBoards.length > 0;
  return [
    `Break this work for ${input.projectTitle} into stories. Ask me every clarifying question you have before emitting the block — once the stories exist they are worked without my input.`,
    "",
    ...(availableModels.length > 0
      ? [
          "Configured worker models (choose only from this list when setting modelSelection):",
          ...availableModels.map((selection) => `- ${selection.instanceId}: ${selection.model}`),
          "Assign one of these modelSelection values to every story based on the work it requires.",
          "",
        ]
      : []),
    ...(linkedProjects.length > 0
      ? [
          `This work may also touch these linked projects. Each has its own board, and a story is created on the board of the project whose code it changes — so give a story a \`project\` when its work lands there, copying the path exactly as written here. Anything belonging to ${input.projectTitle} takes no \`project\` at all.`,
          ...linkedProjects.map(
            (project) => `- ${project.workspaceRoot} — ${project.title}: ${project.description}`,
          ),
          "Read the relevant code in these repositories before deciding what each story needs; do not assume their shape.",
          "",
        ]
      : []),
    ...(hasBoardContext
      ? [
          "Read what is already planned before you plan anything. Do not file work that is already tracked; when new work genuinely waits on one of these stories, name its id in `dependsOn`; and when this plan changes something already decided, rewrite that story with `updates` or replace it with `supersedes` instead of leaving two versions of it on the board. Only a story marked `not started` may be updated or superseded — the rest are context you may depend on and nothing more.",
          ...(boardIssues.length > 0
            ? [
                "",
                `Stories already on ${input.projectTitle}'s board:`,
                ...describeBoardIssues(boardIssues),
              ]
            : []),
          ...linkedBoards.flatMap((board) => [
            "",
            `Stories already on ${board.project.title}'s board (${board.project.workspaceRoot}):`,
            ...describeBoardIssues(board.issues),
          ]),
          "",
        ]
      : []),
    ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS.trim(),
  ].join("\n");
}

/**
 * The seed prompt for the story-decomposition thread: a place for the user's
 * feature description, then the canonical instructions.
 */
export function buildIssueDecompositionPrompt(input: IssueDecompositionPromptContext): string {
  return [
    ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER,
    "",
    buildIssueDecompositionInstructions(input),
    "",
  ].join("\n");
}

/**
 * What the composer's "Generate stories" toggle appends after the user's own
 * message on send: the same canonical instructions the board prefills, minus
 * the placeholder — the user's text already says what they want broken down.
 */
export function appendIssueDecompositionInstructions(
  input: IssueDecompositionPromptContext & { readonly promptText: string },
): string {
  const instructions = buildIssueDecompositionInstructions(input);
  const text = input.promptText.trim();
  return text.length > 0 ? `${text}\n\n${instructions}` : instructions;
}

/**
 * Makes story generation visible and editable before send. An empty composer
 * gets the same placeholder template as the issues board; existing text is
 * treated as the feature description and kept above the instructions.
 */
export function prepareIssueDecompositionPrompt(
  input: IssueDecompositionPromptContext & { readonly promptText: string },
): string {
  const instructions = buildIssueDecompositionInstructions(input);
  const text = input.promptText.trim();
  if (text.length === 0) {
    return buildIssueDecompositionPrompt(input);
  }
  if (text.includes(instructions)) {
    return input.promptText;
  }
  return appendIssueDecompositionInstructions({ ...input, promptText: text });
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
