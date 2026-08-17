import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  IssueId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";

import {
  attentionProjectKey,
  buildAttentionSnapshot,
  MAX_INDIVIDUAL_ALERTS,
  resolveAttentionPublication,
  resolveThreadAttentionKind,
  retainAttentionSnapshot,
  shouldPublishAttention,
  type AttentionIssue,
  type AttentionProject,
  type ThreadAttentionSnapshot,
} from "./desktopAttention";
import { DEFAULT_RUNTIME_MODE } from "./types";

const environmentId = EnvironmentId.make("environment-local");

const completedTurn: OrchestrationLatestTurn = {
  turnId: "turn-1" as never,
  state: "completed",
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

function makeSession(status: "running" | "starting" | "idle") {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: null,
    resumeAt: null,
    updatedAt: "2026-03-09T10:05:00.000Z",
  } as const;
}

function makeThread(
  id: string,
  overrides?: {
    title?: string;
    hasPendingApprovals?: boolean;
    hasPendingUserInput?: boolean;
    latestTurn?: OrchestrationLatestTurn | null;
    session?: ReturnType<typeof makeSession> | null;
  },
) {
  return {
    id: ThreadId.make(id),
    environmentId,
    title: overrides?.title ?? `Thread ${id}`,
    hasPendingApprovals: overrides?.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides?.hasPendingUserInput ?? false,
    latestTurn: overrides?.latestTurn === undefined ? completedTurn : overrides.latestTurn,
    session: overrides?.session === undefined ? null : overrides.session,
  };
}

/** Every thread was last opened before its turn completed, so completions read
    as unseen unless a test says otherwise. */
const visitedBeforeCompletion = { [`${environmentId}:thread-1`]: "2026-03-09T10:04:00.000Z" };

describe("resolveThreadAttentionKind", () => {
  it("ranks a pending approval above every other reason", () => {
    expect(
      resolveThreadAttentionKind(
        makeThread("thread-1", { hasPendingApprovals: true, hasPendingUserInput: true }),
        "2026-03-09T10:04:00.000Z",
      ),
    ).toBe("approval");
  });

  it("reports an unanswered agent question", () => {
    expect(
      resolveThreadAttentionKind(
        makeThread("thread-1", { hasPendingUserInput: true }),
        "2026-03-09T10:04:00.000Z",
      ),
    ).toBe("input");
  });

  it("reports a completion the user has not opened yet", () => {
    expect(resolveThreadAttentionKind(makeThread("thread-1"), "2026-03-09T10:04:00.000Z")).toBe(
      "completed",
    );
  });

  it("stays quiet while the turn is still running", () => {
    expect(
      resolveThreadAttentionKind(
        makeThread("thread-1", { session: makeSession("running") }),
        "2026-03-09T10:04:00.000Z",
      ),
    ).toBe(null);
  });

  it("stays quiet for a completion the user already read", () => {
    expect(resolveThreadAttentionKind(makeThread("thread-1"), "2026-03-09T10:06:00.000Z")).toBe(
      null,
    );
  });
});

describe("buildAttentionSnapshot", () => {
  it("keys threads by their scoped key and drops the quiet ones", () => {
    const snapshot = buildAttentionSnapshot({
      threads: [
        makeThread("thread-1", { hasPendingApprovals: true }),
        makeThread("thread-2", { session: makeSession("running") }),
      ],
      lastVisitedAtByThreadKey: {},
    });

    expect([...snapshot]).toEqual([[`${environmentId}:thread-1`, "approval"]]);
  });
});

describe("resolveAttentionPublication", () => {
  it("seeds silently when there is no baseline", () => {
    const publication = resolveAttentionPublication({
      previous: null,
      threads: [makeThread("thread-1", { hasPendingApprovals: true })],
      lastVisitedAtByThreadKey: {},
      suppressedThreadKey: null,
    });

    expect(publication.state.badgeCount).toBe(1);
    expect(publication.state.alerts).toEqual([]);
  });

  it("alerts on a thread that newly needs the user", () => {
    const publication = resolveAttentionPublication({
      previous: new Map(),
      threads: [makeThread("thread-1", { title: "Fix the flaky test", hasPendingApprovals: true })],
      lastVisitedAtByThreadKey: {},
      suppressedThreadKey: null,
    });

    expect(publication.state).toEqual({
      badgeCount: 1,
      alerts: [
        {
          title: "Approval needed",
          body: "Fix the flaky test",
          target: { environmentId, threadId: ThreadId.make("thread-1") },
        },
      ],
    });
  });

  it("does not re-alert a thread that is still in the same state", () => {
    const previous: ThreadAttentionSnapshot = new Map([[`${environmentId}:thread-1`, "approval"]]);
    const publication = resolveAttentionPublication({
      previous,
      threads: [makeThread("thread-1", { hasPendingApprovals: true })],
      lastVisitedAtByThreadKey: {},
      suppressedThreadKey: null,
    });

    expect(publication.state).toEqual({ badgeCount: 1, alerts: [] });
  });

  it("alerts again when the reason changes", () => {
    const previous: ThreadAttentionSnapshot = new Map([[`${environmentId}:thread-1`, "completed"]]);
    const publication = resolveAttentionPublication({
      previous,
      threads: [makeThread("thread-1", { hasPendingApprovals: true })],
      lastVisitedAtByThreadKey: {},
      suppressedThreadKey: null,
    });

    expect(publication.state.alerts).toHaveLength(1);
    expect(publication.state.alerts[0]?.title).toBe("Approval needed");
  });

  it("stays silent about the thread the user is already looking at", () => {
    const publication = resolveAttentionPublication({
      previous: new Map(),
      threads: [makeThread("thread-1")],
      lastVisitedAtByThreadKey: visitedBeforeCompletion,
      suppressedThreadKey: `${environmentId}:thread-1`,
    });

    // Still counted: the badge tracks what is waiting, not what was announced.
    expect(publication.state).toEqual({ badgeCount: 1, alerts: [] });
  });

  it("rolls a burst of transitions up into one banner", () => {
    const threads = Array.from({ length: MAX_INDIVIDUAL_ALERTS + 1 }, (_unused, index) =>
      makeThread(`thread-${index}`, { title: `Thread ${index}`, hasPendingApprovals: true }),
    );
    const publication = resolveAttentionPublication({
      previous: new Map(),
      threads,
      lastVisitedAtByThreadKey: {},
      suppressedThreadKey: null,
    });

    expect(publication.state.badgeCount).toBe(threads.length);
    expect(publication.state.alerts).toEqual([
      {
        title: `${threads.length} threads need you`,
        body: "Thread 0 · Thread 1 · Thread 2",
        target: null,
      },
    ]);
  });

  it("clears the badge once nothing is waiting", () => {
    const previous: ThreadAttentionSnapshot = new Map([[`${environmentId}:thread-1`, "approval"]]);
    const publication = resolveAttentionPublication({
      previous,
      threads: [makeThread("thread-1", { latestTurn: null })],
      lastVisitedAtByThreadKey: visitedBeforeCompletion,
      suppressedThreadKey: null,
    });

    expect(publication.state).toEqual({ badgeCount: 0, alerts: [] });
  });
});

const projectId = ProjectId.make("project-1");
const projectKey = attentionProjectKey({ environmentId, projectId });

function makeIssue(overrides?: Partial<AttentionIssue>): AttentionIssue {
  return {
    id: IssueId.make("issue-1"),
    environmentId,
    projectId,
    title: "Ship the importer",
    needsAttentionAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides?: Partial<AttentionProject>): AttentionProject {
  return {
    id: projectId,
    environmentId,
    title: "t3code",
    autonomousStartedAt: null,
    autonomousFinishedAt: "2026-03-09T11:00:00.000Z",
    autonomousFinishedReason: "completed",
    ...overrides,
  };
}

/** The publication inputs every board test shares, threads deliberately empty. */
function publishBoard(input: {
  previous: ThreadAttentionSnapshot | null;
  issues?: ReadonlyArray<AttentionIssue>;
  projects?: ReadonlyArray<AttentionProject>;
  suppressedProjectKey?: string | null;
}) {
  return resolveAttentionPublication({
    previous: input.previous,
    threads: [],
    lastVisitedAtByThreadKey: {},
    issues: input.issues ?? [],
    projects: input.projects ?? [],
    suppressedThreadKey: null,
    suppressedProjectKey: input.suppressedProjectKey ?? null,
  });
}

describe("issue attention", () => {
  it("alerts once when an issue is newly flagged, and points at the review tab", () => {
    const publication = publishBoard({ previous: new Map(), issues: [makeIssue()] });

    expect(publication.state).toEqual({
      badgeCount: 1,
      alerts: [
        {
          title: "Issue needs you",
          body: "Ship the importer",
          target: { environmentId, projectId, view: "review" },
        },
      ],
    });

    // Republishing the same flag is not news.
    expect(publishBoard({ previous: publication.snapshot, issues: [makeIssue()] }).state).toEqual({
      badgeCount: 1,
      alerts: [],
    });
  });

  it("stays silent about an issue that was already flagged when it seeded", () => {
    const publication = publishBoard({ previous: null, issues: [makeIssue()] });

    expect(publication.state).toEqual({ badgeCount: 1, alerts: [] });
  });

  it("drops the badge without announcing anything when the flag clears", () => {
    const seeded = publishBoard({ previous: new Map(), issues: [makeIssue()] });
    const cleared = publishBoard({
      previous: seeded.snapshot,
      issues: [makeIssue({ needsAttentionAt: null })],
    });

    expect(cleared.state).toEqual({ badgeCount: 0, alerts: [] });
  });

  it("keys issues apart from threads that share their id", () => {
    const snapshot = buildAttentionSnapshot({
      threads: [makeThread("issue-1", { hasPendingApprovals: true })],
      lastVisitedAtByThreadKey: {},
      issues: [makeIssue({ id: IssueId.make("issue-1") })],
    });

    expect([...snapshot.keys()]).toEqual([
      `${environmentId}:issue-1`,
      `issue:${environmentId}:issue-1`,
    ]);
  });

  it("says nothing about the board the user is already looking at", () => {
    const publication = publishBoard({
      previous: new Map(),
      issues: [makeIssue()],
      suppressedProjectKey: projectKey,
    });

    // Still counted: the badge tracks what is waiting, not what was announced.
    expect(publication.state).toEqual({ badgeCount: 1, alerts: [] });
  });
});

describe("autonomous run completion", () => {
  it("announces a finished run exactly once and never on a republish", () => {
    const publication = publishBoard({ previous: new Map(), projects: [makeProject()] });

    expect(publication.state.alerts).toEqual([
      {
        title: "Autonomous run finished",
        body: "t3code",
        target: { environmentId, projectId, view: "board" },
      },
    ]);

    expect(
      publishBoard({ previous: publication.snapshot, projects: [makeProject()] }).state.alerts,
    ).toEqual([]);
  });

  it("leaves the badge alone: a finished run is an announcement, not a chore", () => {
    const publication = publishBoard({
      previous: new Map(),
      issues: [makeIssue()],
      projects: [makeProject()],
    });

    expect(publication.state.badgeCount).toBe(1);
    expect(publication.state.alerts).toHaveLength(2);
  });

  it("announces the next run's completion as its own news", () => {
    const first = publishBoard({ previous: new Map(), projects: [makeProject()] });

    // Starting again clears the finished marks; the disappearance must be quiet.
    const restarted = publishBoard({
      previous: first.snapshot,
      projects: [
        makeProject({
          autonomousStartedAt: "2026-03-09T12:00:00.000Z",
          autonomousFinishedAt: null,
          autonomousFinishedReason: null,
        }),
      ],
    });
    expect(restarted.state).toEqual({ badgeCount: 0, alerts: [] });

    const second = publishBoard({
      previous: restarted.snapshot,
      projects: [makeProject({ autonomousFinishedAt: "2026-03-09T13:00:00.000Z" })],
    });
    expect(second.state.alerts).toHaveLength(1);
  });

  it("ignores a run a user stopped", () => {
    const publication = publishBoard({
      previous: new Map(),
      projects: [makeProject({ autonomousFinishedReason: "disabled" })],
    });

    expect(publication.state).toEqual({ badgeCount: 0, alerts: [] });
  });

  it("says nothing about the board the user is already looking at", () => {
    const publication = publishBoard({
      previous: new Map(),
      projects: [makeProject()],
      suppressedProjectKey: projectKey,
    });

    expect(publication.state).toEqual({ badgeCount: 0, alerts: [] });
  });
});

describe("retainAttentionSnapshot", () => {
  const boardSnapshot: ThreadAttentionSnapshot = new Map([
    [`${environmentId}:thread-1`, "approval"],
    [`issue:${environmentId}:issue-1`, "issue-attention"],
  ]);

  it("forgets the whole baseline while no threads are loaded", () => {
    expect(
      retainAttentionSnapshot({
        previous: boardSnapshot,
        snapshot: new Map(),
        threadsLoaded: false,
        boardLoaded: false,
      }),
    ).toBe(null);
  });

  it("carries board entries forward while the board data is missing", () => {
    const retained = retainAttentionSnapshot({
      previous: boardSnapshot,
      snapshot: new Map([[`${environmentId}:thread-1`, "approval"]]),
      threadsLoaded: true,
      boardLoaded: false,
    });

    // The refill then diffs against what was already flagged, so it is silent.
    expect(retained).not.toBe(null);
    expect([...retained!.keys()]).toContain(`issue:${environmentId}:issue-1`);
    expect(publishBoard({ previous: retained, issues: [makeIssue()] }).state.alerts).toEqual([]);
  });

  it("takes the fresh snapshot once the board data is there", () => {
    const snapshot: ThreadAttentionSnapshot = new Map([[`${environmentId}:thread-1`, "approval"]]);
    expect(
      retainAttentionSnapshot({
        previous: boardSnapshot,
        snapshot,
        threadsLoaded: true,
        boardLoaded: true,
      }),
    ).toBe(snapshot);
  });
});

describe("shouldPublishAttention", () => {
  it("skips an unchanged badge with nothing to announce", () => {
    expect(
      shouldPublishAttention({
        previousBadgeCount: 2,
        state: { badgeCount: 2, alerts: [] },
      }),
    ).toBe(false);
  });

  it("publishes the first state even when the badge is empty", () => {
    expect(
      shouldPublishAttention({
        previousBadgeCount: null,
        state: { badgeCount: 0, alerts: [] },
      }),
    ).toBe(true);
  });

  it("publishes whenever there is something to announce", () => {
    expect(
      shouldPublishAttention({
        previousBadgeCount: 1,
        state: {
          badgeCount: 1,
          alerts: [{ title: "Approval needed", body: "Thread", target: null }],
        },
      }),
    ).toBe(true);
  });
});
