/**
 * WorktreeSweeper - Background cleanup of worktrees left behind by settled work.
 *
 * Worktrees are created per thread under `<worktreesDir>/<repo>/<branch>` and
 * nothing ever removed them, so disk usage only grew. This sweep removes the
 * checkout - never the branch - promptly after an autonomous issue merges, or
 * once every thread pointing at it has been settled, archived, or deleted for
 * 24 hours during the six-hour periodic sweep. Both durations are server
 * settings. Removal only happens when losing the local checkout cannot lose
 * work: the branch is merged into the repo's base branch, or the worktree is
 * clean with nothing unpushed.
 * Anything else is skipped with a reason. When in doubt, skip.
 *
 * The candidate selection and the sweep itself are written against an explicit
 * dependency record (`WorktreeSweepDependencies`) so both can be unit tested
 * without standing up git, sqlite, or the orchestration engine. The live layer
 * is only the wiring plus scheduling.
 *
 * @module WorktreeSweeper
 */
import {
  CommandId,
  DEFAULT_WORKTREE_SWEEP_INTERVAL,
  DEFAULT_WORKTREE_SWEEP_MIN_AGE,
  type OrchestrationEvent,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

/** A worktree is only swept once every thread on it has been parked this long. */
export const WORKTREE_SWEEP_MIN_AGE = DEFAULT_WORKTREE_SWEEP_MIN_AGE;

/** Cadence of the periodic sweep after the first startup run. */
export const WORKTREE_SWEEP_INTERVAL = DEFAULT_WORKTREE_SWEEP_INTERVAL;

/**
 * Delay before the first sweep. Long enough to stay out of the way of boot
 * (project hydration, provider launches, the user's first turn), short enough
 * that a machine that is restarted daily still gets swept.
 */
export const WORKTREE_SWEEP_STARTUP_DELAY = Duration.minutes(2);

/** Base branches tried, in order, when the repo has no `origin/HEAD`. */
const BASE_REF_FALLBACKS = ["origin/main", "origin/master", "main", "master"] as const;

/**
 * One failed step of a sweep. Every dependency funnels its own error type into
 * this so the sweep can isolate failures per worktree without knowing whether
 * git, sqlite, or the orchestration engine was the one that gave up.
 */
export class WorktreeSweepError extends Schema.TaggedErrorClass<WorktreeSweepError>()(
  "WorktreeSweepError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Worktree sweep step ${this.operation} failed.`;
  }
}

const sweepFailure = (operation: string) => (cause: unknown) =>
  new WorktreeSweepError({ operation, cause });

// ── Selection ────────────────────────────────────────────────────────

export interface WorktreeSweepThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly settledAt: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly pinnedAt?: string | null | undefined;
  /** A running turn or live background work keeps the worktree pinned in place. */
  readonly hasLiveWork: boolean;
}

export interface WorktreeSweepProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export type WorktreeSweepSkipReason =
  /** A thread on this worktree is still active (or has live work). */
  | "thread-active"
  /** A thread on this worktree is pinned, which outranks the settled shelf. */
  | "thread-pinned"
  /** Every thread is parked, but not for long enough yet. */
  | "settled-too-recently"
  /** No project row, or threads from several projects, share the path. */
  | "unknown-project"
  /** The path is a project's main workspace root. Never removable. */
  | "workspace-root"
  /** Hard guard: the path does not live under the configured worktrees dir. */
  | "outside-worktrees-dir"
  /** Nothing on disk at that path anymore. */
  | "worktree-missing"
  /** `git worktree list` in the project repo does not know this path. */
  | "worktree-not-registered"
  /** The worktree is locked, so git would refuse anyway. */
  | "worktree-locked"
  | "uncommitted-changes"
  | "unpushed-commits";

/** Reasons that mean "normal, expected retention" rather than "look at this". */
const LIFECYCLE_SKIP_REASONS: ReadonlySet<WorktreeSweepSkipReason> = new Set([
  "thread-active",
  "thread-pinned",
  "settled-too-recently",
]);

export interface WorktreeSweepSkip {
  readonly worktreePath: string;
  readonly projectId: ProjectId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly reason: WorktreeSweepSkipReason;
  readonly detail?: string | undefined;
}

export interface WorktreeSweepCandidate {
  readonly worktreePath: string;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

export interface WorktreeSweepSelection {
  readonly candidates: ReadonlyArray<WorktreeSweepCandidate>;
  readonly skips: ReadonlyArray<WorktreeSweepSkip>;
}

const normalizePathForComparison = (value: string): string =>
  value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");

/**
 * Strict containment: `root` itself is not "inside" root, so the worktrees
 * directory can never be handed to `git worktree remove`.
 */
export function isPathInsideDirectory(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedRoot = normalizePathForComparison(root);
  if (normalizedCandidate.length === 0 || normalizedRoot.length === 0) {
    return false;
  }
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

const parseIsoMillis = (value: string | null | undefined): number | null =>
  value == null
    ? null
    : Option.match(DateTime.make(value), {
        onNone: () => null,
        onSome: (dateTime) => DateTime.toEpochMillis(dateTime),
      });

/**
 * When a thread was parked, or `null` while it is still live. Settling,
 * archiving, and deleting are parking events; the later one wins so a freshly
 * deleted thread is not treated as untouched for a fortnight.
 */
function parkedAtMillis(thread: WorktreeSweepThread): number | null {
  const settledAt = thread.settledOverride === "settled" ? parseIsoMillis(thread.settledAt) : null;
  const archivedAt = parseIsoMillis(thread.archivedAt);
  const deletedAt = parseIsoMillis(thread.deletedAt);
  // Not `Math.max(a ?? 0, b ?? 0)`: zero is a real epoch millisecond, not a
  // neutral element, so a missing half must drop out rather than floor the max.
  const parked = [settledAt, archivedAt, deletedAt].filter((value) => value !== null);
  return parked.length === 0 ? null : Math.max(...parked);
}

type ThreadVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: WorktreeSweepSkipReason };

function judgeThread(input: {
  readonly thread: WorktreeSweepThread;
  readonly nowMs: number;
  readonly minAgeMs: number;
  readonly waiveSettledAge: boolean;
}): ThreadVerdict {
  const { thread } = input;
  if (thread.hasLiveWork || thread.settledOverride === "active") {
    return { eligible: false, reason: "thread-active" };
  }
  if (thread.pinnedAt != null) {
    return { eligible: false, reason: "thread-pinned" };
  }
  if (input.waiveSettledAge) {
    return { eligible: true };
  }
  const parkedAt = parkedAtMillis(thread);
  if (parkedAt === null) {
    return { eligible: false, reason: "thread-active" };
  }
  if (input.nowMs - parkedAt < input.minAgeMs) {
    return { eligible: false, reason: "settled-too-recently" };
  }
  return { eligible: true };
}

/** Loudest wins, so a group with one active thread never reads as "too recent". */
const SKIP_REASON_PRECEDENCE: ReadonlyArray<WorktreeSweepSkipReason> = [
  "thread-active",
  "thread-pinned",
  "settled-too-recently",
];

/**
 * Group the threads by worktree and decide which whole worktrees may go.
 *
 * A worktree is shared by every thread that records it, so the group - not the
 * thread - is the unit: one active thread keeps the checkout for everyone.
 */
export function selectWorktreeSweepCandidates(input: {
  readonly threads: ReadonlyArray<WorktreeSweepThread>;
  readonly projects: ReadonlyArray<WorktreeSweepProject>;
  readonly worktreesDir: string;
  readonly nowMs: number;
  readonly minAgeMs: number;
  readonly targetThreadId?: ThreadId;
}): WorktreeSweepSelection {
  const projectsById = new Map(input.projects.map((project) => [project.projectId, project]));
  const workspaceRoots = new Set(
    input.projects.map((project) => normalizePathForComparison(project.workspaceRoot)),
  );

  const groups = new Map<
    string,
    { readonly worktreePath: string; readonly threads: Array<WorktreeSweepThread> }
  >();
  const targetPath =
    input.targetThreadId === undefined
      ? undefined
      : input.threads.find((thread) => thread.threadId === input.targetThreadId)?.worktreePath;
  for (const thread of input.threads) {
    const worktreePath = thread.worktreePath?.trim();
    if (!worktreePath) {
      continue;
    }
    const key = normalizePathForComparison(worktreePath);
    if (
      input.targetThreadId !== undefined &&
      (targetPath == null || key !== normalizePathForComparison(targetPath))
    ) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.threads.push(thread);
      continue;
    }
    groups.set(key, { worktreePath, threads: [thread] });
  }

  const candidates: Array<WorktreeSweepCandidate> = [];
  const skips: Array<WorktreeSweepSkip> = [];

  for (const [key, group] of Array.from(groups.entries()).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const threadIds = group.threads.map((thread) => thread.threadId);
    const projectIds = Array.from(new Set(group.threads.map((thread) => thread.projectId)));
    const projectId = projectIds.length === 1 ? (projectIds[0] ?? null) : null;
    const skip = (reason: WorktreeSweepSkipReason, detail?: string) => {
      skips.push({
        worktreePath: group.worktreePath,
        projectId,
        threadIds,
        reason,
        ...(detail === undefined ? {} : { detail }),
      });
    };

    const reasons = new Set(
      group.threads.flatMap((thread) => {
        const verdict = judgeThread({
          thread,
          nowMs: input.nowMs,
          minAgeMs: input.minAgeMs,
          waiveSettledAge: input.targetThreadId !== undefined,
        });
        return verdict.eligible ? [] : [verdict.reason];
      }),
    );
    const lifecycleReason = SKIP_REASON_PRECEDENCE.find((reason) => reasons.has(reason));
    if (lifecycleReason) {
      skip(lifecycleReason);
      continue;
    }

    const project = projectId === null ? undefined : projectsById.get(projectId);
    if (!project) {
      skip(
        "unknown-project",
        projectIds.length > 1
          ? `threads span ${projectIds.length} projects`
          : "no project row for the recorded thread",
      );
      continue;
    }
    if (workspaceRoots.has(key)) {
      skip("workspace-root");
      continue;
    }
    if (!isPathInsideDirectory(group.worktreePath, input.worktreesDir)) {
      skip("outside-worktrees-dir");
      continue;
    }

    candidates.push({
      worktreePath: group.worktreePath,
      projectId: project.projectId,
      workspaceRoot: project.workspaceRoot,
      threadIds,
    });
  }

  return { candidates, skips };
}

// ── Sweeping ─────────────────────────────────────────────────────────

export interface WorktreeSweepGitResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface WorktreeSweepDependencies {
  readonly worktreesDir: string;
  readonly minAgeMs: number;
  /** Read once per sweep; a disabled sweep does no reads and no removals. */
  readonly isEnabled: Effect.Effect<boolean>;
  readonly loadSnapshot: Effect.Effect<
    {
      readonly projects: ReadonlyArray<WorktreeSweepProject>;
      readonly threads: ReadonlyArray<WorktreeSweepThread>;
    },
    WorktreeSweepError
  >;
  readonly canonicalizePath: (value: string) => Effect.Effect<string, WorktreeSweepError>;
  readonly directoryExists: (value: string) => Effect.Effect<boolean, WorktreeSweepError>;
  readonly runGit: (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowNonZeroExit?: boolean;
  }) => Effect.Effect<WorktreeSweepGitResult, WorktreeSweepError>;
  readonly removeWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
  }) => Effect.Effect<void, WorktreeSweepError>;
  readonly clearThreadWorktreePath: (threadId: ThreadId) => Effect.Effect<void, WorktreeSweepError>;
}

export interface WorktreeSweepProjectSummary {
  readonly projectId: ProjectId | null;
  readonly projectTitle: string | null;
  readonly workspaceRoot: string | null;
  readonly removed: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{
    readonly worktreePath: string;
    readonly reason: WorktreeSweepSkipReason;
    readonly detail?: string | undefined;
  }>;
  readonly failed: ReadonlyArray<{ readonly worktreePath: string; readonly detail: string }>;
  /** Worktrees held back purely because their threads are still live/recent. */
  readonly retainedCount: number;
}

export interface WorktreeSweepSummary {
  readonly enabled: boolean;
  readonly worktreeCount: number;
  readonly removedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly retainedCount: number;
  readonly projects: ReadonlyArray<WorktreeSweepProjectSummary>;
}

const emptySummary = (enabled: boolean): WorktreeSweepSummary => ({
  enabled,
  worktreeCount: 0,
  removedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  retainedCount: 0,
  projects: [],
});

interface WorktreeListEntry {
  readonly path: string;
  readonly locked: boolean;
  readonly isMain: boolean;
}

export function parseWorktreeList(stdout: string): ReadonlyArray<WorktreeListEntry> {
  const entries: Array<WorktreeListEntry> = [];
  let path: string | null = null;
  let locked = false;
  const flush = () => {
    if (path !== null) {
      entries.push({ path, locked, isMain: entries.length === 0 });
    }
    path = null;
    locked = false;
  };
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
      continue;
    }
    if (line === "locked" || line.startsWith("locked ")) {
      locked = true;
    }
  }
  flush();
  return entries;
}

type CandidateOutcome =
  | { readonly kind: "removed" }
  | {
      readonly kind: "skipped";
      readonly reason: WorktreeSweepSkipReason;
      readonly detail?: string | undefined;
    };

const skipped = (reason: WorktreeSweepSkipReason, detail?: string): CandidateOutcome => ({
  kind: "skipped",
  reason,
  ...(detail === undefined ? {} : { detail }),
});

const countLines = (stdout: string): number => {
  const parsed = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Sweep every worktree whose threads are long settled.
 *
 * Per-candidate work is isolated: an inspection or removal that fails is
 * recorded against that worktree and the sweep moves on to the next one.
 */
export const sweepWorktrees = Effect.fn("sweepWorktrees")(function* (
  deps: WorktreeSweepDependencies,
  options?: { readonly targetThreadId?: ThreadId },
) {
  const enabled = yield* deps.isEnabled;
  if (!enabled) {
    yield* Effect.logDebug("worktree.sweep.disabled");
    return emptySummary(false);
  }

  const nowMs = yield* Clock.currentTimeMillis;
  const snapshot = yield* deps.loadSnapshot;
  const selection = selectWorktreeSweepCandidates({
    threads: snapshot.threads,
    projects: snapshot.projects,
    worktreesDir: deps.worktreesDir,
    nowMs,
    minAgeMs: deps.minAgeMs,
    ...(options?.targetThreadId === undefined ? {} : { targetThreadId: options.targetThreadId }),
  });

  const canonicalWorktreesDir = yield* deps.canonicalizePath(deps.worktreesDir);
  const worktreeListCache = new Map<string, ReadonlyArray<WorktreeListEntry>>();
  const baseRefCache = new Map<string, string | null>();
  const canonicalPathCache = new Map<string, string>();

  const canonicalize = Effect.fn("canonicalize")(function* (value: string) {
    const cached = canonicalPathCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const canonical = yield* deps.canonicalizePath(value);
    canonicalPathCache.set(value, canonical);
    return canonical;
  });

  const listWorktrees = Effect.fn("listWorktrees")(function* (workspaceRoot: string) {
    const cached = worktreeListCache.get(workspaceRoot);
    if (cached !== undefined) {
      return cached;
    }
    const result = yield* deps.runGit({
      operation: "WorktreeSweeper.listWorktrees",
      cwd: workspaceRoot,
      args: ["worktree", "list", "--porcelain"],
    });
    const entries = parseWorktreeList(result.stdout);
    worktreeListCache.set(workspaceRoot, entries);
    return entries;
  });

  /**
   * The repo's base branch. Threads do not record the branch they forked from,
   * so the repo default stands in: it only ever makes the merged check
   * stricter, never looser.
   */
  const resolveBaseRef = Effect.fn("resolveBaseRef")(function* (workspaceRoot: string) {
    const cached = baseRefCache.get(workspaceRoot);
    if (cached !== undefined) {
      return cached;
    }
    const symbolic = yield* deps.runGit({
      operation: "WorktreeSweeper.resolveBaseRef",
      cwd: workspaceRoot,
      args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      allowNonZeroExit: true,
    });
    let baseRef: string | null =
      symbolic.exitCode === 0 && symbolic.stdout.trim().length > 0 ? symbolic.stdout.trim() : null;
    if (baseRef === null) {
      for (const fallback of BASE_REF_FALLBACKS) {
        const verified = yield* deps.runGit({
          operation: "WorktreeSweeper.verifyBaseRef",
          cwd: workspaceRoot,
          args: ["rev-parse", "--verify", "--quiet", `${fallback}^{commit}`],
          allowNonZeroExit: true,
        });
        if (verified.exitCode === 0) {
          baseRef = fallback;
          break;
        }
      }
    }
    baseRefCache.set(workspaceRoot, baseRef);
    return baseRef;
  });

  const processCandidate = Effect.fn("processCandidate")(function* (
    candidate: WorktreeSweepCandidate,
  ): Effect.fn.Return<CandidateOutcome, WorktreeSweepError> {
    // Hard guard, re-checked after symlink resolution: only paths that really
    // live under the worktrees directory are ever handed to git.
    const worktreePath = yield* canonicalize(candidate.worktreePath);
    if (!isPathInsideDirectory(worktreePath, canonicalWorktreesDir)) {
      return skipped("outside-worktrees-dir", worktreePath);
    }
    const workspaceRoot = yield* canonicalize(candidate.workspaceRoot);
    if (normalizePathForComparison(worktreePath) === normalizePathForComparison(workspaceRoot)) {
      return skipped("workspace-root");
    }

    if (!(yield* deps.directoryExists(worktreePath))) {
      return skipped("worktree-missing");
    }

    const entries = yield* listWorktrees(candidate.workspaceRoot);
    let registered: WorktreeListEntry | undefined;
    for (const entry of entries) {
      const entryPath = yield* canonicalize(entry.path);
      if (normalizePathForComparison(entryPath) === normalizePathForComparison(worktreePath)) {
        registered = entry;
        break;
      }
    }
    if (!registered) {
      return skipped("worktree-not-registered");
    }
    if (registered.isMain) {
      return skipped("workspace-root");
    }
    if (registered.locked) {
      return skipped("worktree-locked");
    }

    const [status, head, baseRef, upstream] = yield* Effect.all([
      deps.runGit({
        operation: "WorktreeSweeper.status",
        cwd: worktreePath,
        args: ["status", "--porcelain"],
      }),
      deps.runGit({
        operation: "WorktreeSweeper.head",
        cwd: worktreePath,
        args: ["rev-parse", "HEAD"],
      }),
      resolveBaseRef(candidate.workspaceRoot),
      deps.runGit({
        operation: "WorktreeSweeper.upstream",
        cwd: worktreePath,
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        allowNonZeroExit: true,
      }),
    ]);

    const headSha = head.stdout.trim();
    const upstreamRef =
      upstream.exitCode === 0 && upstream.stdout.trim().length > 0 ? upstream.stdout.trim() : null;

    const merged =
      baseRef !== null &&
      headSha.length > 0 &&
      (yield* deps.runGit({
        operation: "WorktreeSweeper.isAncestor",
        cwd: worktreePath,
        args: ["merge-base", "--is-ancestor", headSha, baseRef],
        allowNonZeroExit: true,
      })).exitCode === 0;

    if (status.stdout.trim().length > 0) {
      return skipped("uncommitted-changes");
    }

    if (!merged) {
      // Nothing to compare against means we cannot prove the commits exist
      // anywhere else, so the checkout stays.
      const compareRef = upstreamRef ?? baseRef;
      if (compareRef === null) {
        return skipped("unpushed-commits", "no upstream or base branch to compare against");
      }
      const ahead = yield* deps.runGit({
        operation: "WorktreeSweeper.aheadCount",
        cwd: worktreePath,
        args: ["rev-list", "--count", `${compareRef}..HEAD`],
        allowNonZeroExit: true,
      });
      if (ahead.exitCode !== 0) {
        return skipped("unpushed-commits", `could not count commits against ${compareRef}`);
      }
      if (countLines(ahead.stdout) > 0) {
        return skipped("unpushed-commits", `ahead of ${compareRef}`);
      }
    }

    // Never forced: git's own refusal on a dirty or busy worktree is the last
    // safety net under everything above.
    yield* deps.removeWorktree({ cwd: candidate.workspaceRoot, path: worktreePath });

    for (const threadId of candidate.threadIds) {
      yield* deps.clearThreadWorktreePath(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree.sweep.thread-update-failed", {
            threadId,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    return { kind: "removed" };
  });

  interface ProjectAccumulator {
    projectId: ProjectId | null;
    projectTitle: string | null;
    workspaceRoot: string | null;
    removed: Array<string>;
    skipped: Array<{
      worktreePath: string;
      reason: WorktreeSweepSkipReason;
      detail?: string | undefined;
    }>;
    failed: Array<{ worktreePath: string; detail: string }>;
    retainedCount: number;
  }

  const projectsById = new Map(
    snapshot.projects.map((project) => [project.projectId, project] as const),
  );
  const accumulators = new Map<string, ProjectAccumulator>();
  const accumulatorFor = (projectId: ProjectId | null) => {
    const key = projectId ?? "<unknown>";
    const existing = accumulators.get(key);
    if (existing) {
      return existing;
    }
    const project = projectId === null ? undefined : projectsById.get(projectId);
    const created: ProjectAccumulator = {
      projectId,
      projectTitle: project?.title ?? null,
      workspaceRoot: project?.workspaceRoot ?? null,
      removed: [],
      skipped: [],
      failed: [],
      retainedCount: 0,
    };
    accumulators.set(key, created);
    return created;
  };

  for (const skip of selection.skips) {
    const accumulator = accumulatorFor(skip.projectId);
    if (options?.targetThreadId === undefined && LIFECYCLE_SKIP_REASONS.has(skip.reason)) {
      accumulator.retainedCount += 1;
      continue;
    }
    accumulator.skipped.push({
      worktreePath: skip.worktreePath,
      reason: skip.reason,
      ...(skip.detail === undefined ? {} : { detail: skip.detail }),
    });
  }

  for (const candidate of selection.candidates) {
    const accumulator = accumulatorFor(candidate.projectId);
    const outcome = yield* processCandidate(candidate).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          kind: "failed" as const,
          detail: Cause.pretty(cause),
        }),
      ),
    );
    if (outcome.kind === "removed") {
      accumulator.removed.push(candidate.worktreePath);
      continue;
    }
    if (outcome.kind === "failed") {
      accumulator.failed.push({ worktreePath: candidate.worktreePath, detail: outcome.detail });
      continue;
    }
    accumulator.skipped.push({
      worktreePath: candidate.worktreePath,
      reason: outcome.reason,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
  }

  const projects: ReadonlyArray<WorktreeSweepProjectSummary> = Array.from(
    accumulators.values(),
  ).map((accumulator) => ({
    projectId: accumulator.projectId,
    projectTitle: accumulator.projectTitle,
    workspaceRoot: accumulator.workspaceRoot,
    removed: accumulator.removed,
    skipped: accumulator.skipped,
    failed: accumulator.failed,
    retainedCount: accumulator.retainedCount,
  }));

  const summary: WorktreeSweepSummary = {
    enabled: true,
    worktreeCount: selection.candidates.length + selection.skips.length,
    removedCount: projects.reduce((total, project) => total + project.removed.length, 0),
    skippedCount: projects.reduce((total, project) => total + project.skipped.length, 0),
    failedCount: projects.reduce((total, project) => total + project.failed.length, 0),
    retainedCount: projects.reduce((total, project) => total + project.retainedCount, 0),
    projects,
  };

  for (const project of projects) {
    if (
      project.removed.length === 0 &&
      project.skipped.length === 0 &&
      project.failed.length === 0
    ) {
      continue;
    }
    yield* Effect.logInfo("worktree.sweep.project", {
      projectId: project.projectId,
      projectTitle: project.projectTitle,
      workspaceRoot: project.workspaceRoot,
      removed: project.removed,
      skipped: project.skipped,
      failed: project.failed,
      retainedCount: project.retainedCount,
    });
  }

  yield* Effect.logDebug("worktree.sweep.complete", {
    worktreeCount: summary.worktreeCount,
    removedCount: summary.removedCount,
    skippedCount: summary.skippedCount,
    failedCount: summary.failedCount,
    retainedCount: summary.retainedCount,
  });

  return summary;
});

// ── Service ──────────────────────────────────────────────────────────

export interface WorktreeSweeperShape {
  /** Run one sweep now. Never fails: every outcome lands in the summary. */
  readonly sweepOnce: Effect.Effect<WorktreeSweepSummary>;
  /** Start merge-triggered cleanup and the delayed periodic sweep in the given scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorktreeSweeper extends Context.Service<WorktreeSweeper, WorktreeSweeperShape>()(
  "t3/vcs/WorktreeSweeper",
) {}

export interface WorktreeSweeperLiveOptions {
  readonly minAgeMs?: number;
  readonly intervalMs?: number;
  readonly startupDelayMs?: number;
}

export function resolveWorktreeSweepSchedule(
  settings: Pick<ServerSettings, "worktreeSweepMinAge" | "worktreeSweepInterval">,
  options?: WorktreeSweeperLiveOptions,
): { readonly minAgeMs: number; readonly intervalMs: number; readonly startupDelayMs: number } {
  return {
    minAgeMs: Math.max(0, options?.minAgeMs ?? Duration.toMillis(settings.worktreeSweepMinAge)),
    intervalMs: Math.max(
      1,
      options?.intervalMs ?? Duration.toMillis(settings.worktreeSweepInterval),
    ),
    startupDelayMs: Math.max(
      0,
      options?.startupDelayMs ?? Duration.toMillis(WORKTREE_SWEEP_STARTUP_DELAY),
    ),
  };
}

const isSettledOverride = (value: unknown): value is "settled" | "active" =>
  value === "settled" || value === "active";

const makeWorktreeSweeper = (options?: WorktreeSweeperLiveOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const gitWorkflow = yield* GitWorkflowService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const serverSettings = yield* ServerSettingsService;
    const crypto = yield* Crypto.Crypto;

    const startupSettings = yield* serverSettings.getSettings;
    const { minAgeMs, intervalMs, startupDelayMs } = resolveWorktreeSweepSchedule(
      startupSettings,
      options,
    );

    const deps: WorktreeSweepDependencies = {
      worktreesDir: config.worktreesDir,
      minAgeMs,
      isEnabled: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.enableWorktreeCleanup),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree.sweep.settings-unavailable", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      ),
      loadSnapshot: Effect.all([
        projectionSnapshotQuery.getShellSnapshot(),
        projectionSnapshotQuery.getArchivedShellSnapshot(),
        projectionSnapshotQuery.getCommandReadModel(),
      ]).pipe(
        Effect.mapError(sweepFailure("loadSnapshot")),
        Effect.map(([active, archived, commandReadModel]) => {
          // Shell snapshots intentionally omit deleted rows. The command read
          // model is still lightweight, includes them, and lets the sweeper
          // reclaim checkouts whose thread or whole project was deleted.
          const deletedThreads = commandReadModel.threads.filter(
            (thread) => thread.deletedAt !== null,
          );
          const deletedProjects = commandReadModel.projects.filter(
            (project) => project.deletedAt !== null,
          );
          const shellThreads: ReadonlyArray<WorktreeSweepThread> = [
            ...active.threads,
            ...archived.threads,
          ].map((thread) => ({
            threadId: thread.id,
            projectId: thread.projectId,
            worktreePath: thread.worktreePath,
            settledAt: thread.settledAt,
            archivedAt: thread.archivedAt,
            deletedAt: null,
            settledOverride: isSettledOverride(thread.settledOverride)
              ? thread.settledOverride
              : null,
            pinnedAt: thread.pinnedAt ?? null,
            hasLiveWork:
              thread.session?.activeTurnId != null ||
              thread.latestTurn?.state === "running" ||
              thread.backgroundLiveness != null,
          }));
          const deletedSweepThreads: ReadonlyArray<WorktreeSweepThread> = deletedThreads.map(
            (thread) => ({
              threadId: thread.id,
              projectId: thread.projectId,
              worktreePath: thread.worktreePath,
              settledAt: thread.settledAt,
              archivedAt: thread.archivedAt,
              deletedAt: thread.deletedAt,
              settledOverride: isSettledOverride(thread.settledOverride)
                ? thread.settledOverride
                : null,
              pinnedAt: thread.pinnedAt ?? null,
              hasLiveWork:
                thread.session?.activeTurnId != null || thread.latestTurn?.state === "running",
            }),
          );
          const threadsById = new Map(
            [...shellThreads, ...deletedSweepThreads].map((thread) => [thread.threadId, thread]),
          );
          const projectsById = new Map(
            [...active.projects, ...archived.projects, ...deletedProjects].map((project) => [
              project.id,
              project,
            ]),
          );
          return {
            projects: Array.from(projectsById.values(), (project) => ({
              projectId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
            })),
            threads: Array.from(threadsById.values(), (thread) => ({
              threadId: thread.threadId,
              projectId: thread.projectId,
              worktreePath: thread.worktreePath,
              settledAt: thread.settledAt,
              archivedAt: thread.archivedAt,
              deletedAt: thread.deletedAt,
              settledOverride: thread.settledOverride,
              pinnedAt: thread.pinnedAt ?? null,
              hasLiveWork: thread.hasLiveWork,
            })),
          };
        }),
      ),
      canonicalizePath: (value) => {
        const resolved = path.resolve(value);
        return fileSystem
          .realPath(resolved)
          .pipe(Effect.catchCause(() => Effect.succeed(resolved)));
      },
      directoryExists: (value) =>
        fileSystem.exists(value).pipe(Effect.catchCause(() => Effect.succeed(false))),
      runGit: (input) =>
        git
          .execute({
            operation: input.operation,
            cwd: input.cwd,
            args: input.args,
            timeoutMs: 30_000,
            ...(input.allowNonZeroExit === undefined
              ? {}
              : { allowNonZeroExit: input.allowNonZeroExit }),
          })
          .pipe(Effect.mapError(sweepFailure(input.operation))),
      removeWorktree: (input) =>
        gitWorkflow
          .removeWorktree({ cwd: input.cwd, path: input.path })
          .pipe(Effect.mapError(sweepFailure("removeWorktree"))),
      clearThreadWorktreePath: (threadId) =>
        crypto.randomUUIDv4.pipe(
          Effect.flatMap((uuid) =>
            orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(`server:worktree-sweep:${uuid}`),
              threadId,
              worktreePath: null,
            }),
          ),
          Effect.mapError(sweepFailure("clearThreadWorktreePath")),
          Effect.asVoid,
        ),
    };

    const sweepOnce = sweepWorktrees(deps).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree.sweep.failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(emptySummary(true)),
        ),
      ),
    );

    const removeAfterMerge = Effect.fn("WorktreeSweeper.removeAfterMerge")(function* (
      threadId: ThreadId,
    ) {
      yield* sweepWorktrees(deps, { targetThreadId: threadId });
    });

    const processEvent = (event: OrchestrationEvent) => {
      if (event.type !== "issue.review-recorded" || event.payload.verdict !== "merged") {
        return Effect.void;
      }
      return projectionSnapshotQuery.getIssueSummaryById(event.payload.issueId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (issue) =>
              issue.status === "done" && issue.threadId !== null
                ? removeAfterMerge(issue.threadId)
                : Effect.void,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree.sweep.after-merge-failed", {
            issueId: event.payload.issueId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const start: WorktreeSweeperShape["start"] = () =>
      Effect.gen(function* () {
        // This subscriber is independent of the autonomous merge queue. A slow
        // git removal can only hold up cleanup's own event reader.
        yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));
        yield* forkParked(
          Effect.sleep(Duration.millis(startupDelayMs)).pipe(
            Effect.andThen(
              sweepOnce.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
            ),
            Effect.asVoid,
          ),
        );
        yield* Effect.logDebug("worktree.sweep.scheduled", {
          minAgeMs,
          intervalMs,
          startupDelayMs,
        });
      });

    return { sweepOnce, start } satisfies WorktreeSweeperShape;
  });

export const makeWorktreeSweeperLive = (options?: WorktreeSweeperLiveOptions) =>
  Layer.effect(WorktreeSweeper, makeWorktreeSweeper(options));

export const WorktreeSweeperLive = makeWorktreeSweeperLive();
