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
  it.effect("keeps a dependency that names an issue already on a board", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "ui", "title": "Build the login screen", "description": "Form.", "dependsOn": ["5f3a1c22-1111-4a11-8a11-111111111111"] }
]`),
      );
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.entries[0]?.dependsOnKeys).toEqual([]);
      expect(result.entries[0]?.dependsOnIssueIds).toEqual([
        IssueId.make("5f3a1c22-1111-4a11-8a11-111111111111"),
      ]);
    }),
  );

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

const OPEN = IssueId.make("5f3a1c22-1111-4a11-8a11-111111111111");
const STARTED = IssueId.make("5f3a1c22-2222-4a11-8a11-222222222222");
const board = [
  { id: OPEN, status: "backlog" as const, threadId: null, needsAttentionAt: null },
  { id: STARTED, status: "in_progress" as const, threadId: "thread-1", needsAttentionAt: null },
];

describe("parseIssueDecomposition revisions", () => {
  it.effect("carries what a story rewrites and replaces", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "auth", "title": "Rework the session flow", "description": "One story.", "updates": "${OPEN}" }
]`),
        { existingIssues: board },
      );
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.entries[0]?.updates).toBe(OPEN);
      expect(result.entries[0]?.supersedes).toEqual([]);
    }),
  );

  it.effect("rejects a story rewriting work that has started", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "auth", "title": "Rework it", "description": "No.", "updates": "${STARTED}" }
]`),
        { existingIssues: board },
      );
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") return;
      expect(result.detail).toContain("already started");
    }),
  );

  it.effect("rejects a story naming an issue that is not on the board", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "auth", "title": "Rework it", "description": "No.", "supersedes": ["5f3a1c22-9999-4a11-8a11-999999999999"] }
]`),
        { existingIssues: board },
      );
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") return;
      expect(result.detail).toContain("not on the board");
    }),
  );

  it.effect("rejects two stories claiming the same issue", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "one", "title": "One", "description": "A.", "updates": "${OPEN}" },
  { "key": "two", "title": "Two", "description": "B.", "supersedes": ["${OPEN}"] }
]`),
        { existingIssues: board },
      );
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") return;
      expect(result.detail).toContain("claimed by more than one story");
    }),
  );

  it.effect("rejects a plan that waits on a story it cancels", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "one", "title": "One", "description": "A.", "supersedes": ["${OPEN}"] },
  { "key": "two", "title": "Two", "description": "B.", "dependsOn": ["${OPEN}"] }
]`),
        { existingIssues: board },
      );
      expect(result.kind).toBe("invalid");
      if (result.kind !== "invalid") return;
      expect(result.detail).toContain("which this plan cancels");
    }),
  );

  // Applying the same block twice must leave the board where it is, so a story
  // this plan already canceled is not a story it may no longer touch.
  it.effect("accepts a block whose cancellations already landed", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "one", "title": "One", "description": "A.", "supersedes": ["${OPEN}"] }
]`),
        {
          existingIssues: [
            { id: OPEN, status: "canceled" as const, threadId: null, needsAttentionAt: null },
          ],
        },
      );
      expect(result.kind).toBe("parsed");
    }),
  );

  it.effect("rewrites the named issue rather than the id the caller minted", () =>
    Effect.gen(function* () {
      const parsed = yield* parseIssueDecomposition(
        fence(`[
  { "key": "auth", "title": "Rework the session flow", "description": "One story.", "updates": "${OPEN}" },
  { "key": "ui", "title": "Screen", "description": "Form.", "dependsOn": ["auth"] }
]`),
        { existingIssues: board },
      );
      if (parsed.kind !== "parsed") throw new Error("expected a parsed block");
      const resolved = resolveIssueDecomposition(parsed.entries, [
        IssueId.make("id-auth"),
        IssueId.make("id-ui"),
      ]);
      expect(resolved[0]?.issueId).toBe(OPEN);
      expect(resolved[0]?.updatesExisting).toBe(true);
      expect(resolved[1]?.dependsOn).toEqual([OPEN]);
    }),
  );
});

describe("parseIssueDecomposition routing", () => {
  it.effect("carries the project a story names", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "api", "title": "Expose session endpoints", "description": "CRUD." },
  { "key": "ui", "title": "Build the login screen", "description": "Calls the endpoints.", "project": "/repos/smartcanvass-fe" }
]`),
      );
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.entries.map((entry) => entry.project)).toEqual([
        null,
        "/repos/smartcanvass-fe",
      ]);
    }),
  );

  // A plan that spans repositories orders itself across them: the frontend
  // story waits on the backend story, and the two live on different boards.
  it.effect("keeps a dependency that crosses projects, in dependency order", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "ui", "title": "Build the login screen", "description": "Calls the endpoints.", "project": "/repos/smartcanvass-fe", "dependsOn": ["api"] },
  { "key": "api", "title": "Expose session endpoints", "description": "CRUD." }
]`),
      );
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.entries.map((entry) => entry.key)).toEqual(["api", "ui"]);
      expect(result.entries[1]?.dependsOnKeys).toEqual(["api"]);
    }),
  );

  it.effect("allows a dependency between two stories on the same linked project", () =>
    Effect.gen(function* () {
      const result = yield* parseIssueDecomposition(
        fence(`[
  { "key": "ui", "title": "Build the login screen", "description": "Form.", "project": "/repos/smartcanvass-fe" },
  { "key": "ui-tests", "title": "Cover the login screen", "description": "Specs.", "project": "/repos/smartcanvass-fe", "dependsOn": ["ui"] }
]`),
      );
      expect(result.kind).toBe("parsed");
    }),
  );
});
