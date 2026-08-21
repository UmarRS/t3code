import { describe, expect, it } from "vite-plus/test";

import { IssueId, ProjectId } from "./baseSchemas.ts";
import {
  activeAutonomousIssues,
  encodeIssueDecompositionBlock,
  evaluateAutonomousRun,
  findIssueDependencyCycle,
  isIssueDependencySatisfied,
  isIssueDueForArchive,
  ISSUE_ARCHIVE_AFTER_MS,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  ISSUE_DECOMPOSITION_PROMPT_INSTRUCTIONS,
  ISSUE_REVIEW_PROMPT_INSTRUCTIONS,
  startableAutonomousIssues,
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
  it("treats finished work as satisfied", () => {
    expect(isIssueDependencySatisfied("done")).toBe(true);
    // Filing finished work away must never re-block what was waiting on it.
    expect(isIssueDependencySatisfied("archived")).toBe(true);
    for (const status of ["backlog", "in_progress", "in_review", "canceled"] as const) {
      expect(isIssueDependencySatisfied(status)).toBe(false);
    }
  });
});

describe("autonomous derivations exclude archived issues", () => {
  const view = (
    key: string,
    overrides: {
      status?: "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "archived";
      dependsOn?: ReadonlyArray<string>;
      threadId?: string | null;
      needsAttentionAt?: string | null;
    } = {},
  ) => ({
    id: id(key),
    projectId: ProjectId.make("project"),
    status: overrides.status ?? "backlog",
    dependsOn: (overrides.dependsOn ?? []).map(id),
    threadId: overrides.threadId ?? null,
    needsAttentionAt: overrides.needsAttentionAt ?? null,
  });

  it("never lists an archived issue as startable, even though its shape fits", () => {
    const startable = startableAutonomousIssues([view("filed", { status: "archived" })]);
    expect(startable).toEqual([]);
  });

  it("never lists an archived issue as active", () => {
    const active = activeAutonomousIssues([view("filed", { status: "archived" })]);
    expect(active).toEqual([]);
  });

  it("still unblocks a dependent whose dependency has archived", () => {
    const startable = startableAutonomousIssues([
      view("filed", { status: "archived" }),
      view("next", { dependsOn: ["filed"] }),
    ]);
    expect(startable.map((issue) => issue.id)).toEqual([id("next")]);
  });

  // A backlog holding nothing but filed-away history has nothing left to start
  // and nothing still moving, so it reads exactly like an empty one: complete.
  it("reads a backlog of only-archived issues as a complete run", () => {
    expect(
      evaluateAutonomousRun({
        projectId: ProjectId.make("project"),
        issues: [view("first", { status: "archived" }), view("second", { status: "archived" })],
        isProjectAdvancing: () => true,
      }).complete,
    ).toBe(true);
  });
});

describe("isIssueDueForArchive", () => {
  const finishedAt = "2026-01-01T00:00:00.000Z";
  const finishedAtMs = Date.parse(finishedAt);

  it("archives a done issue once the threshold has fully elapsed", () => {
    expect(isIssueDueForArchive({ status: "done", updatedAt: finishedAt }, finishedAtMs + 1)).toBe(
      false,
    );
    expect(
      isIssueDueForArchive(
        { status: "done", updatedAt: finishedAt },
        finishedAtMs + ISSUE_ARCHIVE_AFTER_MS - 1,
      ),
    ).toBe(false);
    expect(
      isIssueDueForArchive(
        { status: "done", updatedAt: finishedAt },
        finishedAtMs + ISSUE_ARCHIVE_AFTER_MS,
      ),
    ).toBe(true);
  });

  it("still archives work the server slept through", () => {
    expect(
      isIssueDueForArchive(
        { status: "done", updatedAt: finishedAt },
        finishedAtMs + ISSUE_ARCHIVE_AFTER_MS * 30,
      ),
    ).toBe(true);
  });

  it("leaves every other status alone, however old", () => {
    const longAfter = finishedAtMs + ISSUE_ARCHIVE_AFTER_MS * 10;
    for (const status of ["backlog", "in_progress", "in_review", "canceled", "archived"] as const) {
      expect(isIssueDueForArchive({ status, updatedAt: finishedAt }, longAfter)).toBe(false);
    }
  });

  // Editing a done issue bumps updatedAt, and the day starts over from there.
  it("restarts the clock when a done issue is touched", () => {
    const twoDaysOn = finishedAtMs + ISSUE_ARCHIVE_AFTER_MS * 2;
    const editedAt = "2026-01-02T23:00:00.000Z";
    expect(isIssueDueForArchive({ status: "done", updatedAt: editedAt }, twoDaysOn)).toBe(false);
  });

  it("never archives on an unparseable timestamp", () => {
    expect(
      isIssueDueForArchive(
        { status: "done", updatedAt: "not a date" },
        finishedAtMs + ISSUE_ARCHIVE_AFTER_MS * 10,
      ),
    ).toBe(false);
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
