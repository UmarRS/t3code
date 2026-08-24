import {
  EnvironmentId,
  IssueId,
  ProjectId,
  ThreadId,
  type IssueReviewVerdict,
  type IssueStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autonomousFinishedRunReviewKey,
  autonomousRunActionLabel,
  autonomousRunCompactActionLabel,
  buildReviewSections,
  describeAutonomousPlanBoards,
  describeAutonomousRunStatus,
  formatAutonomousProgressLabel,
  hasAutonomousReviewerProvider,
  issueRetryRestartsWork,
  planIssueAttentionClear,
  planIssueAttentionRetry,
  resolveAutonomousPlanBoards,
  resolveAutonomousRunState,
  resolveIssueAttentionPresentation,
  resolveStalledDependencyBoards,
  shouldShowFinishedRunReviewButton,
  summarizeAutonomousProgress,
  type ReviewIssueView,
} from "./autonomousRun.logic";

/** The board under test, and the linked board a plan may reach into. */
const BOARD = ProjectId.make("board");
const OTHER_BOARD = ProjectId.make("other-board");
/** A third board, reachable only through the second. */
const THIRD_BOARD = ProjectId.make("third-board");
const ENVIRONMENT = EnvironmentId.make("environment-1");

describe("autonomousRunActionLabel", () => {
  it("only calls a user-stopped run resumable", () => {
    expect(autonomousRunActionLabel({ kind: "finished", finishedAt: null })).toBe("Start");
    expect(autonomousRunActionLabel({ kind: "stopped", finishedAt: null })).toBe("Resume");
  });
});

describe("autonomousRunCompactActionLabel", () => {
  it("says what the press does, including for a run that never started", () => {
    expect(autonomousRunCompactActionLabel({ kind: "idle" })).toBe("Start");
    expect(autonomousRunCompactActionLabel({ kind: "finished", finishedAt: null })).toBe("Start");
    expect(autonomousRunCompactActionLabel({ kind: "stopped", finishedAt: null })).toBe("Resume");
    expect(autonomousRunCompactActionLabel({ kind: "running", startedAt: null })).toBe("Stop");
  });
});

describe("autonomousFinishedRunReviewKey", () => {
  it("combines the project and the run's finishedAt", () => {
    expect(
      autonomousFinishedRunReviewKey({
        environmentId: ENVIRONMENT,
        projectId: BOARD,
        finishedAt: "2026-08-24T00:00:00.000Z",
      }),
    ).toBe("environment-1:board:2026-08-24T00:00:00.000Z");
  });

  it("returns null without a finishedAt to key on", () => {
    expect(
      autonomousFinishedRunReviewKey({
        environmentId: ENVIRONMENT,
        projectId: BOARD,
        finishedAt: null,
      }),
    ).toBeNull();
  });

  it("gives two projects distinct keys for the same finish time", () => {
    const shared = "2026-08-24T00:00:00.000Z";
    expect(
      autonomousFinishedRunReviewKey({
        environmentId: ENVIRONMENT,
        projectId: BOARD,
        finishedAt: shared,
      }),
    ).not.toBe(
      autonomousFinishedRunReviewKey({
        environmentId: ENVIRONMENT,
        projectId: OTHER_BOARD,
        finishedAt: shared,
      }),
    );
  });
});

describe("shouldShowFinishedRunReviewButton", () => {
  const reviewKey = autonomousFinishedRunReviewKey({
    environmentId: ENVIRONMENT,
    projectId: BOARD,
    finishedAt: "2026-08-24T00:00:00.000Z",
  });

  it("hides the button for any state but a finished run", () => {
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "running", startedAt: null },
        reviewKey,
        dismissedKeys: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "idle" },
        reviewKey,
        dismissedKeys: new Set(),
      }),
    ).toBe(false);
  });

  it("shows a finished run's button until its key is dismissed", () => {
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "finished", finishedAt: "2026-08-24T00:00:00.000Z" },
        reviewKey,
        dismissedKeys: new Set(),
      }),
    ).toBe(true);
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "finished", finishedAt: "2026-08-24T00:00:00.000Z" },
        reviewKey,
        dismissedKeys: new Set(reviewKey === null ? [] : [reviewKey]),
      }),
    ).toBe(false);
  });

  it("keeps showing a finished run with no finishedAt to key on, dismissed or not", () => {
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "finished", finishedAt: null },
        reviewKey: null,
        dismissedKeys: new Set(["some-other-key"]),
      }),
    ).toBe(true);
  });

  it("brings the button back for a later run that finishes after a dismissal", () => {
    const firstKey = autonomousFinishedRunReviewKey({
      environmentId: ENVIRONMENT,
      projectId: BOARD,
      finishedAt: "2026-08-24T00:00:00.000Z",
    });
    const secondKey = autonomousFinishedRunReviewKey({
      environmentId: ENVIRONMENT,
      projectId: BOARD,
      finishedAt: "2026-08-25T00:00:00.000Z",
    });
    const dismissedKeys = new Set(firstKey === null ? [] : [firstKey]);
    expect(
      shouldShowFinishedRunReviewButton({
        runState: { kind: "finished", finishedAt: "2026-08-25T00:00:00.000Z" },
        reviewKey: secondKey,
        dismissedKeys,
      }),
    ).toBe(true);
  });
});

function issue(
  id: string,
  overrides: {
    status?: IssueStatus;
    projectId?: ProjectId;
    dependsOn?: ReadonlyArray<string>;
    threadId?: string | null;
    needsAttentionAt?: string | null;
    needsAttentionReason?: string | null;
    reviewVerdict?: IssueReviewVerdict | null;
    reviewedAt?: string | null;
    updatedAt?: string;
  } = {},
): ReviewIssueView & {
  readonly projectId: ProjectId;
  readonly dependsOn: ReadonlyArray<IssueId>;
} {
  return {
    id: IssueId.make(id),
    projectId: overrides.projectId ?? BOARD,
    title: id,
    status: overrides.status ?? "backlog",
    dependsOn: (overrides.dependsOn ?? []).map((value) => IssueId.make(value)),
    threadId: overrides.threadId === undefined ? null : ThreadId.make(overrides.threadId ?? ""),
    pullRequestUrl: null,
    needsAttentionAt: overrides.needsAttentionAt ?? null,
    needsAttentionReason: overrides.needsAttentionReason ?? null,
    reviewVerdict: overrides.reviewVerdict ?? null,
    reviewerThreadId: null,
    reviewedAt: overrides.reviewedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveAutonomousRunState", () => {
  it("reads a live run from the start time", () => {
    expect(
      resolveAutonomousRunState({
        autonomousStartedAt: "2026-08-01T10:00:00.000Z",
        autonomousFinishedAt: null,
        autonomousFinishedReason: null,
      }),
    ).toEqual({ kind: "running", startedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("prefers running over a stale finished reason", () => {
    expect(
      resolveAutonomousRunState({
        autonomousStartedAt: "2026-08-02T10:00:00.000Z",
        autonomousFinishedAt: "2026-08-01T10:00:00.000Z",
        autonomousFinishedReason: "completed",
      }).kind,
    ).toBe("running");
  });

  it("distinguishes a completed run from a stopped one", () => {
    expect(
      resolveAutonomousRunState({
        autonomousStartedAt: null,
        autonomousFinishedAt: "2026-08-01T12:00:00.000Z",
        autonomousFinishedReason: "completed",
      }),
    ).toEqual({ kind: "finished", finishedAt: "2026-08-01T12:00:00.000Z" });
    expect(
      resolveAutonomousRunState({
        autonomousStartedAt: null,
        autonomousFinishedAt: "2026-08-01T12:00:00.000Z",
        autonomousFinishedReason: "disabled",
      }).kind,
    ).toBe("stopped");
  });

  it("treats a project that never ran, and a missing project, as idle", () => {
    expect(resolveAutonomousRunState({}).kind).toBe("idle");
    expect(resolveAutonomousRunState(null).kind).toBe("idle");
  });
});

describe("summarizeAutonomousProgress", () => {
  const issues = [
    issue("queued"),
    issue("blocked", { dependsOn: ["queued"] }),
    issue("working", { status: "in_progress", threadId: "thread-1" }),
    issue("reviewing", { status: "in_review", threadId: "thread-2" }),
    issue("shipped", { status: "done" }),
    issue("parked", {
      status: "in_progress",
      threadId: "thread-3",
      needsAttentionAt: "2026-08-01T00:00:00.000Z",
    }),
    issue("dropped", { status: "canceled" }),
  ];

  it("counts each lane from the shared run rules", () => {
    expect(summarizeAutonomousProgress(issues)).toEqual({
      queued: 1,
      blocked: 1,
      inProgress: 1,
      inReview: 1,
      done: 1,
      needsAttention: 1,
      total: 6,
    });
  });

  // An issue the server filed away a day after finishing drops out of every
  // tally: it belongs to project history, not to this run's readout, and
  // counting it forever is what made a finished board read "finished" long
  // after the fact.
  it("excludes an archived issue from every tally", () => {
    const progress = summarizeAutonomousProgress([
      ...issues,
      issue("filed-away", { status: "archived" }),
    ]);
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(6);
  });

  it("reads a backlog of only-archived issues as no work at all", () => {
    const progress = summarizeAutonomousProgress([
      issue("filed-1", { status: "archived" }),
      issue("filed-2", { status: "archived" }),
    ]);
    expect(progress).toEqual({
      queued: 0,
      blocked: 0,
      inProgress: 0,
      inReview: 0,
      done: 0,
      needsAttention: 0,
      total: 0,
    });
  });

  // Flagged work must survive its siblings archiving out from under it, even
  // though in practice a flagged issue is rarely `done` enough to archive.
  it("still counts a flagged issue after everything else has archived", () => {
    const progress = summarizeAutonomousProgress([
      issue("filed-away", { status: "archived" }),
      issue("parked", {
        status: "in_progress",
        threadId: "thread-1",
        needsAttentionAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    expect(progress.needsAttention).toBe(1);
  });

  it("does not count a flagged issue as active or startable", () => {
    const progress = summarizeAutonomousProgress([
      issue("parked", { needsAttentionAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(progress.queued).toBe(0);
    expect(progress.inProgress).toBe(0);
    expect(progress.needsAttention).toBe(1);
  });

  // The board's own counts, with dependencies resolved across the environment:
  // a story waiting on another board's work is blocked, not queued, and the
  // other board's issues are not this board's totals.
  it("scopes counts to one board while reading dependencies from every board", () => {
    const progress = summarizeAutonomousProgress(
      [
        issue("api", { projectId: OTHER_BOARD, status: "in_progress", threadId: "thread-1" }),
        issue("ui", { dependsOn: ["api"] }),
      ],
      { projectId: BOARD },
    );
    expect(progress.queued).toBe(0);
    expect(progress.blocked).toBe(1);
    expect(progress.inProgress).toBe(0);
    expect(progress.total).toBe(1);
  });

  it("queues a story once its cross-board blocker is done", () => {
    const progress = summarizeAutonomousProgress(
      [
        issue("api", { projectId: OTHER_BOARD, status: "done" }),
        issue("ui", { dependsOn: ["api"] }),
      ],
      { projectId: BOARD },
    );
    expect(progress.queued).toBe(1);
    expect(progress.blocked).toBe(0);
  });

  it("formats a compact label and drops empty lanes", () => {
    expect(formatAutonomousProgressLabel(summarizeAutonomousProgress(issues))).toBe(
      "1 in progress · 1 in review · 1 queued · 1 blocked · 1 needs you · 1 done / 6",
    );
    expect(
      formatAutonomousProgressLabel(
        summarizeAutonomousProgress([issue("shipped", { status: "done" })]),
      ),
    ).toBe("1 done / 1");
  });
});

describe("describeAutonomousRunStatus", () => {
  const progress = summarizeAutonomousProgress([
    issue("working", { status: "in_progress", threadId: "thread-1" }),
    issue("shipped", { status: "done" }),
  ]);

  it("shows live progress while running", () => {
    const status = describeAutonomousRunStatus({
      state: { kind: "running", startedAt: "2026-08-01T00:00:00.000Z" },
      progress,
    });
    expect(status.tone).toBe("active");
    expect(status.detail).toBe("1 in progress · 1 done / 2");
  });

  it("points a finished run at the work that still needs a human", () => {
    const flagged = summarizeAutonomousProgress([
      issue("parked", { needsAttentionAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    const status = describeAutonomousRunStatus({
      state: { kind: "finished", finishedAt: null },
      progress: flagged,
    });
    expect(status.tone).toBe("complete");
    expect(status.detail).toBe("1 issue needs you");
  });

  // Once every issue the run touched has archived off the board, "Autonomous
  // finished · 0 done / 0" is not a status worth announcing forever — it
  // retires to plain idle instead.
  it("retires a finished run to idle once its work has all archived", () => {
    const emptied = summarizeAutonomousProgress([issue("filed-away", { status: "archived" })]);
    const status = describeAutonomousRunStatus({
      state: { kind: "finished", finishedAt: "2026-08-01T00:00:00.000Z" },
      progress: emptied,
    });
    expect(status).toEqual({ label: "Autonomous", detail: null, tone: "idle" });
  });

  // A never-run project reads the same way: nothing has ever been in scope.
  it("reads a finished state with nothing ever in scope as idle", () => {
    const status = describeAutonomousRunStatus({
      state: { kind: "finished", finishedAt: null },
      progress: summarizeAutonomousProgress([]),
    });
    expect(status.tone).toBe("idle");
  });

  // Flagged work is never hidden by archiving of its siblings: the badge
  // keeps pointing at it even though total reads 0.
  it("keeps the finished/needs-you presentation when total is 0 but something is flagged", () => {
    const flaggedOnly = summarizeAutonomousProgress([
      issue("filed-away", { status: "archived" }),
      issue("parked", {
        status: "in_progress",
        threadId: "thread-1",
        needsAttentionAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    expect(flaggedOnly.total).toBe(1);
    const status = describeAutonomousRunStatus({
      state: { kind: "finished", finishedAt: null },
      progress: flaggedOnly,
    });
    expect(status.tone).toBe("complete");
    expect(status.detail).toBe("1 issue needs you");
  });

  // The guard checks needsAttention independently of total, so even the
  // (practically unreachable, since flagged work is rarely `done` enough to
  // archive) case of total reading 0 alongside a nonzero needsAttention still
  // keeps the finished/needs-you presentation rather than falling to idle.
  it("never falls to idle on needsAttention alone, whatever total says", () => {
    const status = describeAutonomousRunStatus({
      state: { kind: "finished", finishedAt: null },
      progress: {
        queued: 0,
        blocked: 0,
        inProgress: 0,
        inReview: 0,
        done: 0,
        needsAttention: 1,
        total: 0,
      },
    });
    expect(status.tone).toBe("complete");
    expect(status.detail).toBe("1 issue needs you");
  });

  it("admits that stopping left threads running", () => {
    const status = describeAutonomousRunStatus({
      state: { kind: "stopped", finishedAt: null },
      progress,
    });
    expect(status.tone).toBe("stopped");
    expect(status.detail).toBe("1 still finishing");
  });
});

describe("buildReviewSections", () => {
  it("lists merged work newest first", () => {
    const sections = buildReviewSections([
      issue("older", {
        status: "done",
        reviewVerdict: "merged",
        reviewedAt: "2026-08-01T00:00:00.000Z",
      }),
      issue("newer", {
        status: "done",
        reviewVerdict: "merged",
        reviewedAt: "2026-08-03T00:00:00.000Z",
      }),
    ]);
    expect(sections.completed.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("lists flagged work newest flag first", () => {
    const sections = buildReviewSections([
      issue("old-flag", { needsAttentionAt: "2026-08-01T00:00:00.000Z" }),
      issue("new-flag", { needsAttentionAt: "2026-08-05T00:00:00.000Z" }),
    ]);
    expect(sections.needsAttention.map((entry) => entry.id)).toEqual(["new-flag", "old-flag"]);
  });

  it("never lists a flagged issue as completed", () => {
    const sections = buildReviewSections([
      issue("flagged-after-merge", {
        status: "done",
        reviewVerdict: "merged",
        reviewedAt: "2026-08-01T00:00:00.000Z",
        needsAttentionAt: "2026-08-02T00:00:00.000Z",
      }),
    ]);
    expect(sections.completed).toEqual([]);
    expect(sections.needsAttention).toHaveLength(1);
  });

  it("leaves unreviewed work out of both lists", () => {
    const sections = buildReviewSections([issue("manual", { status: "done" })]);
    expect(sections.completed).toEqual([]);
    expect(sections.needsAttention).toEqual([]);
  });
});

describe("resolveIssueAttentionPresentation", () => {
  it("returns null for an unflagged issue", () => {
    expect(resolveIssueAttentionPresentation(issue("fine"))).toBeNull();
  });

  it("uses the recorded reason and marks a review refusal", () => {
    expect(
      resolveIssueAttentionPresentation(
        issue("parked", {
          needsAttentionAt: "2026-08-01T00:00:00.000Z",
          needsAttentionReason: "The tests fail on main.",
          reviewVerdict: "needs_attention",
        }),
      ),
    ).toEqual({ reason: "The tests fail on main.", fromReview: true });
  });

  it("falls back to a generic reason when none was recorded", () => {
    const presentation = resolveIssueAttentionPresentation(
      issue("parked", { needsAttentionAt: "2026-08-01T00:00:00.000Z" }),
    );
    expect(presentation?.reason).toMatch(/could not finish/);
    expect(presentation?.fromReview).toBe(false);
  });
});

describe("planIssueAttentionRetry", () => {
  it("only clears the flag for a backlog issue", () => {
    const target = issue("parked", { needsAttentionAt: "2026-08-01T00:00:00.000Z" });
    expect(planIssueAttentionRetry(target)).toEqual([{ kind: "clear-attention" }]);
    expect(issueRetryRestartsWork(target)).toBe(false);
  });

  it("unlinks the thread and returns started work to the backlog", () => {
    const target = issue("parked", {
      status: "in_progress",
      threadId: "thread-1",
      needsAttentionAt: "2026-08-01T00:00:00.000Z",
    });
    expect(planIssueAttentionRetry(target)).toEqual([
      { kind: "clear-attention" },
      { kind: "unlink-thread" },
      { kind: "reset-to-backlog" },
    ]);
    expect(issueRetryRestartsWork(target)).toBe(true);
  });

  it("keeps completed worker work when retrying pull request creation", () => {
    const target = issue("parked", {
      status: "in_progress",
      threadId: "thread-1",
      needsAttentionAt: "2026-08-01T00:00:00.000Z",
      needsAttentionReason: "Could not open a pull request: GitHub CLI command failed.",
    });
    expect(planIssueAttentionRetry(target)).toEqual([{ kind: "clear-attention" }]);
    expect(issueRetryRestartsWork(target)).toBe(false);
  });

  it("clearing alone never touches the thread or the status", () => {
    expect(planIssueAttentionClear()).toEqual([{ kind: "clear-attention" }]);
  });
});

describe("hasAutonomousReviewerProvider", () => {
  const claude = {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-01T00:00:00.000Z",
    models: [{ slug: "claude-opus-5" }],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;

  it("accepts a ready Claude install with models", () => {
    expect(hasAutonomousReviewerProvider([claude])).toBe(true);
  });

  it("rejects a disabled, uninstalled, unavailable or model-less Claude", () => {
    expect(hasAutonomousReviewerProvider([{ ...claude, enabled: false }])).toBe(false);
    expect(hasAutonomousReviewerProvider([{ ...claude, installed: false }])).toBe(false);
    expect(
      hasAutonomousReviewerProvider([{ ...claude, availability: "unavailable" } as ServerProvider]),
    ).toBe(false);
    expect(hasAutonomousReviewerProvider([{ ...claude, models: [] }])).toBe(false);
  });

  it("rejects a codex-only environment", () => {
    expect(hasAutonomousReviewerProvider([{ ...claude, driver: "codex" } as ServerProvider])).toBe(
      false,
    );
  });
});

describe("resolveAutonomousPlanBoards", () => {
  const board = (id: ProjectId, title: string, startedAt: string | null = null) => ({
    id,
    title,
    autonomousStartedAt: startedAt,
  });
  const PROJECTS = [
    board(BOARD, "Acme"),
    board(OTHER_BOARD, "Acme API"),
    board(THIRD_BOARD, "Acme Infra"),
  ];

  // The dialog for an ordinary single-board plan must not change at all.
  it("names nothing when the plan does not leave this board", () => {
    const plan = resolveAutonomousPlanBoards({
      issues: [issue("a"), issue("b", { dependsOn: ["a"] })],
      projects: PROJECTS,
      projectId: BOARD,
      action: "enable",
    });
    expect(plan.boards).toEqual([]);
    expect(plan.additionalProjectIds).toEqual([]);
    expect(describeAutonomousPlanBoards(plan, "enable")).toBeNull();
  });

  it("names every board a start would switch on, transitively", () => {
    const plan = resolveAutonomousPlanBoards({
      issues: [
        issue("infra", { projectId: THIRD_BOARD }),
        issue("api", { projectId: OTHER_BOARD, dependsOn: ["infra"] }),
        issue("ui", { dependsOn: ["api"] }),
      ],
      projects: PROJECTS,
      projectId: BOARD,
      action: "enable",
    });
    expect(plan.boards.map((entry) => entry.title)).toEqual(["Acme API", "Acme Infra"]);
    expect(plan.additionalProjectIds.toSorted()).toEqual([OTHER_BOARD, THIRD_BOARD].toSorted());
    expect(describeAutonomousPlanBoards(plan, "enable")).toBe(
      "Also starts Acme API and Acme Infra, which this plan depends on.",
    );
  });

  it("leaves a board that is already running out of the start summary", () => {
    const plan = resolveAutonomousPlanBoards({
      issues: [issue("api", { projectId: OTHER_BOARD }), issue("ui", { dependsOn: ["api"] })],
      projects: [PROJECTS[0]!, board(OTHER_BOARD, "Acme API", "2026-01-01T00:00:00.000Z")],
      projectId: BOARD,
      action: "enable",
    });
    expect(plan.boards).toEqual([]);
    // Still sent: the server decides what a live board needs, and re-sending it
    // is a no-op there rather than a start time this client raced to read.
    expect(plan.additionalProjectIds).toEqual([OTHER_BOARD]);
  });

  it("offers back only the live boards this plan reaches when stopping", () => {
    const plan = resolveAutonomousPlanBoards({
      issues: [
        issue("infra", { projectId: THIRD_BOARD }),
        issue("api", { projectId: OTHER_BOARD }),
        issue("ui", { dependsOn: ["api", "infra"] }),
      ],
      projects: [
        PROJECTS[0]!,
        board(OTHER_BOARD, "Acme API", "2026-01-01T00:00:00.000Z"),
        board(THIRD_BOARD, "Acme Infra"),
      ],
      projectId: BOARD,
      action: "stop",
    });
    expect(plan.boards.map((entry) => entry.title)).toEqual(["Acme API"]);
    expect(describeAutonomousPlanBoards(plan, "stop")).toBe(
      "Also stops Acme API, started with this run.",
    );
  });

  // A board the user started on its own is not part of this plan, so stopping
  // this run must not reach it.
  it("never offers a live board this plan does not reach", () => {
    const plan = resolveAutonomousPlanBoards({
      issues: [issue("api", { projectId: OTHER_BOARD }), issue("ui")],
      projects: [PROJECTS[0]!, board(OTHER_BOARD, "Acme API", "2026-01-01T00:00:00.000Z")],
      projectId: BOARD,
      action: "stop",
    });
    expect(plan.boards).toEqual([]);
    expect(plan.additionalProjectIds).toEqual([]);
  });
});

describe("resolveStalledDependencyBoards", () => {
  const projects = (otherStartedAt: string | null) => [
    { id: BOARD, title: "Acme", autonomousStartedAt: null },
    { id: OTHER_BOARD, title: "Acme API", autonomousStartedAt: otherStartedAt },
    { id: THIRD_BOARD, title: "Acme Infra", autonomousStartedAt: null },
  ];

  it("offers the idle board holding the blocker, and its own plan with it", () => {
    const issues = [
      issue("infra", { projectId: THIRD_BOARD }),
      issue("api", { projectId: OTHER_BOARD, dependsOn: ["infra"] }),
      issue("ui", { dependsOn: ["api"], needsAttentionAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const plan = resolveStalledDependencyBoards({
      issue: issues[2]!,
      issues,
      projects: projects(null),
    });
    expect(plan?.boards.map((entry) => entry.title)).toEqual(["Acme API"]);
    expect(plan?.additionalProjectIds.toSorted()).toEqual([OTHER_BOARD, THIRD_BOARD].toSorted());
  });

  it("offers nothing when the blocker's board is already running", () => {
    const issues = [
      issue("api", { projectId: OTHER_BOARD }),
      issue("ui", { dependsOn: ["api"], needsAttentionAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(
      resolveStalledDependencyBoards({
        issue: issues[1]!,
        issues,
        projects: projects("2026-01-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  // Every other reason an issue is flagged: a failed start, a review that left
  // it alone, a blocker on this very board. None of them is a board to start.
  it("offers nothing for a flag that is not about another board", () => {
    const issues = [
      issue("a"),
      issue("b", { dependsOn: ["a"], needsAttentionAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(
      resolveStalledDependencyBoards({ issue: issues[1]!, issues, projects: projects(null) }),
    ).toBeNull();
  });

  // Switching the board on is only an answer when liveness is what the blocker
  // is missing. These blockers stay put whoever is running their board, so
  // offering to start it would clear the flag for a run that gives up again.
  it.each([
    { label: "canceled", overrides: { status: "canceled" as IssueStatus } },
    { label: "flagged", overrides: { needsAttentionAt: "2026-01-02T00:00:00.000Z" } },
    { label: "already carried by a thread", overrides: { threadId: "thread-1" } },
  ])("offers nothing for a blocker that is $label", ({ overrides }) => {
    const issues = [
      issue("api", { projectId: OTHER_BOARD, ...overrides }),
      issue("ui", { dependsOn: ["api"], needsAttentionAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(
      resolveStalledDependencyBoards({ issue: issues[1]!, issues, projects: projects(null) }),
    ).toBeNull();
  });
});
