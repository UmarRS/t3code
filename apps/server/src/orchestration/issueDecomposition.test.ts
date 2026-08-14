import { IssueId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { extractFencedBlocks } from "./fencedBlocks.ts";
import { parseIssueDecomposition, resolveIssueDecomposition } from "./issueDecomposition.ts";

const fence = (body: string) => ["```t3-issues", body, "```"].join("\n");

const VALID = fence(`[
  { "key": "api", "title": "Expose session endpoints", "description": "CRUD.", "dependsOn": ["schema"] },
  { "key": "schema", "title": "Add the session table", "description": "Migration.", "priority": "high", "modelSelection": { "instanceId": "codex", "model": "gpt-5.6" } }
]`);

describe("extractFencedBlocks", () => {
  it("finds a block surrounded by prose", () => {
    const blocks = extractFencedBlocks(`Here you go.\n\n${VALID}\n\nHope that helps.`, "t3-issues");
    expect(blocks).toHaveLength(1);
  });

  it("ignores fences tagged with another language", () => {
    expect(extractFencedBlocks("```json\n[]\n```", "t3-issues")).toEqual([]);
  });

  it("finds an indented block", () => {
    const blocks = extractFencedBlocks("- like so:\n  ```t3-issues\n  []\n  ```", "t3-issues");
    expect(blocks).toHaveLength(1);
  });
});

describe("parseIssueDecomposition", () => {
  it.effect("reports a message with no block as absent", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition("All done! No stories needed.");
      expect(result.kind).toBe("absent");
    }),
  );

  it.effect("parses a valid block and resolves forward references", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(VALID);
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      // Dependency order, not the agent's order: "schema" must exist before
      // "api" can be created with a dependency on it.
      expect(result.entries.map((entry) => entry.key)).toEqual(["schema", "api"]);
      expect(result.entries[0]?.priority).toBe("high");
      expect(result.entries[0]?.modelSelection).toEqual({
        instanceId: "codex",
        model: "gpt-5.6",
      });
      expect(result.entries[1]?.dependsOnKeys).toEqual(["schema"]);
    }),
  );

  it.effect("rejects a block that is not valid JSON", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(fence("[{ key: 'api' }"));
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("not a valid list of stories");
      }
    }),
  );

  it.effect("rejects an entry missing a required field", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[{ "key": "api", "title": "No description" }]`),
      );
      expect(result.kind).toBe("invalid");
    }),
  );

  it.effect("rejects a dependency on a key the block never defines", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[{ "key": "api", "title": "API", "description": "x", "dependsOn": ["nowhere"] }]`),
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("unknown key 'nowhere'");
      }
    }),
  );

  it.effect("rejects self-dependency", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[{ "key": "api", "title": "API", "description": "x", "dependsOn": ["api"] }]`),
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("depends on itself");
      }
    }),
  );

  it.effect("rejects duplicate keys", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
          { "key": "api", "title": "API", "description": "x" },
          { "key": "api", "title": "API again", "description": "y" }
        ]`),
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("Duplicate story key");
      }
    }),
  );

  it.effect("rejects a dependency cycle", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
          { "key": "a", "title": "A", "description": "x", "dependsOn": ["b"] },
          { "key": "b", "title": "B", "description": "y", "dependsOn": ["a"] }
        ]`),
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("cycle");
      }
    }),
  );

  it.effect("rejects an empty block rather than creating nothing silently", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(fence("[]"));
      expect(result.kind).toBe("invalid");
    }),
  );

  it.effect("rejects more than one block", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(`${VALID}\n\n${VALID}`);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.detail).toContain("expected exactly one");
      }
    }),
  );

  it.effect("tolerates fields it does not know about", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[{ "key": "api", "title": "API", "description": "x", "estimate": "3 days" }]`),
      );
      expect(result.kind).toBe("parsed");
    }),
  );
});

describe("resolveIssueDecomposition", () => {
  it.effect("swaps block keys for the ids the caller minted", () =>
    Effect.gen(function* () {
      const parsed = yield* parseIssueDecomposition(VALID);
      if (parsed.kind !== "parsed") throw new Error("expected a parsed block");
      const ids = [IssueId.make("id-schema"), IssueId.make("id-api")];
      const resolved = resolveIssueDecomposition(parsed.entries, ids);
      expect(resolved.map((entry) => entry.issueId)).toEqual(ids);
      expect(resolved[0]?.dependsOn).toEqual([]);
      expect(resolved[1]?.dependsOn).toEqual([IssueId.make("id-schema")]);
    }),
  );
});
