import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import {
  TextGeneration,
  type ReviewComplexityClassificationInput,
} from "../../textGeneration/TextGeneration.ts";
import { ReviewComplexityClassifier } from "../Services/ReviewComplexityClassifier.ts";
import { ReviewComplexityClassifierLive } from "./ReviewComplexityClassifier.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const claudeProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "2.1.219",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isCustom: false },
  ],
  slashCommands: [],
  skills: [],
};

const INPUT = {
  issueTitle: "Fix typo in the settings copy",
  issueDescription: "One string changes.",
  worktreePath: "/tmp/acme-worktrees/issue-a",
  baseBranch: "main",
};

interface HarnessOptions {
  readonly providers?: ReadonlyArray<unknown>;
  readonly diffFails?: boolean;
  readonly classify?: (
    input: ReviewComplexityClassificationInput,
  ) => Effect.Effect<{ tier: "trivial" | "standard" | "complex" }, TextGenerationError>;
}

function makeHarness(options: HarnessOptions = {}) {
  const classifications: ReviewComplexityClassificationInput[] = [];

  const gitLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    readRangeContext: (input: { readonly cwd: string; readonly baseRef: string }) =>
      options.diffFails
        ? Effect.die(`no repository at ${input.cwd}`)
        : Effect.succeed({
            commitSummary: "abc123 fix typo",
            diffSummary: " settings.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
            diffPatch: "",
          }),
  } as never);

  const textGenerationLayer = Layer.mock(TextGeneration)({
    classifyReviewComplexity: (input: ReviewComplexityClassificationInput) => {
      classifications.push(input);
      return options.classify?.(input) ?? Effect.succeed({ tier: "trivial" as const });
    },
  });

  const layer = ReviewComplexityClassifierLive.pipe(
    Layer.provide(makeProviderRegistryLayer((options.providers ?? [claudeProvider]) as never)),
    Layer.provide(gitLayer),
    Layer.provide(textGenerationLayer),
  );

  return { layer, classifications };
}

describe("ReviewComplexityClassifier", () => {
  it.effect("classifies on the cheapest model with the issue text and diff shape", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const classifier = yield* ReviewComplexityClassifier;
      const tier = yield* classifier.classify(INPUT);
      expect(tier).toBe("trivial");
      expect(harness.classifications).toHaveLength(1);
      expect(harness.classifications[0]?.modelSelection.model).toBe("claude-haiku-4-5");
      expect(harness.classifications[0]?.cwd).toBe(INPUT.worktreePath);
      expect(harness.classifications[0]?.diffSummary).toContain("1 file changed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("defaults to complex when the classifier call fails", () => {
    const harness = makeHarness({
      classify: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "classifyReviewComplexity",
            detail: "Claude returned invalid structured output.",
          }),
        ),
    });
    return Effect.gen(function* () {
      const classifier = yield* ReviewComplexityClassifier;
      expect(yield* classifier.classify(INPUT)).toBe("complex");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("defaults to complex without calling a model when no cheap model exists", () => {
    const harness = makeHarness({
      providers: [{ ...claudeProvider, models: [claudeProvider.models[0]] }],
    });
    return Effect.gen(function* () {
      const classifier = yield* ReviewComplexityClassifier;
      expect(yield* classifier.classify(INPUT)).toBe("complex");
      expect(harness.classifications).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  // The merge queue is serial, so a classifier that never answers would hold
  // every waiting review behind it; the timeout is what stops that.
  it.effect("defaults to complex when the classifier never answers", () => {
    const harness = makeHarness({ classify: () => Effect.never });
    return Effect.gen(function* () {
      const classifier = yield* ReviewComplexityClassifier;
      const running = yield* Effect.forkChild(classifier.classify(INPUT));
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(running)).toBe("complex");
    }).pipe(Effect.scoped, Effect.provide(harness.layer), Effect.provide(TestClock.layer()));
  });

  it.effect("still classifies from the issue text when the diff cannot be read", () => {
    const harness = makeHarness({ diffFails: true });
    return Effect.gen(function* () {
      const classifier = yield* ReviewComplexityClassifier;
      expect(yield* classifier.classify(INPUT)).toBe("trivial");
      expect(harness.classifications[0]?.diffSummary).toBe("");
    }).pipe(Effect.provide(harness.layer));
  });
});
