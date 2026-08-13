import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseIssueReview } from "./issueReview.ts";

const fence = (body: string) => ["```t3-review", body, "```"].join("\n");

describe("parseIssueReview", () => {
  it.effect("parses a merged verdict with its notes", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(
        `All good.\n\n${fence('{ "verdict": "merged", "notes": "Ran the touched tests. Fixed a typo." }')}`,
      );
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.verdict).toBe("merged");
      expect(result.notes).toContain("Ran the touched tests");
    }),
  );

  it.effect("parses a needs_attention verdict", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(
        fence('{ "verdict": "needs_attention", "notes": "The migration drops a column." }'),
      );
      if (result.kind !== "parsed") throw new Error("expected a parsed block");
      expect(result.verdict).toBe("needs_attention");
    }),
  );

  // Silence is not consent: a reviewer that never said it merged has not
  // established that the work is safe, so the caller treats this as a park.
  it.effect("reports a missing block as invalid", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview("Looks fine to me!");
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("without a t3-review block");
      }
    }),
  );

  it.effect("reports malformed JSON as invalid", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(fence("{ verdict: merged }"));
      expect(result.kind).toBe("invalid");
    }),
  );

  it.effect("rejects a verdict outside the allowed set", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(
        fence('{ "verdict": "looks-good", "notes": "shipped" }'),
      );
      expect(result.kind).toBe("invalid");
    }),
  );

  it.effect("rejects a block missing its notes", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(fence('{ "verdict": "merged" }'));
      expect(result.kind).toBe("invalid");
    }),
  );

  it.effect("rejects more than one block", () =>
    Effect.gen(function* () {
      const block = fence('{ "verdict": "merged", "notes": "ok" }');
      const result = yield* parseIssueReview(`${block}\n\n${block}`);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("expected exactly one");
      }
    }),
  );

  it.effect("tolerates fields it does not know about", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(
        fence('{ "verdict": "merged", "notes": "ok", "confidence": 0.9 }'),
      );
      expect(result.kind).toBe("parsed");
    }),
  );

  // Reviewer notes routinely contain fenced code; the scanner must not stop at
  // the first ``` it sees inside the JSON string.
  it.effect("keeps notes that contain their own code fences", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueReview(
        fence('{ "verdict": "merged", "notes": "Replaced the loop:\\n\\n    for (;;) {}\\n" }'),
      );
      if (result.kind !== "parsed") throw new Error("expected a parsed block");
      expect(result.notes).toContain("for (;;)");
    }),
  );
});
