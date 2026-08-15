/**
 * ReviewComplexityClassifier - Cheap-model triage for reviewer selection.
 *
 * Before a reviewer is dispatched, one call on the cheapest configured model
 * sizes the work into a complexity tier from the issue text and the diff
 * shape. The tier picks the reviewer's model class; the classification itself
 * must therefore cost almost nothing next to the review it sizes.
 *
 * Classification can never block or park a review: any failure — no cheap
 * model configured, an unreadable diff, a timeout, malformed output — resolves
 * to the `complex` tier, which reviews on the strongest model exactly as
 * before this classifier existed.
 *
 * @module ReviewComplexityClassifier
 */
import type { IssueReviewComplexityTier } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ReviewComplexityInput {
  readonly issueTitle: string;
  readonly issueDescription: string;
  /** The worker's worktree; the diff shape is read from here at review time. */
  readonly worktreePath: string;
  readonly baseBranch: string;
}

export interface ReviewComplexityClassifierShape {
  /** Classify the review. Never fails: every failure mode is the safe tier. */
  readonly classify: (input: ReviewComplexityInput) => Effect.Effect<IssueReviewComplexityTier>;
}

export class ReviewComplexityClassifier extends Context.Service<
  ReviewComplexityClassifier,
  ReviewComplexityClassifierShape
>()("t3/orchestration/Services/ReviewComplexityClassifier") {}
