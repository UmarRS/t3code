/**
 * RuntimeReceiptBus - Internal checkpoint-reactor synchronization receipts.
 *
 * This service exists to expose short-lived orchestration milestones that are
 * useful in tests and harnesses but are not part of the production runtime
 * event model. `CheckpointReactor` publishes receipts such as baseline capture,
 * diff finalization, and turn-processing quiescence so integration tests can
 * wait for those exact points without inferring them indirectly from persisted
 * state.
 *
 * Production code should only call `publish`. Test code may subscribe via
 * `streamEventsForTest`, which is intentionally named to make the intended
 * usage explicit.
 *
 * @module RuntimeReceiptBus
 */
import {
  CheckpointRef,
  IsoDateTime,
  IssueId,
  IssueReviewComplexityTier,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});
export type CheckpointBaselineCapturedReceipt = typeof CheckpointBaselineCapturedReceipt.Type;

export const CheckpointDiffFinalizedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.diff.finalized"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error"]),
  createdAt: IsoDateTime,
});
export type CheckpointDiffFinalizedReceipt = typeof CheckpointDiffFinalizedReceipt.Type;

export const TurnProcessingQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("turn.processing.quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TurnProcessingQuiescedReceipt = typeof TurnProcessingQuiescedReceipt.Type;

/**
 * Autonomous-run milestones. A run's interesting moments are spread across two
 * queues and a provider turn, so a test that only drained would either race or
 * block; these name the exact points instead.
 */
export const AutonomousIssueStartedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.issue.started"),
  projectId: ProjectId,
  issueId: IssueId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
export type AutonomousIssueStartedReceipt = typeof AutonomousIssueStartedReceipt.Type;

export const AutonomousPullRequestOpenedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.pull-request.opened"),
  issueId: IssueId,
  threadId: ThreadId,
  pullRequestUrl: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type AutonomousPullRequestOpenedReceipt = typeof AutonomousPullRequestOpenedReceipt.Type;

export const AutonomousReviewStartedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.review.started"),
  issueId: IssueId,
  reviewerThreadId: ThreadId,
  /** The classified complexity of the work under review. */
  complexityTier: IssueReviewComplexityTier,
  /** The reviewer model the tier resolved to, after any upward fallback. */
  modelSelection: ModelSelection,
  createdAt: IsoDateTime,
});
export type AutonomousReviewStartedReceipt = typeof AutonomousReviewStartedReceipt.Type;

/**
 * A reviewer turn the provider killed, waiting out a backoff before it runs
 * again. Published before the wait starts, so a test names the moment instead
 * of racing it, and a run's history says the reviewer stumbled rather than
 * going quiet for four minutes.
 */
export const AutonomousReviewRetryScheduledReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.review.retry-scheduled"),
  issueId: IssueId,
  reviewerThreadId: ThreadId,
  /** The attempt this wait leads to. The first review is attempt 1. */
  attempt: NonNegativeInt,
  /** How long the wait is. */
  delayMs: NonNegativeInt,
  /** The provider error the previous attempt died on. */
  detail: Schema.String,
  createdAt: IsoDateTime,
});
export type AutonomousReviewRetryScheduledReceipt =
  typeof AutonomousReviewRetryScheduledReceipt.Type;

/** A reviewer thread asked to finish the review its provider interrupted. */
export const AutonomousReviewResumedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.review.resumed"),
  issueId: IssueId,
  reviewerThreadId: ThreadId,
  attempt: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type AutonomousReviewResumedReceipt = typeof AutonomousReviewResumedReceipt.Type;

export const AutonomousIssueFlaggedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.issue.flagged"),
  issueId: IssueId,
  reason: Schema.String,
  createdAt: IsoDateTime,
});
export type AutonomousIssueFlaggedReceipt = typeof AutonomousIssueFlaggedReceipt.Type;

/**
 * A worker that ended its turn with nothing to ship. Legitimate — it may have
 * routed the work to a linked project's board, or found the work already done —
 * so the issue finishes instead of being parked, and this is the run UI's
 * record of why no pull request exists.
 */
export const AutonomousIssueCompletedWithoutChangesReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.issue.completed-without-changes"),
  issueId: IssueId,
  threadId: ThreadId,
  reason: Schema.String,
  createdAt: IsoDateTime,
});
export type AutonomousIssueCompletedWithoutChangesReceipt =
  typeof AutonomousIssueCompletedWithoutChangesReceipt.Type;

export const AutonomousRunCompletedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.run.completed"),
  projectId: ProjectId,
  createdAt: IsoDateTime,
});
export type AutonomousRunCompletedReceipt = typeof AutonomousRunCompletedReceipt.Type;

/**
 * A scheduled slot that started a run. Published only when the enable actually
 * went out, so a test can name the moment without watching the clock.
 */
export const AutonomousScheduleFiredReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.schedule.fired"),
  projectId: ProjectId,
  entryId: Schema.String,
  createdAt: IsoDateTime,
});
export type AutonomousScheduleFiredReceipt = typeof AutonomousScheduleFiredReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  AutonomousIssueStartedReceipt,
  AutonomousPullRequestOpenedReceipt,
  AutonomousReviewStartedReceipt,
  AutonomousReviewRetryScheduledReceipt,
  AutonomousReviewResumedReceipt,
  AutonomousIssueFlaggedReceipt,
  AutonomousIssueCompletedWithoutChangesReceipt,
  AutonomousRunCompletedReceipt,
  AutonomousScheduleFiredReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "t3/orchestration/Services/RuntimeReceiptBus",
) {}
