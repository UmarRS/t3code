import { describe, expect, it } from "vite-plus/test";

import { IssueId, ProjectId } from "./baseSchemas.ts";
import {
  activeAutonomousIssues,
  evaluateAutonomousRun,
  startableAutonomousIssues,
  type AutonomousIssueView,
  type IssueStatus,
} from "./issues.ts";

const id = (value: string) => IssueId.make(value);

/** The board under evaluation, and the linked board a plan may reach into. */
const BOARD = ProjectId.make("board");
const OTHER_BOARD = ProjectId.make("other-board");

const issue = (
  value: string,
  overrides: Partial<AutonomousIssueView> = {},
): AutonomousIssueView => ({
  id: id(value),
  projectId: BOARD,
  status: "backlog",
  dependsOn: [],
  threadId: null,
  needsAttentionAt: null,
  ...overrides,
});

const ids = (issues: ReadonlyArray<AutonomousIssueView>) => issues.map((entry) => entry.id);

/** Evaluate `BOARD`, with every board named running unless `advancing` says otherwise. */
const evaluate = (
  issues: ReadonlyArray<AutonomousIssueView>,
  advancing: ReadonlyArray<ProjectId> = [BOARD, OTHER_BOARD],
) =>
  evaluateAutonomousRun({
    projectId: BOARD,
    issues,
    isProjectAdvancing: (projectId) => advancing.includes(projectId),
  });

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

describe("evaluateAutonomousRun", () => {
  it("is complete when the backlog is empty", () => {
    expect(evaluate([]).complete).toBe(true);
  });

  it("is complete when everything left is done or canceled", () => {
    expect(
      evaluate([issue("a", { status: "done" }), issue("b", { status: "canceled" })]).complete,
    ).toBe(true);
  });

  // The termination guarantee: a backlog of nothing but parked issues has no
  // moves left, so the run finishes instead of spinning.
  it("is complete when everything left is flagged", () => {
    expect(
      evaluate([
        issue("a", { needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
        issue("b", { status: "in_progress", needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
      ]).complete,
    ).toBe(true);
  });

  it("is not complete while work is startable", () => {
    expect(evaluate([issue("a")]).complete).toBe(false);
  });

  it("is not complete while a review is pending", () => {
    expect(evaluate([issue("a", { status: "in_review" })]).complete).toBe(false);
  });

  // A blocked issue whose blocker is flagged is not startable and not active,
  // so the run ends rather than waiting on something that will never move —
  // and says so, by handing the blocked issue back as stalled.
  it("is complete when the only remaining work is blocked by a parked issue", () => {
    const evaluation = evaluate([
      issue("a", { needsAttentionAt: "2026-01-01T00:00:00.000Z" }),
      issue("b", { dependsOn: [id("a")] }),
    ]);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.stalled.map((entry) => entry.issue.id)).toEqual([id("b")]);
  });

  it("only ever starts issues on the board being evaluated", () => {
    const evaluation = evaluate([issue("a"), issue("b", { projectId: OTHER_BOARD })]);
    expect(ids(evaluation.startable)).toEqual([id("a")]);
  });

  // The cross-board wait. This board has nothing of its own left to do, but
  // turning the run off would strand the story the moment its blocker landed.
  it("waits rather than completing while another board works the blocker", () => {
    const evaluation = evaluate([
      issue("api", { projectId: OTHER_BOARD, status: "in_progress" }),
      issue("ui", { dependsOn: [id("api")] }),
    ]);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.startable).toEqual([]);
    expect(evaluation.waiting.map((entry) => entry.issue.id)).toEqual([id("ui")]);
    expect(evaluation.stalled).toEqual([]);
  });

  it("waits on a blocker still queued on a board that is running", () => {
    const evaluation = evaluate([
      issue("api", { projectId: OTHER_BOARD }),
      issue("ui", { dependsOn: [id("api")] }),
    ]);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.waiting.map((entry) => entry.issue.id)).toEqual([id("ui")]);
  });

  // Nobody is running the other board, so no amount of waiting releases this.
  it("stalls when the blocking board is not being worked at all", () => {
    const evaluation = evaluate(
      [issue("api", { projectId: OTHER_BOARD }), issue("ui", { dependsOn: [id("api")] })],
      [BOARD],
    );
    expect(evaluation.complete).toBe(true);
    expect(evaluation.waiting).toEqual([]);
    expect(evaluation.stalled.map((entry) => entry.blocker.id)).toEqual([id("api")]);
  });

  // The blocker's own blocker is what is really stuck, and a chain of waiting
  // that ends in a parked issue is stalled all the way down.
  it("stalls through a chain whose far end cannot move", () => {
    const evaluation = evaluate([
      issue("schema", {
        projectId: OTHER_BOARD,
        needsAttentionAt: "2026-01-01T00:00:00.000Z",
      }),
      issue("api", { projectId: OTHER_BOARD, dependsOn: [id("schema")] }),
      issue("ui", { dependsOn: [id("api")] }),
    ]);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.stalled.map((entry) => entry.issue.id)).toEqual([id("ui")]);
  });

  // Delegated work is carried by the run loop wherever it landed, so a story
  // waiting on it is waiting, not stuck, even with that board's switch off.
  it("waits on a delegated blocker on a board with no run of its own", () => {
    const evaluation = evaluate(
      [
        issue("api", {
          projectId: OTHER_BOARD,
          delegatedFromThreadId: "thread-delegating-parent",
        }),
        issue("ui", { dependsOn: [id("api")] }),
      ],
      [BOARD],
    );
    expect(evaluation.complete).toBe(false);
    expect(evaluation.waiting.map((entry) => entry.issue.id)).toEqual([id("ui")]);
  });

  it("starts work whose cross-board blocker has finished", () => {
    const evaluation = evaluate([
      issue("api", { projectId: OTHER_BOARD, status: "done" }),
      issue("ui", { dependsOn: [id("api")] }),
    ]);
    expect(ids(evaluation.startable)).toEqual([id("ui")]);
    expect(evaluation.complete).toBe(false);
  });
});
