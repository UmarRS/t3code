import {
  IssueId,
  ThreadId,
  type IssueReviewVerdict,
  type IssueStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autonomousRunActionLabel,
  buildReviewSections,
  describeAutonomousRunStatus,
  formatAutonomousProgressLabel,
  hasAutonomousReviewerProvider,
  issueRetryRestartsWork,
  planIssueAttentionClear,
  planIssueAttentionRetry,
  resolveAutonomousRunState,
  resolveIssueAttentionPresentation,
  summarizeAutonomousProgress,
  type ReviewIssueView,
} from "./autonomousRun.logic";

describe("autonomousRunActionLabel", () => {
  it("only calls a user-stopped run resumable", () => {
    expect(autonomousRunActionLabel({ kind: "finished", finishedAt: null })).toBe("Start");
    expect(autonomousRunActionLabel({ kind: "stopped", finishedAt: null })).toBe("Resume");
  });
});

function issue(
  id: string,
  overrides: {
    status?: IssueStatus;
    dependsOn?: ReadonlyArray<string>;
    threadId?: string | null;
    needsAttentionAt?: string | null;
    needsAttentionReason?: string | null;
    reviewVerdict?: IssueReviewVerdict | null;
    reviewedAt?: string | null;
    updatedAt?: string;
  } = {},
): ReviewIssueView & { readonly dependsOn: ReadonlyArray<IssueId> } {
  return {
    id: IssueId.make(id),
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
      inProgress: 1,
      inReview: 1,
      done: 1,
      needsAttention: 1,
      total: 6,
    });
  });

  // An issue the server filed away a day after finishing is still finished
  // work, and still part of what the run was asked to get through.
  it("keeps counting an archived issue as done", () => {
    const progress = summarizeAutonomousProgress([
      ...issues,
      issue("filed-away", { status: "archived" }),
    ]);
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(7);
  });

  it("does not count a flagged issue as active or startable", () => {
    const progress = summarizeAutonomousProgress([
      issue("parked", { needsAttentionAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(progress.queued).toBe(0);
    expect(progress.inProgress).toBe(0);
    expect(progress.needsAttention).toBe(1);
  });

  it("formats a compact label and drops empty lanes", () => {
    expect(formatAutonomousProgressLabel(summarizeAutonomousProgress(issues))).toBe(
      "1 in progress · 1 in review · 1 queued · 1 needs you · 1 done / 6",
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
