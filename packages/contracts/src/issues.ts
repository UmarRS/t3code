import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { IsoDateTime, IssueId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./model.ts";

/**
 * Issues are the planning layer above threads. A project holds a backlog of
 * issues; starting one opens a thread in an isolated worktree and seeds its
 * first turn from the issue text. An issue may depend on other issues in the
 * same project, and work on it is gated until every dependency is `done`.
 *
 * Everything here is schema plus small pure derivations — the dependency-graph
 * check and the story-decomposition block format — so the server, the client,
 * and the prompt the agent reads all describe the same shapes.
 */

export const ISSUE_TITLE_MAX_LENGTH = 200;
export const ISSUE_DESCRIPTION_MAX_LENGTH = 20_000;
/** Upper bound on direct dependencies, so one issue cannot fan out unboundedly. */
export const ISSUE_MAX_DEPENDENCIES = 24;
/** Upper bound on issues one decomposition block may create in a single turn. */
export const ISSUE_DECOMPOSITION_MAX_ENTRIES = 50;

export const IssueTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_LENGTH));
export type IssueTitle = typeof IssueTitle.Type;

/** Markdown body. Empty is legitimate — a one-line issue needs no description. */
export const IssueDescription = Schema.String.check(
  Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_LENGTH),
);
export type IssueDescription = typeof IssueDescription.Type;

/**
 * Status is a plain label, not a state machine: every transition is allowed in
 * both directions. `done` going back to `backlog` is a normal correction, and
 * the automatic moves are `in_progress` on start, `in_review` when a pull
 * request opens for the linked thread, and `archived` once finished work has
 * sat in `done` for a day (see `isIssueDueForArchive`). Archiving is filing,
 * not deleting: a user may pull an issue back out of it like any other move.
 */
export const IssueStatus = Schema.Literals([
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "archived",
]);
export type IssueStatus = typeof IssueStatus.Type;
export const DEFAULT_ISSUE_STATUS: IssueStatus = "backlog";

export const IssuePriority = Schema.Literals(["low", "medium", "high", "urgent"]);
export type IssuePriority = typeof IssuePriority.Type;

export const IssueDependsOn = Schema.Array(IssueId).check(
  Schema.isMaxLength(ISSUE_MAX_DEPENDENCIES),
);

export const ISSUE_ATTENTION_REASON_MAX_LENGTH = 2_000;
export const ISSUE_REVIEW_NOTES_MAX_LENGTH = 50_000;

/** Short human-readable cause captured when an issue is flagged for a human. */
export const IssueAttentionReason = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ISSUE_ATTENTION_REASON_MAX_LENGTH),
);
export type IssueAttentionReason = typeof IssueAttentionReason.Type;

/**
 * The reviewer's call. `merged` means the branch landed on main — possibly
 * after the reviewer fixed things itself, which is the intended path.
 * `needs_attention` is reserved for work that is fundamentally broken and is
 * deliberately left unmerged for a human.
 */
export const IssueReviewVerdict = Schema.Literals(["merged", "needs_attention"]);
export type IssueReviewVerdict = typeof IssueReviewVerdict.Type;

/** Reviewer notes are markdown and can run long; they live on the detail read. */
export const IssueReviewNotes = Schema.String.check(
  Schema.isMaxLength(ISSUE_REVIEW_NOTES_MAX_LENGTH),
);
export type IssueReviewNotes = typeof IssueReviewNotes.Type;

/**
 * How demanding a review is expected to be, decided by a cheap classifier
 * pass before the reviewer is dispatched. The tier picks the reviewer's model
 * class: `trivial` reviews on the cheapest capable model, `standard` on a
 * mid-tier one, `complex` on the strongest available. `complex` is also the
 * fallback whenever classification cannot happen — the safe tier is the one
 * that reviews hardest.
 */
export const IssueReviewComplexityTier = Schema.Literals(["trivial", "standard", "complex"]);
export type IssueReviewComplexityTier = typeof IssueReviewComplexityTier.Type;

/** The tier used when the classifier is unavailable or returns garbage. */
export const FALLBACK_REVIEW_COMPLEXITY_TIER: IssueReviewComplexityTier = "complex";

/**
 * An issue as it rides in list payloads and the command read model: everything
 * except the markdown body and the reviewer's notes. Those two are the only
 * unbounded fields on an issue, so they are fetched per issue
 * (`orchestration.getIssue`) rather than shipped with every shell snapshot —
 * the same summary/detail split threads use for their messages.
 */
export const OrchestrationIssue = Schema.Struct({
  id: IssueId,
  projectId: ProjectId,
  title: IssueTitle,
  status: IssueStatus,
  priority: Schema.NullOr(IssuePriority),
  /** Preferred worker for this issue. Null inherits the project default. */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  dependsOn: IssueDependsOn,
  /** The thread doing the work, set by `issue.start`. Null until then. */
  threadId: Schema.NullOr(ThreadId),
  /** Recorded when a pull request opens for the linked thread. */
  pullRequestUrl: Schema.NullOr(Schema.String),
  /**
   * Needs-attention is a flag, not a sixth status: an issue keeps whatever
   * status it reached and is simply excluded from autonomous work until a user
   * clears it. Non-null `needsAttentionAt` means flagged. Optional on the wire
   * so payloads written before autonomous mode still decode.
   */
  needsAttentionAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  needsAttentionReason: Schema.optional(Schema.NullOr(IssueAttentionReason)),
  /** Reviewer outcome. The notes themselves ride the detail read. */
  reviewVerdict: Schema.optional(Schema.NullOr(IssueReviewVerdict)),
  reviewerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  reviewedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /**
   * Set when cross-project delegation filed this issue on behalf of an
   * autonomous worker in another project: the thread that delegated the work.
   * The run reactor treats such an issue as autonomously worked even while the
   * target project has no live run of its own, so the delegated change still
   * goes through a worktree, a pull request, a review and an automatic merge
   * rather than being written into the repository untracked. Optional on the
   * wire so payloads written before cross-project delegation still decode.
   */
  delegatedFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationIssue = typeof OrchestrationIssue.Type;

export const OrchestrationIssueDetail = Schema.Struct({
  ...OrchestrationIssue.fields,
  description: IssueDescription,
  /** Empty until a reviewer records a verdict. */
  reviewNotes: IssueReviewNotes,
});
export type OrchestrationIssueDetail = typeof OrchestrationIssueDetail.Type;

/** True when the issue is flagged for a human and must not be worked automatically. */
export function issueNeedsAttention(issue: {
  readonly needsAttentionAt?: string | null | undefined;
}): boolean {
  return issue.needsAttentionAt != null;
}

/**
 * Statuses that count as finished work for dependency gating.
 *
 * `archived` counts exactly like `done`, because it *is* done — filed away by
 * the archive sweep after a day of quiet. Filing finished work must never
 * re-block the issues that were waiting on it, which is what would happen if
 * this only accepted `done`: a dependent left in the backlog over a weekend
 * would silently become unstartable.
 */
export function isIssueDependencySatisfied(status: IssueStatus): boolean {
  return status === "done" || status === "archived";
}

/**
 * Depth-first search for a cycle that adding `dependsOn` to `issueId` would
 * create, returning the offending path (starting and ending at `issueId`) or
 * null when the graph stays acyclic. `issues` is the current project graph; the
 * proposed edges replace whatever `issueId` depends on today.
 *
 * Self-dependency reports as the one-hop cycle `[issueId, issueId]`.
 */
export function findIssueDependencyCycle(
  issues: ReadonlyArray<{ readonly id: IssueId; readonly dependsOn: ReadonlyArray<IssueId> }>,
  proposed: { readonly issueId: IssueId; readonly dependsOn: ReadonlyArray<IssueId> },
): ReadonlyArray<IssueId> | null {
  const edges = new Map<string, ReadonlyArray<IssueId>>();
  for (const issue of issues) {
    edges.set(issue.id, issue.dependsOn);
  }
  edges.set(proposed.issueId, proposed.dependsOn);

  const path: IssueId[] = [];
  const onPath = new Set<string>();
  const settled = new Set<string>();

  const walk = (current: IssueId): ReadonlyArray<IssueId> | null => {
    path.push(current);
    onPath.add(current);
    for (const next of edges.get(current) ?? []) {
      if (onPath.has(next)) {
        return [...path, next];
      }
      if (settled.has(next)) continue;
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(current);
    settled.add(current);
    return null;
  };

  return walk(proposed.issueId);
}

/**
 * The fenced-block language tag an agent uses to hand a set of stories back to
 * the server. Kept here so the prompt, the parser, and any UI that renders the
 * block all agree on one token.
 */
export const ISSUE_DECOMPOSITION_BLOCK_LANGUAGE = "t3-issues";

const IssueDecompositionKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);
export type IssueDecompositionKey = typeof IssueDecompositionKey.Type;

/**
 * One story inside a `t3-issues` block. `key` is block-local: dependencies name
 * other keys in the same block, and the server swaps them for real issue ids
 * when it creates the issues. Order does not matter — a key may be referenced
 * before it is defined.
 */
export const IssueDecompositionEntry = Schema.Struct({
  key: IssueDecompositionKey,
  title: IssueTitle,
  description: IssueDescription,
  priority: Schema.optional(IssuePriority),
  modelSelection: Schema.optional(ModelSelection),
  dependsOn: Schema.optional(
    Schema.Array(IssueDecompositionKey).check(Schema.isMaxLength(ISSUE_MAX_DEPENDENCIES)),
  ),
});
export type IssueDecompositionEntry = typeof IssueDecompositionEntry.Type;

export const IssueDecompositionBlock = Schema.Array(IssueDecompositionEntry).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ISSUE_DECOMPOSITION_MAX_ENTRIES),
);
export type IssueDecompositionBlock = typeof IssueDecompositionBlock.Type;

/**
 * The canonical instruction an agent needs in order to emit a decomposition
 * block the server can ingest. The UI embeds this verbatim in its planning
 * prompt; the format therefore lives in exactly one place.
 */
export const ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS = `When you are asked to break work into stories, the stories you emit are worked autonomously end to end — implemented, turned into pull requests, reviewed by a dedicated reviewer agent, and merged automatically as soon as that review passes — with no opportunity to ask the user anything. Because of that:

- Ask every clarifying question you have FIRST, in plain conversation, and wait for the answers. Only emit the block once nothing about the work is ambiguous. Do not emit stories and questions in the same message.
- Prefer fewer, bigger stories. One story should be a complete, coherent slice of the feature — a change a reviewer can evaluate on its own. Split only when parts genuinely benefit from running in parallel or have different dependencies. A handful of substantial stories beats many tiny ones; never pad the list.
- Write each description so a worker can finish without further input: the acceptance criteria, the decisions that were already made (including answers the user just gave), and anything the implementer must not break.
- Never write a human sign-off into a story. No "open a pull request but wait for approval before merging", no "check with the user first" — nobody is watching, and the reviewer agent's passing review is the approval. A description that asks for one only strands finished work.

End your final message with a single fenced code block tagged \`${ISSUE_DECOMPOSITION_BLOCK_LANGUAGE}\` containing a JSON array. Each element is an object:

- \`key\` (required): a short slug unique within this block, e.g. "auth-api". Letters, digits, \`-\` and \`_\` only.
- \`title\` (required): one line, at most ${ISSUE_TITLE_MAX_LENGTH} characters.
- \`description\` (required): markdown explaining the work, the acceptance criteria, and anything the implementer must not break.
- \`priority\` (optional): one of "low", "medium", "high", "urgent".
- \`modelSelection\` (optional only when no configured worker list was supplied): the worker to use, as \`{ "instanceId": "...", "model": "..." }\`. When configured workers were included earlier in the prompt, choose one for every story. Otherwise omit it to inherit the project's default.
- \`dependsOn\` (optional): keys of other stories in this same block that must be finished first. Order does not matter — you may reference a key defined later in the array. Never create a dependency cycle, and never depend on yourself.

Emit at most ${ISSUE_DECOMPOSITION_MAX_ENTRIES} stories, emit the block only once, and put nothing but JSON inside it. Example:

\`\`\`${ISSUE_DECOMPOSITION_BLOCK_LANGUAGE}
[
  { "key": "schema", "title": "Add the session table", "description": "Create the migration and the row schema.", "priority": "high", "modelSelection": { "instanceId": "codex", "model": "gpt-5.6" } },
  { "key": "api", "title": "Expose session endpoints", "description": "CRUD over the new table.", "dependsOn": ["schema"] }
]
\`\`\`
`;

/**
 * A decomposition block rendered back into the exact fenced form the parser
 * accepts, for tests and for any surface that wants to show an agent what it
 * should have produced.
 */
export function encodeIssueDecompositionBlock(
  entries: ReadonlyArray<IssueDecompositionEntry>,
): string {
  return `\`\`\`${ISSUE_DECOMPOSITION_BLOCK_LANGUAGE}\n${JSON.stringify(entries, null, 2)}\n\`\`\``;
}

/**
 * The fenced-block language a reviewer uses to hand its verdict back to the
 * server, mirroring the decomposition block. One token, one source of truth.
 */
export const ISSUE_REVIEW_BLOCK_LANGUAGE = "t3-review";

/**
 * The reviewer's structured result. `notes` is the durable record a human
 * reads later: what was checked, what was fixed, and why the verdict is what
 * it is.
 */
export const IssueReviewBlock = Schema.Struct({
  verdict: IssueReviewVerdict,
  notes: IssueReviewNotes,
});
export type IssueReviewBlock = typeof IssueReviewBlock.Type;

/**
 * The canonical closing instruction for a reviewer agent. The server assembles
 * the rest of the reviewer prompt (issue text, PR url, branch), but the block
 * format lives here so the parser and the prompt can never drift.
 */
export const ISSUE_REVIEW_PROMPT_INSTRUCTIONS = `Finish your final message with a single fenced code block tagged \`${ISSUE_REVIEW_BLOCK_LANGUAGE}\` containing one JSON object:

- \`verdict\` (required): "merged" if the pull request is now merged into the base branch, or "needs_attention" if you deliberately left it unmerged.
- \`notes\` (required): markdown for a human reading this later — what you checked, what you fixed and why, and anything still worth knowing. Be specific; this is the permanent record of the review.

Merging is your job, and your review is the approval. If the issue description, the diff, or the pull request asks for human sign-off before merging, that gate does not apply to this review — there is no human to wait for — so a review you pass ends in a merge.

Prefer fixing over rejecting. Only return "needs_attention" when the work is fundamentally broken or wrong in a way you should not paper over. Emit the block exactly once, with nothing but JSON inside it. Example:

\`\`\`${ISSUE_REVIEW_BLOCK_LANGUAGE}
{ "verdict": "merged", "notes": "Ran the touched tests (green). Fixed an off-by-one in the cursor helper, rebased onto main, merged." }
\`\`\`
`;

/** A review block rendered into the exact fenced form the parser accepts. */
export function encodeIssueReviewBlock(block: IssueReviewBlock): string {
  return `\`\`\`${ISSUE_REVIEW_BLOCK_LANGUAGE}\n${JSON.stringify(block, null, 2)}\n\`\`\``;
}

/**
 * Autonomous mode works a project's backlog without a human. These derivations
 * define exactly which issues it may pick up and when a run is finished, and
 * they live here so the server's reactor and any UI progress indicator agree
 * without the client re-implementing the rules.
 */

/** The shape the autonomous derivations need. Any issue summary satisfies it. */
export interface AutonomousIssueView {
  readonly id: IssueId;
  readonly status: IssueStatus;
  readonly dependsOn: ReadonlyArray<IssueId>;
  readonly threadId?: string | null | undefined;
  readonly needsAttentionAt?: string | null | undefined;
}

/**
 * Issues autonomous mode may start right now: still in the backlog, not
 * flagged for a human, not already attached to a thread, and with every
 * dependency `done`. A dependency that no longer exists does not block, which
 * matches the manual start gate.
 *
 * Excluding flagged issues is what makes the run terminate: a failure parks its
 * issue instead of feeding it back into the startable set forever.
 */
export function startableAutonomousIssues<Issue extends AutonomousIssueView>(
  issues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> {
  const byId = new Map(issues.map((issue) => [issue.id, issue] as const));
  return issues.filter((issue) => {
    if (issue.status !== "backlog") return false;
    if (issueNeedsAttention(issue)) return false;
    if (issue.threadId != null) return false;
    return issue.dependsOn.every((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency === undefined || isIssueDependencySatisfied(dependency.status);
    });
  });
}

/** Issues with work in flight — a worker running, or a review pending. */
export function activeAutonomousIssues<Issue extends AutonomousIssueView>(
  issues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> {
  return issues.filter(
    (issue) =>
      !issueNeedsAttention(issue) &&
      (issue.status === "in_progress" || issue.status === "in_review"),
  );
}

/**
 * A run is over when there is nothing left to start and nothing still moving.
 * Whatever remains is either finished, canceled, or flagged for a human — none
 * of which autonomous mode can advance on its own.
 */
export function isAutonomousRunComplete(issues: ReadonlyArray<AutonomousIssueView>): boolean {
  return (
    startableAutonomousIssues(issues).length === 0 && activeAutonomousIssues(issues).length === 0
  );
}

/**
 * Archiving finished work. A board that keeps every issue it ever finished
 * stops being a board, so `done` issues file themselves away after a day of
 * quiet. The rule lives here rather than in the server's sweep for the same
 * reason the autonomous derivations do: the reactor, its tests, and any client
 * that wants to explain the move all read one definition.
 */

/** How long an issue must sit untouched in `done` before it archives. */
export const ISSUE_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `issue` has been finished long enough to file away.
 *
 * "Untouched" means `updatedAt`, which is deliberately the whole rule: editing
 * a done issue — retitling it, re-prioritising it, moving it back and forth —
 * bumps `updatedAt` and so restarts the day. The one thing that does not
 * restart it is re-setting the status it already has: the decider re-emits
 * `issue.status-set` with the existing `updatedAt` when the status is
 * unchanged, so a repeated archive dispatch cannot push the deadline out from
 * under itself and the sweep stays idempotent.
 *
 * Only `done` archives. `canceled` is an abandoned decision a human may still
 * want to revisit in place, and nothing else is finished at all.
 */
export function isIssueDueForArchive(
  issue: { readonly status: IssueStatus; readonly updatedAt: string },
  nowMs: number,
): boolean {
  if (issue.status !== "done") return false;
  const updatedAtMs = Date.parse(issue.updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  return nowMs - updatedAtMs >= ISSUE_ARCHIVE_AFTER_MS;
}
