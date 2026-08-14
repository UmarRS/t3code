import { describe, expect, it } from "vite-plus/test";

import { IssueId } from "./baseSchemas.ts";
import {
  activeAutonomousIssues,
  isAutonomousRunComplete,
  startableAutonomousIssues,
  type AutonomousIssueView,
  type IssueStatus,
} from "./issues.ts";

const id = (value: string) => IssueId.make(value);

const issue = (
  value: string,
  overrides: Partial<AutonomousIssueView> = {},
): AutonomousIssueView => ({
  id: id(value),
  status: "backlog",
  dependsOn: [],
  threadId: null,
  needsAttentionAt: null,
  ...overrides,
});

const ids = (issues: ReadonlyArray<AutonomousIssueView>) => issues.map((entry) => entry.id);

describe("startableAutonomousIssues", () => {
  it("starts independent backlog issues", () => {
    const issues = [issue("a"), issue("b")];
    expect(ids(startableAutonomousIssues(issues))).toEqual([id("a"), id("b")]);
  });

  it("holds an issue until every dependency is done", () => {
    const issues = [
      issue("a", { status: "in_review" }),
      issue("b", { status: "done" }),
      issue("c", { dependsOn: [id("a"), id("b")] }),
    ];
    expect(ids(startableAutonomousIssues(issues))).toEqual([]);
  });

  it("releases an issue once its dependencies are done", () => {
    const issues = [issue("a", { status: "done" }), issue("b", { dependsOn: [id("a")] })];
    expect(ids(startableAutonomousIssues(issues))).toEqual([id("b")]);
  });

  // Excluding flagged issues is what makes the loop terminate: a failure parks
  // its issue instead of feeding it straight back into the startable set.
  it("never restarts a flagged issue", () => {
    const issues = [issue("a", { needsAttentionAt: "2026-01-01T00:00:00.000Z" })];
    expect(ids(startableAutonomousIssues(issues))).toEqual([]);
  });

  // Idempotence on replay: an issue that already has a thread was already
  // started, whatever a re-delivered event says.
  it("never restarts an issue that already has a thread", () => {
    const issues = [issue("a", { threadId: "thread-1" })];
    expect(ids(startableAutonomousIssues(issues))).toEqual([]);
  });

  it("ignores dependencies that no longer exist", () => {
    const issues = [issue("a", { dependsOn: [id("gone")] })];
    expect(ids(startableAutonomousIssues(issues))).toEqual([id("a")]);
  });

  it("treats a canceled dependency as unfinished", () => {
    const issues = [issue("a", { status: "canceled" }), issue("b", { dependsOn: [id("a")] })];
    expect(ids(startableAutonomousIssues(issues))).toEqual([]);
  });

  for (const status of ["in_progress", "in_review", "done", "canceled"] as const) {
    it(`does not start an issue already in ${status}`, () => {
      expect(
        ids(startableAutonomousIssues([issue("a", { status: status satisfies IssueStatus })])),
      ).toEqual([]);
    });
  }
});

describe("activeAutonomousIssues", () => {
  it("counts work in flight and pending reviews", () => {
    const issues = [
      issue("a", { status: "in_progress" }),
      issue("b", { status: "in_review" }),
      issue("c", { status: "done" }),
      issue("d"),
    ];
    expect(ids(activeAutonomousIssues(issues))).toEqual([id("a"), id("b")]);
  });

  it("does not count a flagged issue as moving", () => {
    const issues = [
      issue("a", { status: "in_progress", needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(ids(activeAutonomousIssues(issues))).toEqual([]);
  });
});

describe("isAutonomousRunComplete", () => {
  it("is complete when the backlog is empty", () => {
    expect(isAutonomousRunComplete([])).toBe(true);
  });

  it("is complete when everything left is done or canceled", () => {
    expect(
      isAutonomousRunComplete([issue("a", { status: "done" }), issue("b", { status: "canceled" })]),
    ).toBe(true);
  });

  // The termination guarantee: a backlog of nothing but parked issues has no
  // moves left, so the run finishes instead of spinning.
  it("is complete when everything left is flagged", () => {
    expect(
      isAutonomousRunComplete([
        issue("a", { needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
        issue("b", { status: "in_progress", needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ).toBe(true);
  });

  it("is not complete while work is startable", () => {
    expect(isAutonomousRunComplete([issue("a")])).toBe(false);
  });

  it("is not complete while a review is pending", () => {
    expect(isAutonomousRunComplete([issue("a", { status: "in_review" })])).toBe(false);
  });

  // A blocked issue whose blocker is flagged is not startable and not active,
  // so the run ends rather than waiting on something that will never move.
  it("is complete when the only remaining work is blocked by a parked issue", () => {
    expect(
      isAutonomousRunComplete([
        issue("a", { needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
        issue("b", { dependsOn: [id("a")] }),
      ]),
    ).toBe(true);
  });
});
