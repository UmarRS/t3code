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

export const AutonomousIssueFlaggedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.issue.flagged"),
  issueId: IssueId,
  reason: Schema.String,
  createdAt: IsoDateTime,
});
export type AutonomousIssueFlaggedReceipt = typeof AutonomousIssueFlaggedReceipt.Type;

export const AutonomousRunCompletedReceipt = Schema.Struct({
  type: Schema.Literal("autonomous.run.completed"),
  projectId: ProjectId,
  createdAt: IsoDateTime,
});
export type AutonomousRunCompletedReceipt = typeof AutonomousRunCompletedReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  AutonomousIssueStartedReceipt,
  AutonomousPullRequestOpenedReceipt,
  AutonomousReviewStartedReceipt,
  AutonomousIssueFlaggedReceipt,
  AutonomousRunCompletedReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "t3/orchestration/Services/RuntimeReceiptBus",
) {}
