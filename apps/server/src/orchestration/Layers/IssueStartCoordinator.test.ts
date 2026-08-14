import {
  CommandId,
  GitCommandError,
  IssueId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationIssueDetail,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  IssueStartCoordinator,
  type IssueStartCommand,
} from "../Services/IssueStartCoordinator.ts";
import { IssueStartCoordinatorLive } from "./IssueStartCoordinator.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const ISSUE_ID = IssueId.make("issue-1");
const THREAD_ID = ThreadId.make("thread-1");
const WORKSPACE_ROOT = "/tmp/acme";
const WORKTREE_PATH = "/tmp/acme-worktrees/issue-1";
const ISSUE_BRANCH = `issue/${ISSUE_ID}`;
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

const START_COMMAND: IssueStartCommand = {
  type: "issue.start",
  commandId: CommandId.make("cmd-issue-start"),
  issueId: ISSUE_ID,
  threadId: THREAD_ID,
  messageId: MessageId.make("message-1"),
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: NOW,
};

const ISSUE_DETAIL: OrchestrationIssueDetail = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  title: "Teach the coordinator to retry",
  status: "backlog",
  priority: null,
  modelSelection: null,
  dependsOn: [],
  threadId: null,
  pullRequestUrl: null,
  needsAttentionAt: null,
  needsAttentionReason: null,
  reviewVerdict: null,
  reviewerThreadId: null,
  reviewedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  description: "The body of the issue.",
  reviewNotes: "",
};

const PROJECT_SHELL: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Acme",
  workspaceRoot: WORKSPACE_ROOT,
  repositoryIdentity: null,
  defaultModelSelection: MODEL,
  defaultThreadEnvMode: null,
  faviconPath: null,
  scripts: [],
  autonomousStartedAt: null,
  autonomousFinishedAt: null,
  autonomousFinishedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const worktreeLockError = () =>
  new GitCommandError({
    operation: "GitWorkflowService.createWorktree",
    command: "git worktree add",
    cwd: WORKSPACE_ROOT,
    detail: "fatal: Unable to create '.git/index.lock': File exists.",
  });

interface HarnessOptions {
  /** How many `createWorktree` calls fail before one succeeds. */
  readonly worktreeFailures?: number;
  /** Command types the engine rejects the way the decider would. */
  readonly rejectDispatch?: ReadonlyArray<OrchestrationCommand["type"]>;
  /** Absent issue: the coordinator gives up before touching git. */
  readonly issueMissing?: boolean;
}

/**
 * The coordinator with everything it talks to stubbed. The engine is a
 * recorder rather than the real one: what these tests are about is which
 * commands the coordinator emits, and how often, when git misbehaves.
 */
function makeHarness(options?: HarnessOptions) {
  const worktreeFailures = options?.worktreeFailures ?? 0;
  const rejectDispatch = new Set(options?.rejectDispatch ?? []);
  const dispatched: OrchestrationCommand[] = [];
  const gitCalls: string[] = [];
  let worktreeAttempts = 0;
  let sequence = 0;

  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        dispatched.push(command);
        if (rejectDispatch.has(command.type)) {
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: `Command '${command.type}' was rejected.`,
            }),
          );
        }
        sequence += 1;
        return Effect.succeed({ sequence });
      }),
  } as never);

  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getIssueDetailById: () =>
      Effect.succeed(options?.issueMissing === true ? Option.none() : Option.some(ISSUE_DETAIL)),
    getProjectShellById: () => Effect.succeed(Option.some(PROJECT_SHELL)),
    getProjectLinksById: () => Effect.succeed([]),
    listIssuesByProjectId: () => Effect.succeed([ISSUE_DETAIL]),
  } as never);

  const gitLayer = Layer.mock(GitWorkflowService)({
    localStatus: () =>
      Effect.sync(() => {
        gitCalls.push("localStatus");
        return {
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: true,
          refName: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        };
      }),
    remoteExists: () =>
      Effect.sync(() => {
        gitCalls.push("remoteExists");
        return false;
      }),
    listRefs: () =>
      Effect.sync(() => {
        gitCalls.push("listRefs");
        return {
          refs: [],
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }),
    createWorktree: () =>
      Effect.suspend(() => {
        gitCalls.push("createWorktree");
        worktreeAttempts += 1;
        return worktreeAttempts <= worktreeFailures
          ? Effect.fail(worktreeLockError())
          : Effect.succeed({ worktree: { path: WORKTREE_PATH, refName: ISSUE_BRANCH } });
      }),
  } as never);

  const setupScriptLayer = Layer.mock(ProjectSetupScriptRunner)({
    runForThread: () => Effect.void,
  } as never);

  const vcsStatusLayer = Layer.mock(VcsStatusBroadcaster)({
    refreshStatus: () => Effect.void,
  } as never);

  const layer = IssueStartCoordinatorLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(projectionLayer),
    Layer.provide(gitLayer),
    Layer.provide(setupScriptLayer),
    Layer.provide(vcsStatusLayer),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    dispatched,
    gitCalls,
    dispatchedTypes: () => dispatched.map((command) => command.type),
    countDispatched: (type: OrchestrationCommand["type"]) =>
      dispatched.filter((command) => command.type === type).length,
    worktreeAttempts: () => worktreeAttempts,
  };
}

/** The detail the compensating `issue.start.failed` carried, if it ran. */
function startFailedDetail(dispatched: ReadonlyArray<OrchestrationCommand>): string | null {
  const command = dispatched.find((entry) => entry.type === "issue.start.failed");
  return command?.type === "issue.start.failed" ? command.detail : null;
}

describe("IssueStartCoordinator", () => {
  it.effect("starts the issue when worktree creation succeeds on a later attempt", () => {
    const harness = makeHarness({ worktreeFailures: 2 });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      const fiber = yield* Effect.forkChild(coordinator.startIssue(START_COMMAND));

      // The first attempt runs straight away; the next two wait out the
      // backoff, so nothing else happens until the clock moves.
      yield* TestClock.adjust(Duration.zero);
      expect(harness.worktreeAttempts()).toBe(1);
      yield* TestClock.adjust(Duration.seconds(2));
      expect(harness.worktreeAttempts()).toBe(2);
      yield* TestClock.adjust(Duration.seconds(5));

      const result = yield* Fiber.join(fiber);
      expect(result.sequence).toBeGreaterThan(0);
      expect(harness.worktreeAttempts()).toBe(3);

      // A transient stumble is invisible to the issue: it started normally,
      // with no compensation and no second thread.
      expect(harness.dispatchedTypes()).toEqual([
        "issue.start",
        "thread.create",
        "thread.meta.update",
        "thread.turn.start",
      ]);
      expect(harness.countDispatched("thread.create")).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("waits out the backoff between attempts", () => {
    const harness = makeHarness({ worktreeFailures: 1 });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      const fiber = yield* Effect.forkChild(coordinator.startIssue(START_COMMAND));

      yield* TestClock.adjust(Duration.zero);
      expect(harness.worktreeAttempts()).toBe(1);
      // Just short of the first delay: still the same single attempt.
      yield* TestClock.adjust(Duration.millis(1_999));
      expect(harness.worktreeAttempts()).toBe(1);

      yield* TestClock.adjust(Duration.millis(1));
      yield* Fiber.join(fiber);
      expect(harness.worktreeAttempts()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("compensates once the attempts are exhausted, naming how many there were", () => {
    const harness = makeHarness({ worktreeFailures: Number.MAX_SAFE_INTEGER });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      const fiber = yield* Effect.forkChild(coordinator.startIssue(START_COMMAND));

      yield* TestClock.adjust(Duration.zero);
      yield* TestClock.adjust(Duration.seconds(2));
      expect(harness.worktreeAttempts()).toBe(2);
      // The second backoff is the longer one.
      yield* TestClock.adjust(Duration.millis(4_999));
      expect(harness.worktreeAttempts()).toBe(2);
      yield* TestClock.adjust(Duration.millis(1));

      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(harness.worktreeAttempts()).toBe(3);
      expect(error.message).toContain("3 attempts");

      // The existing compensation, unchanged: the half-built thread goes away
      // and the issue is rewound to where it started.
      expect(harness.dispatchedTypes()).toEqual([
        "issue.start",
        "thread.create",
        "thread.delete",
        "issue.start.failed",
      ]);
      expect(harness.countDispatched("thread.create")).toBe(1);
      expect(startFailedDetail(harness.dispatched)).toContain("3 attempts");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not retry a start the engine rejected", () => {
    const harness = makeHarness({ rejectDispatch: ["issue.start"] });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      const error = yield* Effect.flip(coordinator.startIssue(START_COMMAND));

      expect(error.message).toContain("rejected");
      // A decider rejection (blocked dependency, already started, flagged) is
      // deterministic: no git work, no thread, and nothing to compensate.
      expect(harness.gitCalls).toEqual([]);
      expect(harness.dispatchedTypes()).toEqual(["issue.start"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not retry a rejected thread.create", () => {
    const harness = makeHarness({ rejectDispatch: ["thread.create"] });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      yield* Effect.flip(coordinator.startIssue(START_COMMAND));

      // Retrying the bootstrap wholesale would dispatch `thread.create` again
      // for a threadId the engine has already seen.
      expect(harness.countDispatched("thread.create")).toBe(1);
      expect(harness.gitCalls).toEqual([]);
      expect(harness.dispatchedTypes()).toEqual([
        "issue.start",
        "thread.create",
        "thread.delete",
        "issue.start.failed",
      ]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not retry an issue that does not exist", () => {
    const harness = makeHarness({ issueMissing: true });
    return Effect.gen(function* () {
      const coordinator = yield* IssueStartCoordinator;
      const error = yield* Effect.flip(coordinator.startIssue(START_COMMAND));

      expect(error.message).toContain("does not exist");
      expect(harness.gitCalls).toEqual([]);
      expect(harness.dispatchedTypes()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
