import { FALLBACK_REVIEW_COMPLEXITY_TIER } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { resolveReviewClassifierModelSelection } from "../reviewerModelSelection.ts";
import {
  ReviewComplexityClassifier,
  type ReviewComplexityClassifierShape,
} from "../Services/ReviewComplexityClassifier.ts";

/**
 * A hard cap on triage. The merge queue is serial, so a classifier that hangs
 * would hold every waiting review; past this point the review proceeds on the
 * safe tier instead.
 */
const CLASSIFICATION_TIMEOUT_MS = 60_000;

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const textGeneration = yield* TextGeneration;

  const classify: ReviewComplexityClassifierShape["classify"] = Effect.fn(
    "classifyReviewComplexity",
  )(function* (input) {
    const providers = yield* providerRegistry.getProviders;
    const modelSelection = resolveReviewClassifierModelSelection(providers);
    if (modelSelection === null) {
      // No cheap model anywhere: skip triage rather than burning a strong
      // model on it. The safe tier reviews hardest anyway.
      return FALLBACK_REVIEW_COMPLEXITY_TIER;
    }

    // The diff shape is context, not a requirement: an unreadable worktree
    // still classifies from the issue text alone.
    const diffSummary = yield* gitWorkflow
      .readRangeContext({ cwd: input.worktreePath, baseRef: input.baseBranch })
      .pipe(
        Effect.map((context) => context.diffSummary),
        Effect.catchCause(() => Effect.succeed("")),
      );

    const classified = yield* textGeneration
      .classifyReviewComplexity({
        cwd: input.worktreePath,
        issueTitle: input.issueTitle,
        issueDescription: input.issueDescription,
        diffSummary,
        modelSelection,
      })
      .pipe(
        Effect.timeoutOption(CLASSIFICATION_TIMEOUT_MS),
        Effect.map((option) => Option.map(option, (result) => result.tier)),
        // Malformed output, a dead CLI, a timeout — every failure is the same
        // answer. The structured-output decode inside the text generation
        // layer is the strict parse; anything it rejects lands here.
        Effect.catchCause((cause) =>
          Effect.logWarning("review complexity classification failed; using the safe tier", {
            model: modelSelection.model,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
      );

    return Option.getOrElse(classified, () => FALLBACK_REVIEW_COMPLEXITY_TIER);
  });

  return { classify } satisfies ReviewComplexityClassifierShape;
});

export const ReviewComplexityClassifierLive = Layer.effect(ReviewComplexityClassifier, make);
