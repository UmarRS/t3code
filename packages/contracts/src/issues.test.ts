import { describe, expect, it } from "vite-plus/test";

import { IssueId } from "./baseSchemas.ts";
import {
  encodeIssueDecompositionBlock,
  findIssueDependencyCycle,
  isIssueDependencySatisfied,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS,
  ISSUE_REVIEW_PROMPT_INSTRUCTIONS,
} from "./issues.ts";

const id = (value: string) => IssueId.make(value);

const graph = (entries: Record<string, ReadonlyArray<string>>) =>
  Object.entries(entries).map(([key, dependsOn]) => ({
    id: id(key),
    dependsOn: dependsOn.map(id),
  }));

describe("findIssueDependencyCycle", () => {
  it("accepts a chain", () => {
    const cycle = findIssueDependencyCycle(graph({ a: [], b: ["a"] }), {
      issueId: id("c"),
      dependsOn: [id("b")],
    });
    expect(cycle).toBeNull();
  });

  it("accepts a diamond, visiting the shared node once", () => {
    const cycle = findIssueDependencyCycle(graph({ a: [], b: ["a"], c: ["a"] }), {
      issueId: id("d"),
      dependsOn: [id("b"), id("c")],
    });
    expect(cycle).toBeNull();
  });

  it("reports self-dependency as a one-hop cycle", () => {
    const cycle = findIssueDependencyCycle(graph({ a: [] }), {
      issueId: id("a"),
      dependsOn: [id("a")],
    });
    expect(cycle).toEqual([id("a"), id("a")]);
  });

  it("reports a two-node cycle", () => {
    const cycle = findIssueDependencyCycle(graph({ a: ["b"], b: [] }), {
      issueId: id("b"),
      dependsOn: [id("a")],
    });
    expect(cycle).toEqual([id("b"), id("a"), id("b")]);
  });

  it("reports a cycle closed several hops away", () => {
    const cycle = findIssueDependencyCycle(graph({ a: ["b"], b: ["c"], c: [] }), {
      issueId: id("c"),
      dependsOn: [id("a")],
    });
    expect(cycle).toEqual([id("c"), id("a"), id("b"), id("c")]);
  });

  // The proposed edges replace what the issue depends on today, so removing the
  // back edge in the same update must clear the cycle.
  it("uses the proposed edges rather than the stored ones", () => {
    const cycle = findIssueDependencyCycle(graph({ a: ["b"], b: ["a"] }), {
      issueId: id("b"),
      dependsOn: [],
    });
    expect(cycle).toBeNull();
  });

  it("ignores dangling references to issues outside the graph", () => {
    const cycle = findIssueDependencyCycle(graph({ a: [] }), {
      issueId: id("a"),
      dependsOn: [id("ghost")],
    });
    expect(cycle).toBeNull();
  });
});

describe("issue dependency gating", () => {
  it("treats only done as satisfied", () => {
    expect(isIssueDependencySatisfied("done")).toBe(true);
    for (const status of ["backlog", "in_progress", "in_review", "canceled"] as const) {
      expect(isIssueDependencySatisfied(status)).toBe(false);
    }
  });
});

describe("decomposition prompt", () => {
  it("names the block language the parser looks for", () => {
    expect(ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS).toContain(ISSUE_DECOMPOSITION_BLOCK_LANGUAGE);
  });

  it("encodes entries into a fence the prompt describes", () => {
    const encoded = encodeIssueDecompositionBlock([
      { key: "schema", title: "Add the table", description: "Migration." },
    ]);
    expect(encoded.startsWith("```t3-issues\n")).toBe(true);
    expect(encoded.endsWith("\n```")).toBe(true);
  });

  it("says stories are merged automatically, so none of them asks for sign-off", () => {
    expect(ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS).toContain("merged automatically");
    expect(ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS).toContain("Never write a human sign-off");
  });
});

describe("review prompt", () => {
  it("gives the reviewer the merge authority a story description cannot revoke", () => {
    expect(ISSUE_REVIEW_PROMPT_INSTRUCTIONS).toContain("your review is the approval");
    expect(ISSUE_REVIEW_PROMPT_INSTRUCTIONS).toContain("a review you pass ends in a merge");
  });
});
