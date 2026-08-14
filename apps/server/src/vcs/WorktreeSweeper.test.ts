import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  isPathInsideDirectory,
  parseWorktreeList,
  selectWorktreeSweepCandidates,
  sweepWorktrees,
  WorktreeSweepError,
  type WorktreeSweepDependencies,
  type WorktreeSweepProject,
  type WorktreeSweepThread,
} from "./WorktreeSweeper.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The test clock starts at the epoch, which would make every "settled 15 days
 * ago" timestamp land in 1969. Sweeps run against ordinary dates, so pin the
 * clock somewhere ordinary too.
 */
const NOW_MS = Date.UTC(2026, 4, 12, 9, 0, 0);
const MIN_AGE_MS = 14 * DAY_MS;
const WORKTREES_DIR = "/home/dev/.t3/worktrees";
const WORKSPACE_ROOT = "/home/dev/code/t3code";
const PROJECT_ID = ProjectId.make("project-1");

const iso = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const project = (overrides?: Partial<WorktreeSweepProject>): WorktreeSweepProject => ({
  projectId: PROJECT_ID,
  title: "t3code",
  workspaceRoot: WORKSPACE_ROOT,
  ...overrides,
});

const thread = (id: string, overrides?: Partial<WorktreeSweepThread>): WorktreeSweepThread => ({
  threadId: ThreadId.make(id),
  projectId: PROJECT_ID,
  worktreePath: `${WORKTREES_DIR}/t3code/${id}`,
  settledAt: null,
  archivedAt: null,
  settledOverride: null,
  pinnedAt: null,
  hasLiveWork: false,
  ...overrides,
});

const settledDaysAgo = (nowMs: number, days: number) => ({
  settledOverride: "settled" as const,
  settledAt: iso(nowMs - days * DAY_MS),
});

const select = (input: {
  readonly nowMs: number;
  readonly threads: ReadonlyArray<WorktreeSweepThread>;
  readonly projects?: ReadonlyArray<WorktreeSweepProject>;
}) =>
  selectWorktreeSweepCandidates({
    threads: input.threads,
    projects: input.projects ?? [project()],
    worktreesDir: WORKTREES_DIR,
    nowMs: input.nowMs,
    minAgeMs: MIN_AGE_MS,
  });

describe("isPathInsideDirectory", () => {
  it("accepts nested paths and rejects the root, siblings, and lookalikes", () => {
    assert.isTrue(isPathInsideDirectory(`${WORKTREES_DIR}/t3code/feature`, WORKTREES_DIR));
    assert.isTrue(isPathInsideDirectory(`${WORKTREES_DIR}/t3code/feature/`, WORKTREES_DIR));
    // The worktrees directory itself is never removable.
    assert.isFalse(isPathInsideDirectory(WORKTREES_DIR, WORKTREES_DIR));
    assert.isFalse(isPathInsideDirectory(`${WORKTREES_DIR}-backup/t3code`, WORKTREES_DIR));
    assert.isFalse(isPathInsideDirectory("/home/dev/code/t3code", WORKTREES_DIR));
    assert.isFalse(isPathInsideDirectory("", WORKTREES_DIR));
  });

  it("compares windows separators as path separators", () => {
    assert.isTrue(
      isPathInsideDirectory(
        "C:\\Users\\dev\\.t3\\worktrees\\repo\\x",
        "C:\\Users\\dev\\.t3\\worktrees",
      ),
    );
    assert.isFalse(
      isPathInsideDirectory(
        "C:\\Users\\dev\\.t3\\worktrees2\\repo",
        "C:\\Users\\dev\\.t3\\worktrees",
      ),
    );
  });
});

describe("parseWorktreeList", () => {
  it("reads paths, marks the main worktree, and detects locks", () => {
    const entries = parseWorktreeList(
      [
        `worktree ${WORKSPACE_ROOT}`,
        "HEAD abc",
        "branch refs/heads/main",
        "",
        `worktree ${WORKTREES_DIR}/t3code/one`,
        "HEAD def",
        "branch refs/heads/one",
        "",
        `worktree ${WORKTREES_DIR}/t3code/two`,
        "HEAD ghi",
        "locked reason goes here",
        "",
      ].join("\n"),
    );

    assert.deepStrictEqual(entries, [
      { path: WORKSPACE_ROOT, locked: false, isMain: true },
      { path: `${WORKTREES_DIR}/t3code/one`, locked: false, isMain: false },
      { path: `${WORKTREES_DIR}/t3code/two`, locked: true, isMain: false },
    ]);
  });
});

describe("selectWorktreeSweepCandidates", () => {
  it.effect("selects a worktree settled past the threshold", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [thread("old", settledDaysAgo(nowMs, 15))],
      });

      assert.deepStrictEqual(
        selection.candidates.map((candidate) => candidate.worktreePath),
        [`${WORKTREES_DIR}/t3code/old`],
      );
      assert.deepStrictEqual(selection.skips, []);
    }),
  );

  it.effect("treats an archived thread as parked even when it never settled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [thread("archived", { archivedAt: iso(nowMs - 20 * DAY_MS) })],
      });

      assert.equal(selection.candidates.length, 1);
    }),
  );

  it.effect("uses the most recent parking event, so a fresh archive holds the worktree", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [
          thread("recent-archive", {
            ...settledDaysAgo(nowMs, 40),
            archivedAt: iso(nowMs - DAY_MS),
          }),
        ],
      });

      assert.deepStrictEqual(
        selection.skips.map((skip) => skip.reason),
        ["settled-too-recently"],
      );
      assert.deepStrictEqual(selection.candidates, []);
    }),
  );

  it.effect("treats the threshold itself as old enough", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [thread("boundary", settledDaysAgo(nowMs, 14))],
      });

      assert.equal(selection.candidates.length, 1);
      assert.deepStrictEqual(selection.skips, []);
    }),
  );

  it.effect("keeps worktrees settled inside the threshold", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [thread("fresh", settledDaysAgo(nowMs, 13))],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => skip.reason),
        ["settled-too-recently"],
      );
    }),
  );

  it.effect("keeps active, un-settled, pinned, and busy threads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [
          thread("never-settled"),
          thread("unsettled-by-user", {
            ...settledDaysAgo(nowMs, 30),
            settledOverride: "active",
          }),
          thread("pinned", {
            ...settledDaysAgo(nowMs, 30),
            pinnedAt: iso(nowMs - 30 * DAY_MS),
          }),
          thread("busy", { ...settledDaysAgo(nowMs, 30), hasLiveWork: true }),
        ],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => [skip.threadIds[0], skip.reason]),
        [
          [ThreadId.make("busy"), "thread-active"],
          [ThreadId.make("never-settled"), "thread-active"],
          [ThreadId.make("pinned"), "thread-pinned"],
          [ThreadId.make("unsettled-by-user"), "thread-active"],
        ],
      );
    }),
  );

  it.effect("keeps a shared worktree while any thread on it is active", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const sharedPath = `${WORKTREES_DIR}/t3code/shared`;
      const selection = select({
        nowMs,
        threads: [
          thread("shared-old", { worktreePath: sharedPath, ...settledDaysAgo(nowMs, 30) }),
          thread("shared-live", { worktreePath: sharedPath }),
        ],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => ({ reason: skip.reason, threads: skip.threadIds.length })),
        [{ reason: "thread-active", threads: 2 }],
      );
    }),
  );

  it.effect("never selects the project workspace root", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [
          thread("in-root", { worktreePath: WORKSPACE_ROOT, ...settledDaysAgo(nowMs, 30) }),
        ],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => skip.reason),
        ["workspace-root"],
      );
    }),
  );

  it.effect("never selects a path outside the worktrees directory", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        threads: [
          thread("elsewhere", {
            worktreePath: "/home/dev/somewhere-else/checkout",
            ...settledDaysAgo(nowMs, 30),
          }),
          thread("lookalike", {
            worktreePath: `${WORKTREES_DIR}-backup/t3code/x`,
            ...settledDaysAgo(nowMs, 30),
          }),
        ],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => skip.reason),
        ["outside-worktrees-dir", "outside-worktrees-dir"],
      );
    }),
  );

  it.effect("skips worktrees whose project is missing from the snapshot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const selection = select({
        nowMs,
        projects: [],
        threads: [thread("orphan", settledDaysAgo(nowMs, 30))],
      });

      assert.deepStrictEqual(selection.candidates, []);
      assert.deepStrictEqual(
        selection.skips.map((skip) => skip.reason),
        ["unknown-project"],
      );
    }),
  );
});

// ── Sweep harness ────────────────────────────────────────────────────

interface FakeWorktree {
  readonly status?: string;
  readonly head?: string;
  readonly upstream?: string | null;
  readonly aheadCount?: number;
  readonly merged?: boolean;
  readonly locked?: boolean;
  readonly registered?: boolean;
  readonly exists?: boolean;
}

interface FakeSweep {
  readonly deps: WorktreeSweepDependencies;
  readonly removed: Array<string>;
  readonly clearedThreads: Array<ThreadId>;
  readonly gitCommands: Array<string>;
  readonly snapshotLoads: { count: number };
}

const makeFakeSweep = (input: {
  readonly threads: ReadonlyArray<WorktreeSweepThread>;
  readonly worktrees: Record<string, FakeWorktree>;
  readonly enabled?: boolean;
  readonly baseRef?: string | null;
  readonly projects?: ReadonlyArray<WorktreeSweepProject>;
  readonly realPaths?: Record<string, string>;
  readonly removeWorktree?: (path: string) => Effect.Effect<void, WorktreeSweepError>;
  readonly clearThreadWorktreePath?: (
    threadId: ThreadId,
  ) => Effect.Effect<void, WorktreeSweepError>;
}): FakeSweep => {
  const removed: Array<string> = [];
  const clearedThreads: Array<ThreadId> = [];
  const gitCommands: Array<string> = [];
  const snapshotLoads = { count: 0 };
  const baseRef = input.baseRef === undefined ? "origin/main" : input.baseRef;

  const stateFor = (cwd: string): FakeWorktree => input.worktrees[cwd] ?? {};

  const deps: WorktreeSweepDependencies = {
    worktreesDir: WORKTREES_DIR,
    minAgeMs: MIN_AGE_MS,
    isEnabled: Effect.succeed(input.enabled ?? true),
    loadSnapshot: Effect.sync(() => {
      snapshotLoads.count += 1;
      return { projects: input.projects ?? [project()], threads: input.threads };
    }),
    canonicalizePath: (value) => Effect.succeed(input.realPaths?.[value] ?? value),
    directoryExists: (value) => Effect.succeed(stateFor(value).exists ?? true),
    runGit: (request) => {
      const command = request.args.join(" ");
      gitCommands.push(`${request.cwd}: ${command}`);
      const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout });
      const fail = () => Effect.succeed({ exitCode: 1, stdout: "" });

      if (command === "worktree list --porcelain") {
        const lines = [`worktree ${request.cwd}`, "HEAD main-sha", "branch refs/heads/main", ""];
        for (const [path, state] of Object.entries(input.worktrees)) {
          if (state.registered === false) {
            continue;
          }
          lines.push(`worktree ${path}`, `HEAD ${state.head ?? "sha"}`);
          if (state.locked) {
            lines.push("locked");
          }
          lines.push("");
        }
        return ok(lines.join("\n"));
      }
      if (command === "symbolic-ref --short refs/remotes/origin/HEAD") {
        return baseRef === null ? fail() : ok(`${baseRef}\n`);
      }
      if (request.args[0] === "rev-parse" && request.args[1] === "--verify") {
        return fail();
      }
      if (command === "status --porcelain") {
        return ok(stateFor(request.cwd).status ?? "");
      }
      if (command === "rev-parse HEAD") {
        return ok(`${stateFor(request.cwd).head ?? "sha"}\n`);
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
        const upstream = stateFor(request.cwd).upstream;
        return upstream == null ? fail() : ok(`${upstream}\n`);
      }
      if (request.args[0] === "merge-base") {
        return stateFor(request.cwd).merged === true ? ok("") : fail();
      }
      if (request.args[0] === "rev-list") {
        return ok(`${stateFor(request.cwd).aheadCount ?? 0}\n`);
      }
      return Effect.fail(new WorktreeSweepError({ operation: command, cause: "unexpected" }));
    },
    removeWorktree: (request) =>
      (input.removeWorktree?.(request.path) ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            removed.push(request.path);
          }),
        ),
      ),
    clearThreadWorktreePath: (threadId) =>
      (input.clearThreadWorktreePath?.(threadId) ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            clearedThreads.push(threadId);
          }),
        ),
      ),
  };

  return { deps, removed, clearedThreads, gitCommands, snapshotLoads };
};

describe("sweepWorktrees", () => {
  it.effect("removes a merged worktree and clears the thread's recorded path", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/merged`;
      const fake = makeFakeSweep({
        threads: [thread("merged", { worktreePath, ...settledDaysAgo(nowMs, 15) })],
        worktrees: { [worktreePath]: { merged: true, status: " M src/app.ts\n" } },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, [worktreePath]);
      assert.deepStrictEqual(fake.clearedThreads, [ThreadId.make("merged")]);
      assert.equal(summary.removedCount, 1);
      assert.equal(summary.failedCount, 0);
      assert.deepStrictEqual(summary.projects[0]?.removed, [worktreePath]);
      assert.equal(summary.projects[0]?.projectId, PROJECT_ID);
    }),
  );

  it.effect("removes a clean, fully pushed worktree that was never merged", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/pushed`;
      const fake = makeFakeSweep({
        threads: [thread("pushed", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: {
          [worktreePath]: { merged: false, upstream: "origin/pushed", aheadCount: 0 },
        },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, [worktreePath]);
      assert.equal(summary.removedCount, 1);
    }),
  );

  it.effect("skips an unmerged worktree with uncommitted changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/dirty`;
      const fake = makeFakeSweep({
        threads: [thread("dirty", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: {
          [worktreePath]: { merged: false, status: "?? notes.md\n", upstream: "origin/dirty" },
        },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, []);
      assert.deepStrictEqual(fake.clearedThreads, []);
      assert.deepStrictEqual(summary.projects[0]?.skipped, [
        { worktreePath, reason: "uncommitted-changes" },
      ]);
    }),
  );

  it.effect("skips a clean worktree that still has unpushed commits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/ahead`;
      const fake = makeFakeSweep({
        threads: [thread("ahead", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: {
          [worktreePath]: { merged: false, upstream: "origin/ahead", aheadCount: 3 },
        },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, []);
      assert.deepStrictEqual(summary.projects[0]?.skipped, [
        { worktreePath, reason: "unpushed-commits", detail: "ahead of origin/ahead" },
      ]);
    }),
  );

  it.effect("skips when there is no upstream and no base branch to compare against", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/no-base`;
      const fake = makeFakeSweep({
        baseRef: null,
        threads: [thread("no-base", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: { [worktreePath]: { merged: false, upstream: null } },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, []);
      assert.equal(summary.projects[0]?.skipped[0]?.reason, "unpushed-commits");
    }),
  );

  it.effect("skips locked, unregistered, and missing worktrees", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const locked = `${WORKTREES_DIR}/t3code/locked`;
      const unregistered = `${WORKTREES_DIR}/t3code/unregistered`;
      const missing = `${WORKTREES_DIR}/t3code/missing`;
      const fake = makeFakeSweep({
        threads: [
          thread("locked", { worktreePath: locked, ...settledDaysAgo(nowMs, 30) }),
          thread("unregistered", { worktreePath: unregistered, ...settledDaysAgo(nowMs, 30) }),
          thread("missing", { worktreePath: missing, ...settledDaysAgo(nowMs, 30) }),
        ],
        worktrees: {
          [locked]: { merged: true, locked: true },
          [unregistered]: { merged: true, registered: false },
          [missing]: { merged: true, exists: false },
        },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, []);
      assert.deepStrictEqual(
        (summary.projects[0]?.skipped ?? []).map((skip) => [skip.worktreePath, skip.reason]),
        [
          [locked, "worktree-locked"],
          [missing, "worktree-missing"],
          [unregistered, "worktree-not-registered"],
        ],
      );
    }),
  );

  it.effect("refuses a recorded path that resolves outside the worktrees directory", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/symlinked`;
      const fake = makeFakeSweep({
        threads: [thread("symlinked", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: { [worktreePath]: { merged: true } },
        // The recorded path passes the lexical guard but points at a symlink
        // leading somewhere else entirely.
        realPaths: { [worktreePath]: "/home/dev/code/t3code" },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, []);
      assert.equal(summary.projects[0]?.skipped[0]?.reason, "outside-worktrees-dir");
      assert.isFalse(fake.gitCommands.some((command) => command.includes("worktree list")));
    }),
  );

  it.effect("isolates a failing candidate from the rest of the sweep", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const failing = `${WORKTREES_DIR}/t3code/failing`;
      const healthy = `${WORKTREES_DIR}/t3code/healthy`;
      const fake = makeFakeSweep({
        threads: [
          thread("failing", { worktreePath: failing, ...settledDaysAgo(nowMs, 30) }),
          thread("healthy", { worktreePath: healthy, ...settledDaysAgo(nowMs, 30) }),
        ],
        worktrees: {
          [failing]: { merged: true },
          [healthy]: { merged: true },
        },
        removeWorktree: (path) =>
          path === failing
            ? Effect.fail(
                new WorktreeSweepError({ operation: "removeWorktree", cause: "git said no" }),
              )
            : Effect.void,
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, [healthy]);
      assert.deepStrictEqual(fake.clearedThreads, [ThreadId.make("healthy")]);
      assert.equal(summary.removedCount, 1);
      assert.equal(summary.failedCount, 1);
      assert.equal(summary.projects[0]?.failed[0]?.worktreePath, failing);
    }),
  );

  it.effect("still counts a removal whose thread update fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/stubborn`;
      const fake = makeFakeSweep({
        threads: [thread("stubborn", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: { [worktreePath]: { merged: true } },
        clearThreadWorktreePath: () =>
          Effect.fail(
            new WorktreeSweepError({ operation: "clearThreadWorktreePath", cause: "offline" }),
          ),
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.deepStrictEqual(fake.removed, [worktreePath]);
      assert.equal(summary.removedCount, 1);
      assert.equal(summary.failedCount, 0);
    }),
  );

  it.effect("does nothing at all when the setting is off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const worktreePath = `${WORKTREES_DIR}/t3code/merged`;
      const fake = makeFakeSweep({
        enabled: false,
        threads: [thread("merged", { worktreePath, ...settledDaysAgo(nowMs, 30) })],
        worktrees: { [worktreePath]: { merged: true } },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      assert.isFalse(summary.enabled);
      assert.equal(fake.snapshotLoads.count, 0);
      assert.deepStrictEqual(fake.gitCommands, []);
      assert.deepStrictEqual(fake.removed, []);
    }),
  );

  it.effect("reports removals and skips per project", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const nowMs = yield* Clock.currentTimeMillis;
      const otherProjectId = ProjectId.make("project-2");
      const otherRoot = "/home/dev/code/other";
      const removable = `${WORKTREES_DIR}/t3code/removable`;
      const dirty = `${WORKTREES_DIR}/other/dirty`;
      const fake = makeFakeSweep({
        projects: [
          project(),
          { projectId: otherProjectId, title: "other", workspaceRoot: otherRoot },
        ],
        threads: [
          thread("removable", { worktreePath: removable, ...settledDaysAgo(nowMs, 30) }),
          thread("dirty", {
            projectId: otherProjectId,
            worktreePath: dirty,
            ...settledDaysAgo(nowMs, 30),
          }),
          thread("live", { worktreePath: `${WORKTREES_DIR}/t3code/live` }),
        ],
        worktrees: {
          [removable]: { merged: true },
          [dirty]: { merged: false, status: " M x\n" },
        },
      });

      const summary = yield* sweepWorktrees(fake.deps);

      const byProject = new Map(summary.projects.map((entry) => [entry.projectId, entry] as const));
      assert.deepStrictEqual(byProject.get(PROJECT_ID)?.removed, [removable]);
      assert.equal(byProject.get(PROJECT_ID)?.retainedCount, 1);
      assert.equal(byProject.get(PROJECT_ID)?.projectTitle, "t3code");
      assert.deepStrictEqual(byProject.get(otherProjectId)?.skipped, [
        { worktreePath: dirty, reason: "uncommitted-changes" },
      ]);
      assert.equal(byProject.get(otherProjectId)?.workspaceRoot, otherRoot);
    }),
  );
});
