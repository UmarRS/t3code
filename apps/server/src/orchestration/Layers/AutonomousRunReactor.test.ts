import {
  CommandId,
  GitCommandError,
  IssueId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueReviewComplexityTier,
  type ModelSelection,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import {
  IssueStartCoordinator,
  type IssueReviewResumeInput,
  type IssueReviewStartInput,
  type IssueStartCommand,
  type IssueStartOptions,
} from "../Services/IssueStartCoordinator.ts";
import { AutonomousRunReactor } from "../Services/AutonomousRunReactor.ts";
import {
  ReviewComplexityClassifier,
  type ReviewComplexityInput,
} from "../Services/ReviewComplexityClassifier.ts";
import { AutonomousRunReactorLive } from "./AutonomousRunReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
/** The linked board a plan that spans repositories files its other half on. */
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

interface StartedIssue {
  readonly command: IssueStartCommand;
  readonly options: IssueStartOptions | undefined;
}

const CLAUDE_MODELS = [
  { slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false },
  { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false },
];

const makeProviderSnapshots = (models: ReadonlyArray<{ slug: string }> = CLAUDE_MODELS) => [
  {
    instanceId: ProviderInstanceId.make("claude"),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models,
    slashCommands: [],
    skills: [],
  },
];

/**
 * A run harness with a real engine, real projections, and the real reactor.
 * Only the two things that touch the outside world are stubbed: the start
 * coordinator (whose worktree/thread composite has its own tests) and git. The
 * coordinator stub still dispatches the same `issue.start` the real one does,
 * so the projected state the reactor reads back is genuine.
 */
function makeHarness(options?: {
  readonly pullRequestFails?: boolean;
  /**
   * What the shippable-work pre-check answers: work to ship (the default),
   * nothing to ship, or a git failure the reactor has to survive.
   */
  readonly shippableWork?: boolean | "fails";
  /** The tier the stubbed classifier answers with. Defaults to the safe tier. */
  readonly reviewTier?: IssueReviewComplexityTier;
  readonly providers?: ReadonlyArray<unknown>;
  /** Existing provider PR state for the worker branch, when one already exists. */
  readonly existingPullRequestState?: "open" | "closed" | "merged";
  /** Install a `TestClock` so a scenario can drive a retry backoff forward. */
  readonly testClock?: boolean;
}) {
  const started: StartedIssue[] = [];
  const reviews: IssueReviewStartInput[] = [];
  const resumedReviews: IssueReviewResumeInput[] = [];
  const stackedActions: Array<{ readonly cwd: string; readonly action: string }> = [];
  const shippableChecks: Array<{ readonly cwd: string; readonly baseBranch: string }> = [];
  const resolvedPullRequests: Array<{ readonly cwd: string; readonly reference: string }> = [];
  const classified: ReviewComplexityInput[] = [];
  let pullRequestFails = options?.pullRequestFails ?? false;
  let pullRequestState: "open" | "merged" = "open";
  const shippableWork = options?.shippableWork ?? true;

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );

  const coordinatorLayer = Layer.effect(
    IssueStartCoordinator,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      let reviewThreadSeq = 0;
      return {
        startIssue: (command: IssueStartCommand, startOptions?: IssueStartOptions) =>
          Effect.gen(function* () {
            started.push({ command, options: startOptions });
            return yield* engine.dispatch(command).pipe(Effect.orDie);
          }),
        // Creates the reviewer thread the real coordinator creates: a retry
        // resumes that thread, so a stub that never made one would silently
        // test the fresh-review path instead.
        startIssueReview: (input: IssueReviewStartInput) =>
          Effect.gen(function* () {
            reviews.push(input);
            const issue = yield* snapshotQuery
              .getIssueSummaryById(input.issueId)
              .pipe(Effect.orDie);
            reviewThreadSeq += 1;
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(`cmd-review-thread-${reviewThreadSeq}`),
                threadId: input.threadId,
                projectId: Option.getOrThrow(issue).projectId,
                title: "Reviewer",
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: input.branch,
                worktreePath: input.worktreePath,
                createdAt: input.createdAt,
              })
              .pipe(Effect.orDie);
            return { sequence: 0 };
          }),
        resumeIssueReview: (input: IssueReviewResumeInput) =>
          Effect.sync(() => {
            resumedReviews.push(input);
            return { sequence: 0 };
          }),
      };
    }),
  ).pipe(Layer.provide(orchestrationLayer), Layer.provide(projectionSnapshotLayer));

  const gitLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    invalidateStatus: () => Effect.void,
    remoteStatus: () =>
      Effect.succeed({
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr:
          options?.existingPullRequestState === undefined
            ? null
            : {
                number: 9,
                title: "Existing issue PR",
                url: "https://example.test/pr/9",
                baseRef: "main",
                headRef: "issue/issue-a",
                state: options.existingPullRequestState,
              },
      }),
    hasShippableWork: (input: { readonly cwd: string; readonly baseBranch: string }) =>
      Effect.suspend(() => {
        shippableChecks.push(input);
        return shippableWork === "fails"
          ? Effect.fail(
              new GitCommandError({
                operation: "GitWorkflowService.hasShippableWork",
                command: "rev-list",
                cwd: input.cwd,
                detail: "the probe itself broke",
              }),
            )
          : Effect.succeed(shippableWork);
      }),
    runStackedAction: (input: { readonly cwd: string; readonly action: string }) =>
      Effect.sync(() => {
        stackedActions.push({ cwd: input.cwd, action: input.action });
        return {
          action: input.action,
          branch: { status: "skipped_not_requested" as const },
          commit: { status: "created" as const },
          push: { status: "pushed" as const },
          pr: pullRequestFails
            ? { status: "skipped_not_requested" as const }
            : { status: "created" as const, url: "https://example.test/pr/1" },
          toast: { title: "done", cta: { kind: "none" as const } },
        };
      }),
    resolvePullRequest: (input: { readonly cwd: string; readonly reference: string }) =>
      Effect.sync(() => {
        resolvedPullRequests.push(input);
        return {
          pullRequest: {
            number: 1,
            title: "Issue issue-a",
            url: "https://example.test/pr/1",
            baseBranch: "main",
            headBranch: "issue/issue-a",
            state: pullRequestState,
          },
        };
      }),
  } as never);

  // The classifier's own failure modes (timeouts, garbled output) resolve to
  // "complex" inside its layer, which has its own tests; here it is a plain
  // stub so scenarios can pick the tier under test.
  const classifierLayer = Layer.succeed(ReviewComplexityClassifier, {
    classify: (input: ReviewComplexityInput) =>
      Effect.sync(() => {
        classified.push(input);
        return options?.reviewTier ?? "complex";
      }),
  });

  const reactorLayer = AutonomousRunReactorLive.pipe(
    Layer.provide(classifierLayer),
    Layer.provideMerge(coordinatorLayer),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(
      makeProviderRegistryLayer((options?.providers ?? makeProviderSnapshots()) as never),
    ),
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  // Retry backoffs are minutes long. Scenarios that wait one out drive the
  // clock instead, so the wait is named rather than slept through.
  const layer =
    options?.testClock === true
      ? Layer.provideMerge(reactorLayer, TestClock.layer())
      : reactorLayer;

  return {
    layer,
    started,
    reviews,
    resumedReviews,
    stackedActions,
    shippableChecks,
    resolvedPullRequests,
    classified,
    allowPullRequests: () => {
      pullRequestFails = false;
    },
    markPullRequestMerged: () => {
      pullRequestState = "merged";
    },
  };
}

/** Everything a scenario needs, with the reactor already subscribed. */
const bootRun = Effect.fn("bootRun")(function* () {
  const engine = yield* OrchestrationEngineService;
  const reactor = yield* AutonomousRunReactor;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;
  // `start` forks the subscription and returns; anything dispatched before
  // the subscription goes live is covered by the reactor's state-derived
  // sweep at stream start.
  yield* reactor.start();

  let commandSeq = 0;
  const nextCommandId = (tag: string) => {
    commandSeq += 1;
    return CommandId.make(`cmd-${tag}-${commandSeq}`);
  };

  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.orDie);

  const createProject = () =>
    dispatch({
      type: "project.create",
      commandId: nextCommandId("project"),
      projectId: PROJECT_ID,
      title: "Acme",
      workspaceRoot: "/tmp/acme",
      defaultModelSelection: MODEL,
      createdAt: NOW,
    });

  const createIssueIn = (projectId: ProjectId, id: string, dependsOn: ReadonlyArray<string> = []) =>
    dispatch({
      type: "issue.create",
      commandId: nextCommandId(`issue-${id}`),
      issueId: IssueId.make(id),
      projectId,
      title: `Issue ${id}`,
      description: `Body of ${id}`,
      dependsOn: dependsOn.map((entry) => IssueId.make(entry)),
      createdAt: NOW,
    });

  const createIssue = (id: string, dependsOn: ReadonlyArray<string> = []) =>
    createIssueIn(PROJECT_ID, id, dependsOn);

  /** A second board, for the plans whose stories do not all live in one repository. */
  const createOtherProject = () =>
    dispatch({
      type: "project.create",
      commandId: nextCommandId("other-project"),
      projectId: OTHER_PROJECT_ID,
      title: "Acme Web",
      workspaceRoot: "/tmp/acme-web",
      defaultModelSelection: MODEL,
      createdAt: NOW,
    });

  const setIssueStatus = (id: string, status: "backlog" | "done") =>
    dispatch({
      type: "issue.status.set",
      commandId: nextCommandId(`status-${id}`),
      issueId: IssueId.make(id),
      status,
    });

  /**
   * An issue filed by cross-project delegation. Its project has no run of its
   * own; the mark is what tells the reactor to work it anyway.
   */
  const createDelegatedIssue = (id: string, delegatedFrom?: ThreadId) =>
    dispatch({
      type: "issue.create",
      commandId: nextCommandId(`delegated-${id}`),
      issueId: IssueId.make(id),
      projectId: PROJECT_ID,
      title: `Issue ${id}`,
      description: `Body of ${id}`,
      dependsOn: [],
      delegatedFromThreadId: delegatedFrom ?? ThreadId.make("thread-delegating-parent"),
      createdAt: NOW,
    });

  /**
   * What the linked-project coordinator does synchronously when it delegates:
   * claim the issue with a thread of its own. The reactor never starts these
   * itself, so a scenario has to.
   */
  const startIssueDirectly = (id: string, threadId: ThreadId) =>
    dispatch({
      type: "issue.start",
      commandId: nextCommandId(`start-${id}`),
      issueId: IssueId.make(id),
      threadId,
      messageId: MessageId.make(`message-${id}`),
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    });

  const enableAutonomousFor = (
    projectId: ProjectId,
    additionalProjectIds: ReadonlyArray<ProjectId> = [],
  ) =>
    dispatch({
      type: "project.autonomous.enable",
      commandId: nextCommandId("enable"),
      projectId,
      additionalProjectIds,
      createdAt: NOW,
    });

  const enableAutonomous = () => enableAutonomousFor(PROJECT_ID);

  const createWorkerThread = (threadId: ThreadId, worktreePath: string, branch: string | null) =>
    dispatch({
      type: "thread.create",
      commandId: nextCommandId("worker-thread"),
      threadId,
      projectId: PROJECT_ID,
      title: "Worker",
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath,
      createdAt: NOW,
    });

  const endTurn = (
    threadId: ThreadId,
    status: "idle" | "error",
    options?: { readonly resumeAt?: string; readonly lastError?: string },
  ) =>
    dispatch({
      type: "thread.session.set",
      commandId: nextCommandId("session"),
      threadId,
      session: {
        threadId,
        status,
        providerName: "claude",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: options?.lastError ?? (status === "error" ? "API Error: 529 Overloaded" : null),
        resumeAt: options?.resumeAt ?? null,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });

  /**
   * Collect the next `count` receipts while `body` runs. Forked first so the
   * subscription exists before the work that publishes them — the alternative
   * would be a sleep, which is what receipts exist to avoid.
   */
  const collectReceiptsWhile = <A, E, R>(count: number, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const collector = yield* Effect.forkChild(
        Stream.take(receipts.streamEventsForTest, count).pipe(Stream.runCollect),
      );
      yield* body;
      return Array.from(yield* Fiber.join(collector));
    });

  const receiptsWhile = <A, E, R>(count: number, body: Effect.Effect<A, E, R>) =>
    collectReceiptsWhile(count, body).pipe(
      Effect.map((collected) => collected.map((receipt) => receipt.type)),
    );

  const findIssue = (id: string) =>
    snapshotQuery
      .listIssuesByProjectId(PROJECT_ID)
      .pipe(Effect.map((issues) => issues.find((entry) => entry.id === IssueId.make(id))));

  return {
    reactor,
    snapshotQuery,
    dispatch,
    nextCommandId,
    createProject,
    createOtherProject,
    createIssue,
    createIssueIn,
    setIssueStatus,
    createDelegatedIssue,
    startIssueDirectly,
    enableAutonomous,
    enableAutonomousFor,
    createWorkerThread,
    endTurn,
    receiptsWhile,
    collectReceiptsWhile,
    findIssue,
  };
});

describe("AutonomousRunReactor", () => {
  it.effect("starts every startable issue in parallel and names each one's siblings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.createIssue("issue-b");
      // Blocked: its dependency is still in the backlog.
      yield* run.createIssue("issue-c", ["issue-a"]);
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      expect(harness.started.map((entry) => entry.command.issueId).toSorted()).toEqual([
        IssueId.make("issue-a"),
        IssueId.make("issue-b"),
      ]);
      const a = harness.started.find((entry) => entry.command.issueId === IssueId.make("issue-a"));
      expect(a?.options?.parallelTitles).toEqual(["Issue issue-b"]);
      // Autonomous work is forced into a mode that cannot stop to ask a human.
      expect(a?.command.runtimeMode).toBe("full-access");
      expect(a?.command.interactionMode).toBe("default");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  // A plan that spans two repositories: the frontend story waits on the
  // backend story, and the two are tracked on different boards.
  it.effect("holds a story whose blocker is on another board, without finishing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createOtherProject();
      yield* run.createIssueIn(OTHER_PROJECT_ID, "issue-api");
      yield* run.createIssue("issue-ui", ["issue-api"]);
      yield* run.enableAutonomousFor(OTHER_PROJECT_ID);
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      // Only the blocker runs; the story waiting on it is left alone.
      expect(harness.started.map((entry) => entry.command.issueId)).toEqual([
        IssueId.make("issue-api"),
      ]);
      // And the waiting board stays switched on: turning it off here would
      // strand the story the moment its blocker landed.
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousStartedAt).not.toBeNull();
      const waiting = yield* run.findIssue("issue-ui");
      expect(waiting?.status).toBe("backlog");
      expect(waiting?.needsAttentionAt ?? null).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("starts the waiting story once the other board's blocker is done", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createOtherProject();
      yield* run.createIssueIn(OTHER_PROJECT_ID, "issue-api");
      yield* run.createIssue("issue-ui", ["issue-api"]);
      yield* run.enableAutonomousFor(OTHER_PROJECT_ID);
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      // The blocker lands. Nothing on this board changed, so only the fan-out
      // to the boards that depend on it can wake this run. Two receipts follow:
      // the blocker's own board finishes, and this one starts the story that
      // was waiting. Waiting on them rather than draining is what makes the
      // hand-off observable instead of timing-dependent.
      const seen = yield* run.collectReceiptsWhile(2, run.setIssueStatus("issue-api", "done"));
      yield* run.reactor.drain;

      expect(
        seen.some(
          (receipt) =>
            receipt.type === "autonomous.issue.started" &&
            receipt.issueId === IssueId.make("issue-ui"),
        ),
      ).toBe(true);
      expect(harness.started.map((entry) => entry.command.issueId)).toContain(
        IssueId.make("issue-ui"),
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  // The race the multi-board start exists to close: enabling the two boards as
  // two commands lets this one tick first, find its only story blocked by a
  // board that is still off, flag it and switch itself off — all before the
  // other board goes live.
  it.effect("starts the boards its plan reaches as one action, flagging nothing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createOtherProject();
      yield* run.createIssueIn(OTHER_PROJECT_ID, "issue-api");
      yield* run.createIssue("issue-ui", ["issue-api"]);
      yield* run.enableAutonomousFor(PROJECT_ID, [OTHER_PROJECT_ID]);
      yield* run.reactor.drain;

      // The blocker is worked on the board this action switched on with it.
      expect(harness.started.map((entry) => entry.command.issueId)).toEqual([
        IssueId.make("issue-api"),
      ]);
      // And the story waiting on it is waiting, not stuck: no flag, and its
      // board is still live to pick the work up when the blocker lands.
      const waiting = yield* run.findIssue("issue-ui");
      expect(waiting?.needsAttentionAt ?? null).toBeNull();
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousStartedAt).not.toBeNull();
      const other = yield* run.snapshotQuery.getProjectShellById(OTHER_PROJECT_ID);
      expect(Option.getOrThrow(other).autonomousStartedAt).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("stops every board the action started, together", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createOtherProject();
      yield* run.createIssueIn(OTHER_PROJECT_ID, "issue-api");
      yield* run.createIssue("issue-ui", ["issue-api"]);
      yield* run.enableAutonomousFor(PROJECT_ID, [OTHER_PROJECT_ID]);
      yield* run.reactor.drain;

      yield* run.dispatch({
        type: "project.autonomous.disable",
        commandId: run.nextCommandId("disable"),
        projectId: PROJECT_ID,
        additionalProjectIds: [OTHER_PROJECT_ID],
        reason: "user",
      });
      yield* run.reactor.drain;

      for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
        const project = yield* run.snapshotQuery.getProjectShellById(projectId);
        expect(Option.getOrThrow(project).autonomousStartedAt).toBeNull();
        expect(Option.getOrThrow(project).autonomousFinishedReason).toBe("disabled");
      }
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  // The dead end: nothing is running the board that owns the blocker, so no
  // amount of waiting releases the work. Say so and finish.
  it.effect("flags a story stuck behind a board nobody is running, then finishes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createOtherProject();
      yield* run.createIssueIn(OTHER_PROJECT_ID, "issue-api");
      yield* run.createIssue("issue-ui", ["issue-api"]);
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      expect(harness.started).toEqual([]);
      const stuck = yield* run.findIssue("issue-ui");
      expect(stuck?.needsAttentionAt).not.toBeNull();
      expect(stuck?.needsAttentionReason).toContain("Acme Web");
      expect(stuck?.needsAttentionKind).toBe("blocked");
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousStartedAt).toBeNull();
      expect(Option.getOrThrow(project).autonomousFinishedReason).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not start a flagged issue, and finishes a run with only flagged work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.dispatch({
        type: "issue.attention.flag",
        commandId: run.nextCommandId("flag"),
        issueId: IssueId.make("issue-a"),
        reason: "Parked by an earlier failure.",
      });
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      expect(harness.started).toEqual([]);
      // The command carried no kind, exactly as every event written before
      // kinds existed did. It stays unclassified rather than being recorded as
      // a deliberate `other`, which is what keeps the UI's reason-text
      // fallback in play for history.
      expect((yield* run.findIssue("issue-a"))?.needsAttentionKind ?? null).toBeNull();
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      const shell = Option.getOrNull(project);
      // The run turned itself off, and said it finished rather than was stopped.
      expect(shell?.autonomousStartedAt).toBeNull();
      expect(shell?.autonomousFinishedReason).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("re-evaluates when a flag is cleared, so the issue runs", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.dispatch({
        type: "issue.attention.flag",
        commandId: run.nextCommandId("flag"),
        issueId: IssueId.make("issue-a"),
        reason: "Parked.",
      });
      yield* run.enableAutonomous();
      yield* run.reactor.drain;
      expect(harness.started).toEqual([]);

      // Clearing is the way back in. The run had auto-completed, so it is
      // re-enabled the way a user would.
      yield* run.dispatch({
        type: "issue.attention.clear",
        commandId: run.nextCommandId("clear"),
        issueId: IssueId.make("issue-a"),
      });
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      expect(harness.started.map((entry) => entry.command.issueId)).toEqual([
        IssueId.make("issue-a"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not start anything while the run is off", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.reactor.drain;
      expect(harness.started).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("ignores ordinary thread completions outside an autonomous run", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      const threadId = ThreadId.make("ordinary-thread");
      yield* run.createWorkerThread(threadId, "/tmp/acme", "main");

      yield* run.endTurn(threadId, "idle");
      yield* run.reactor.drain;
      expect(harness.stackedActions).toEqual([]);
      expect(harness.reviews).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("stops starting new work once the run is disabled", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      yield* run.dispatch({
        type: "project.autonomous.disable",
        commandId: run.nextCommandId("disable"),
        projectId: PROJECT_ID,
        reason: "user",
      });
      yield* run.createIssue("issue-a");
      yield* run.reactor.drain;

      expect(harness.started).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  // Idempotence: the loop reads current state, so a replayed evaluation cannot
  // start an issue that already has a thread.
  it.effect("does not start an issue twice when the run is re-evaluated", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      expect(harness.started).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("opens a pull request when a worker turn ends, then queues the review", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
      expect(seen).toContain("autonomous.pull-request.opened");
      expect(seen).toContain("autonomous.review.started");

      // The PR ran through the same stacked action the button uses, in the
      // thread's own worktree.
      expect(harness.stackedActions).toEqual([
        { cwd: "/tmp/acme-worktrees/issue-a", action: "commit_push_pr" },
      ]);
      // The reviewer runs in that worktree, on Opus, in the forced mode.
      expect(harness.reviews).toHaveLength(1);
      expect(harness.reviews[0]?.worktreePath).toBe("/tmp/acme-worktrees/issue-a");
      expect(harness.reviews[0]?.modelSelection.model).toBe("claude-opus-5");
      expect(harness.reviews[0]?.runtimeMode).toBe("full-access");

      const issue = yield* run.findIssue("issue-a");
      expect(issue?.status).toBe("in_review");
      expect(issue?.pullRequestUrl).toBe("https://example.test/pr/1");
      // Claimed before the review runs, so ingestion can recognise the thread
      // and a restart cannot review it twice.
      expect(issue?.reviewerThreadId).toBe(harness.reviews[0]?.threadId);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("links an existing open pull request before trying to create another", () => {
    const harness = makeHarness({ existingPullRequestState: "open" });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));

      expect(seen).toContain("autonomous.pull-request.opened");
      expect(seen).toContain("autonomous.review.started");
      expect(harness.stackedActions).toEqual([]);
      expect(harness.shippableChecks).toEqual([]);
      expect((yield* run.findIssue("issue-a"))?.pullRequestUrl).toBe("https://example.test/pr/9");
      expect(harness.reviews).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("links an existing closed pull request instead of creating a duplicate", () => {
    const harness = makeHarness({ existingPullRequestState: "closed" });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));

      expect(harness.stackedActions).toEqual([]);
      expect((yield* run.findIssue("issue-a"))?.pullRequestUrl).toBe("https://example.test/pr/9");
      expect(harness.reviews).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("recognizes an existing merged pull request as completed delivery", () => {
    const harness = makeHarness({ existingPullRequestState: "merged" });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;
      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));

      expect(seen).toContain("autonomous.pull-request.opened");
      expect(seen).toContain("autonomous.run.completed");
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.status).toBe("done");
      expect(issue?.pullRequestUrl).toBe("https://example.test/pr/9");
      expect(harness.stackedActions).toEqual([]);
      expect(harness.reviews).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("hands off a worker that finished while autonomous mode was paused", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      const threadId = ThreadId.make("paused-worker");
      yield* run.startIssueDirectly("issue-a", threadId);
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      // No live run owns this terminal event, so it is intentionally ignored.
      yield* run.endTurn(threadId, "idle");
      expect(harness.stackedActions).toEqual([]);

      const seen = yield* run.receiptsWhile(2, run.enableAutonomous());

      expect(seen).toContain("autonomous.pull-request.opened");
      expect(seen).toContain("autonomous.review.started");
      expect(harness.stackedActions).toEqual([
        { cwd: "/tmp/acme-worktrees/issue-a", action: "commit_push_pr" },
      ]);
      expect(harness.reviews).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reviews trivial work on the cheapest capable model and stamps the receipt", () => {
    const harness = makeHarness({
      reviewTier: "trivial",
      providers: makeProviderSnapshots([
        ...CLAUDE_MODELS,
        { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isCustom: false },
        { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isCustom: false },
      ]),
    });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      const seen = yield* run.collectReceiptsWhile(2, run.endTurn(threadId, "idle"));

      // The classifier saw the issue text and the worker's worktree.
      expect(harness.classified).toHaveLength(1);
      expect(harness.classified[0]?.issueTitle).toBe("Issue issue-a");
      expect(harness.classified[0]?.issueDescription).toBe("Body of issue-a");
      expect(harness.classified[0]?.worktreePath).toBe("/tmp/acme-worktrees/issue-a");

      // The trivial tier reviews on the Haiku, and the receipt records both
      // the tier and the resolved model for the UI.
      expect(harness.reviews[0]?.modelSelection.model).toBe("claude-haiku-4-5");
      const reviewStarted = seen.find((receipt) => receipt.type === "autonomous.review.started");
      expect(reviewStarted).toMatchObject({
        complexityTier: "trivial",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-haiku-4-5",
        },
      });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("falls back up the chain when the tier's model class is unavailable", () => {
    // The catalog exposes no Haiku and no Sonnet, so trivial work climbs all
    // the way to the strongest Opus rather than reviewing on nothing.
    const harness = makeHarness({ reviewTier: "trivial" });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      const seen = yield* run.collectReceiptsWhile(2, run.endTurn(threadId, "idle"));

      expect(harness.reviews[0]?.modelSelection.model).toBe("claude-opus-5");
      const reviewStarted = seen.find((receipt) => receipt.type === "autonomous.review.started");
      expect(reviewStarted).toMatchObject({
        complexityTier: "trivial",
        modelSelection: { model: "claude-opus-5" },
      });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("still parks the issue when no provider can review, whatever the tier", () => {
    const harness = makeHarness({ reviewTier: "trivial", providers: [] });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
      expect(seen).toContain("autonomous.issue.flagged");

      yield* run.reactor.drain;
      expect(harness.reviews).toEqual([]);
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.needsAttentionReason).toContain("No Claude provider is available");
      // Infrastructure, not a verdict: nobody read this code.
      expect(issue?.needsAttentionKind).toBe("review_unavailable");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("parks the issue when the pull request cannot be opened", () => {
    const harness = makeHarness({ pullRequestFails: true });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      const seen = yield* run.receiptsWhile(1, run.endTurn(threadId, "idle"));
      expect(seen).toEqual(["autonomous.issue.flagged"]);

      yield* run.reactor.drain;
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.needsAttentionAt).not.toBeNull();
      expect(issue?.needsAttentionReason).toContain("without producing a pull request");
      expect(issue?.needsAttentionKind).toBe("pull_request_failed");
      // Parked, not merged: the run must not claim this landed.
      expect(issue?.status).toBe("in_progress");
      expect(harness.reviews).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("finishes an issue whose worker left nothing to ship", () => {
    const harness = makeHarness({ shippableWork: false });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      // Two receipts: the issue finishing, then the run finishing with it.
      const seen = yield* run.collectReceiptsWhile(2, run.endTurn(threadId, "idle"));
      expect(seen.map((receipt) => receipt.type)).toEqual([
        "autonomous.issue.completed-without-changes",
        "autonomous.run.completed",
      ]);
      expect(seen[0]).toMatchObject({
        issueId: IssueId.make("issue-a"),
        threadId,
        reason: "The worker finished without local changes; there was nothing to ship.",
      });

      // The pre-check looked at the worker's own worktree, against the branch
      // the review and merge use.
      expect(harness.shippableChecks).toEqual([
        { cwd: "/tmp/acme-worktrees/issue-a", baseBranch: "main" },
      ]);
      // Nothing to commit is not a reason to run a commit/push/PR, and not a
      // reason to park the issue either.
      expect(harness.stackedActions).toEqual([]);
      expect(harness.reviews).toEqual([]);
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.status).toBe("done");
      expect(issue?.needsAttentionAt).toBeNull();
      expect(issue?.pullRequestUrl).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("says so when the empty-handed worker delegated its work away", () => {
    const harness = makeHarness({ shippableWork: false });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      // What delegation leaves behind: an issue on another project's board,
      // marked with the thread that filed it. The harness has one project, so
      // the mark is what carries the meaning here, exactly as the reactor
      // reads it out of the shell snapshot.
      // Waited on rather than drained: the harness's single project means the
      // reactor also starts issue-b, and its receipt must be out of the way
      // before the one under test.
      yield* run.receiptsWhile(1, run.createDelegatedIssue("issue-b", threadId));
      yield* run.reactor.drain;
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      const seen = yield* run.collectReceiptsWhile(1, run.endTurn(threadId, "idle"));
      expect(seen[0]).toMatchObject({
        type: "autonomous.issue.completed-without-changes",
        reason:
          "The worker finished without local changes; its work was delegated to linked projects.",
      });
      expect((yield* run.findIssue("issue-a"))?.status).toBe("done");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("opens the pull request anyway when the shippable-work check fails", () => {
    const harness = makeHarness({ shippableWork: "fails" });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
      // A probe that cannot answer must never be why real work is dropped.
      expect(seen).toContain("autonomous.pull-request.opened");
      expect(harness.stackedActions).toEqual([
        { cwd: "/tmp/acme-worktrees/issue-a", action: "commit_push_pr" },
      ]);
      expect((yield* run.findIssue("issue-a"))?.status).toBe("in_review");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("retries only the pull request when its attention flag is cleared", () => {
    const harness = makeHarness({ pullRequestFails: true });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      yield* run.receiptsWhile(1, run.endTurn(threadId, "idle"));
      yield* run.reactor.drain;

      harness.allowPullRequests();
      const seen = yield* run.receiptsWhile(
        2,
        run.dispatch({
          type: "issue.attention.clear",
          commandId: run.nextCommandId("retry-pr"),
          issueId: IssueId.make("issue-a"),
        }),
      );

      expect(seen).toEqual(["autonomous.pull-request.opened", "autonomous.review.started"]);
      expect(harness.started).toHaveLength(1);
      expect(harness.stackedActions).toHaveLength(2);
      expect(harness.reviews).toHaveLength(1);
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.pullRequestUrl).toBe("https://example.test/pr/1");
      expect(issue?.status).toBe("in_review");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("parks the issue when its worker session ends in an error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", null);

      yield* run.receiptsWhile(1, run.endTurn(threadId, "error"));

      // A failed session never reaches the PR step.
      expect(harness.stackedActions).toEqual([]);
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.needsAttentionReason).toContain("ended in an error");
      expect(issue?.needsAttentionKind).toBe("other");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("leaves the issue alone while its worker waits out a provider limit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", null);

      yield* run.endTurn(threadId, "error", { resumeAt: "2026-01-01T05:00:00.000Z" });
      yield* run.reactor.drain;

      // The turn is not over — the server restarts it when the limit lifts —
      // so the issue must not be handed to a human, and must not reach the PR
      // step either.
      expect(harness.stackedActions).toEqual([]);
      const issue = yield* run.findIssue("issue-a");
      expect(issue?.needsAttentionAt).toBeNull();
      expect(issue?.status).toBe("in_progress");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reviews one issue at a time and releases the queue on a recorded verdict", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.createIssue("issue-b");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;
      expect(harness.started).toHaveLength(2);

      const finishWorker = Effect.fn("finishWorker")(function* (
        issueId: string,
        receiptCount: number,
      ) {
        const startedIssue = harness.started.find(
          (entry) => entry.command.issueId === IssueId.make(issueId),
        );
        if (!startedIssue) throw new Error(`expected ${issueId} to have started`);
        const threadId = startedIssue.command.threadId;
        yield* run.createWorkerThread(
          threadId,
          `/tmp/acme-worktrees/${issueId}`,
          `issue/${issueId}`,
        );
        yield* run.receiptsWhile(receiptCount, run.endTurn(threadId, "idle"));
      });

      // Both workers finish, but only one review may be in flight.
      yield* finishWorker("issue-a", 2);
      yield* finishWorker("issue-b", 1);
      expect(harness.reviews).toHaveLength(1);
      expect(harness.reviews[0]?.issueId).toBe(IssueId.make("issue-a"));

      // Recording the first verdict is what lets the queue take the second, so
      // the second reviewer rebases onto a base that already has the first.
      const firstReviewer = harness.reviews[0]?.threadId;
      if (!firstReviewer) throw new Error("expected a reviewer thread");
      const seen = yield* run.receiptsWhile(
        1,
        run.dispatch({
          type: "issue.review.record",
          commandId: run.nextCommandId("review-a"),
          issueId: IssueId.make("issue-a"),
          reviewerThreadId: firstReviewer,
          verdict: "merged",
          notes: "Rebased and merged.",
        }),
      );
      expect(seen).toEqual(["autonomous.review.started"]);
      expect(harness.reviews).toHaveLength(2);
      expect(harness.reviews[1]?.issueId).toBe(IssueId.make("issue-b"));

      expect((yield* run.findIssue("issue-a"))?.status).toBe("done");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "replaces provisional review attention when the pull request was merged outside Atlas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const run = yield* bootRun();
        yield* run.createProject();
        yield* run.createIssue("issue-a");
        yield* run.enableAutonomous();
        yield* run.reactor.drain;

        const threadId = harness.started[0]?.command.threadId;
        if (!threadId) throw new Error("expected the issue to have started");
        yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
        yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));

        expect((yield* run.findIssue("issue-a"))?.status).toBe("in_review");
        const reviewerThreadId = harness.reviews[0]?.threadId;
        if (!reviewerThreadId) throw new Error("expected a reviewer thread");
        yield* run.dispatch({
          type: "issue.review.record",
          commandId: run.nextCommandId("provisional-review"),
          issueId: IssueId.make("issue-a"),
          reviewerThreadId,
          verdict: "needs_attention",
          notes: "The interim turn did not include a t3-review block.",
        });
        expect((yield* run.findIssue("issue-a"))?.reviewVerdict).toBe("needs_attention");
        // A refusal is the one park that is a judgement on the code.
        expect((yield* run.findIssue("issue-a"))?.needsAttentionKind).toBe(
          "review_needs_attention",
        );

        harness.markPullRequestMerged();

        // Any subsequent project evaluation reconciles the external state; the
        // background minute tick uses this same path in production.
        yield* run.enableAutonomous();
        yield* run.reactor.drain;

        const issue = yield* run.findIssue("issue-a");
        expect(issue?.status).toBe("done");
        expect(issue?.reviewVerdict).toBe("merged");
        expect(issue?.needsAttentionAt).toBeNull();
        expect(harness.resolvedPullRequests).toContainEqual({
          cwd: "/tmp/acme-worktrees/issue-a",
          reference: "https://example.test/pr/1",
        });

        const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
        expect(Option.getOrThrow(project).autonomousStartedAt).toBeNull();
        expect(Option.getOrThrow(project).autonomousFinishedReason).toBe("completed");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("carries a delegated issue through review with no run on its project", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createDelegatedIssue("issue-a");
      yield* run.reactor.drain;

      // The delegating coordinator starts these, not this loop — and a project
      // with no run must never be "completed" out from under one.
      expect(harness.started).toEqual([]);
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousFinishedReason).toBeNull();

      const threadId = ThreadId.make("delegated-worker");
      yield* run.startIssueDirectly("issue-a", threadId);
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      const seen = yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
      expect(seen).toContain("autonomous.pull-request.opened");
      expect(seen).toContain("autonomous.review.started");

      const issue = yield* run.findIssue("issue-a");
      expect(issue?.status).toBe("in_review");
      expect(issue?.pullRequestUrl).toBe("https://example.test/pr/1");
      expect(harness.reviews).toHaveLength(1);
      expect(harness.reviews[0]?.issueId).toBe(IssueId.make("issue-a"));
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("finishes a run started on an empty backlog", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      // Wait on the receipt rather than a drain: the drain can run before the
      // reactor has even taken the enable event off its buffer.
      const seen = yield* run.receiptsWhile(1, run.enableAutonomous());
      expect(seen).toEqual(["autonomous.run.completed"]);
      yield* run.reactor.drain;

      // Nothing to do is a finished run, not a run left switched on.
      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousStartedAt).toBeNull();
      expect(Option.getOrThrow(project).autonomousFinishedReason).toBe("completed");
      expect(harness.started).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("leaves an ordinary issue in a run-less project alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      // Started by hand, the way a user starts an issue without a run. Nothing
      // about that asks for an automatic pull request or a review.
      const threadId = ThreadId.make("manual-worker");
      yield* run.startIssueDirectly("issue-a", threadId);
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");

      yield* run.endTurn(threadId, "idle");
      yield* run.reactor.drain;

      expect(harness.stackedActions).toEqual([]);
      expect(harness.reviews).toEqual([]);
      expect((yield* run.findIssue("issue-a"))?.status).toBe("in_progress");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("start returns while activation is parked, then catches up once activated", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        // The server calls reactors.start before the activation boundary; a
        // start that awaits its parked fiber deadlocks the whole startup.
        const run = yield* bootRun();
        yield* run.createProject();
        yield* run.createIssue("issue-a");
        yield* run.enableAutonomous();
        // Side effects stay parked until activation.
        expect(harness.started).toEqual([]);

        const seen = yield* run.receiptsWhile(1, Deferred.succeed(gate, undefined));
        expect(seen).toEqual(["autonomous.issue.started"]);
        expect(harness.started.map((entry) => entry.command.issueId)).toEqual([
          IssueId.make("issue-a"),
        ]);
      }).pipe(Effect.provideService(ServerActivation, Deferred.await(gate)));
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("resumes a run that was already enabled before it subscribed (restart sweep)", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      // Simulate the state a restart leaves behind: the run was enabled in a
      // previous process, so no domain event will ever announce it again.
      const engine = yield* OrchestrationEngineService;
      const dispatch = (command: OrchestrationCommand) =>
        engine.dispatch(command).pipe(Effect.orDie);
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-restart-project"),
        projectId: PROJECT_ID,
        title: "Acme",
        workspaceRoot: "/tmp/acme",
        defaultModelSelection: MODEL,
        createdAt: NOW,
      });
      yield* dispatch({
        type: "issue.create",
        commandId: CommandId.make("cmd-restart-issue"),
        issueId: IssueId.make("issue-a"),
        projectId: PROJECT_ID,
        title: "Issue issue-a",
        description: "Body of issue-a",
        dependsOn: [],
        createdAt: NOW,
      });
      yield* dispatch({
        type: "project.autonomous.enable",
        commandId: CommandId.make("cmd-restart-enable"),
        projectId: PROJECT_ID,
        createdAt: NOW,
      });

      const receiptBus = yield* RuntimeReceiptBus;
      const collector = yield* Effect.forkChild(
        Stream.take(receiptBus.streamEventsForTest, 1).pipe(Stream.runCollect),
      );
      yield* bootRun();
      const collected = Array.from(yield* Fiber.join(collector));
      expect(collected.map((receipt) => receipt.type)).toEqual(["autonomous.issue.started"]);
      expect(harness.started.map((entry) => entry.command.issueId)).toEqual([
        IssueId.make("issue-a"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  // A provider outage is not a review. The regression these three cover: one
  // 529 used to become a permanent `needs_attention` verdict, and because
  // nothing ever resets a verdict, the issue could never be reviewed again.
  it.effect("retries a reviewer the provider killed instead of recording a verdict", () => {
    const harness = makeHarness({ testClock: true });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const threadId = harness.started[0]?.command.threadId;
      if (!threadId) throw new Error("expected the issue to have started");
      yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
      yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
      const reviewerThreadId = harness.reviews[0]?.threadId;
      if (!reviewerThreadId) throw new Error("expected a reviewer thread");

      const scheduled = yield* run.collectReceiptsWhile(1, run.endTurn(reviewerThreadId, "error"));
      expect(scheduled[0]).toMatchObject({
        type: "autonomous.review.retry-scheduled",
        issueId: IssueId.make("issue-a"),
        reviewerThreadId,
        attempt: 2,
        delayMs: 60_000,
      });

      // Nothing was decided about the code, so nothing is recorded about it.
      const waiting = yield* run.findIssue("issue-a");
      expect(waiting?.reviewVerdict ?? null).toBeNull();
      expect(waiting?.needsAttentionAt ?? null).toBeNull();
      expect(waiting?.status).toBe("in_review");

      // A minute later the same reviewer is asked to finish. Not a new one:
      // starting over would throw away everything it already fixed and pushed.
      const resumed = yield* run.collectReceiptsWhile(1, TestClock.adjust(Duration.minutes(1)));
      expect(resumed[0]).toMatchObject({
        type: "autonomous.review.resumed",
        issueId: IssueId.make("issue-a"),
        reviewerThreadId,
        attempt: 2,
      });
      expect(harness.reviews).toHaveLength(1);
      expect(harness.resumedReviews).toHaveLength(1);
      expect(harness.resumedReviews[0]?.threadId).toBe(reviewerThreadId);
      expect(harness.resumedReviews[0]?.detail).toBe("API Error: 529 Overloaded");
      expect((yield* run.findIssue("issue-a"))?.reviewerThreadId).toBe(reviewerThreadId);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "parks the issue on infrastructure once the attempts run out, verdict still null",
    () => {
      const harness = makeHarness({ testClock: true });
      return Effect.gen(function* () {
        const run = yield* bootRun();
        yield* run.createProject();
        yield* run.createIssue("issue-a");
        yield* run.enableAutonomous();
        yield* run.reactor.drain;

        const threadId = harness.started[0]?.command.threadId;
        if (!threadId) throw new Error("expected the issue to have started");
        yield* run.createWorkerThread(threadId, "/tmp/acme-worktrees/issue-a", "issue/issue-a");
        yield* run.receiptsWhile(2, run.endTurn(threadId, "idle"));
        const reviewerThreadId = harness.reviews[0]?.threadId;
        if (!reviewerThreadId) throw new Error("expected a reviewer thread");

        // Attempt 1 dies, attempt 2 waits a minute and dies, attempt 3 waits
        // four and dies too.
        yield* run.receiptsWhile(1, run.endTurn(reviewerThreadId, "error"));
        yield* run.receiptsWhile(1, TestClock.adjust(Duration.minutes(1)));
        const rescheduled = yield* run.collectReceiptsWhile(
          1,
          run.endTurn(reviewerThreadId, "error"),
        );
        expect(rescheduled[0]).toMatchObject({ attempt: 3, delayMs: 240_000 });
        yield* run.receiptsWhile(1, TestClock.adjust(Duration.minutes(4)));
        expect(harness.resumedReviews).toHaveLength(2);

        const flagged = yield* run.collectReceiptsWhile(1, run.endTurn(reviewerThreadId, "error"));
        expect(flagged[0]).toMatchObject({
          type: "autonomous.issue.flagged",
          issueId: IssueId.make("issue-a"),
        });

        const parked = yield* run.findIssue("issue-a");
        expect(parked?.needsAttentionAt).not.toBeNull();
        expect(parked?.needsAttentionReason).toContain("The reviewer could not run");
        expect(parked?.needsAttentionReason).toContain("The code has not been reviewed.");
        // The kind is what stops the UI presenting an outage as a verdict.
        expect(parked?.needsAttentionKind).toBe("review_unavailable");
        // The whole point: no verdict was ever written, so clearing the flag
        // leaves an issue that can still be reviewed.
        expect(parked?.reviewVerdict ?? null).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("reviews the next issue while a provider-killed review waits out its backoff", () => {
    const harness = makeHarness({ testClock: true });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.createIssue("issue-b");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const finishWorker = Effect.fn("finishWorker")(function* (
        issueId: string,
        receiptCount: number,
      ) {
        const startedIssue = harness.started.find(
          (entry) => entry.command.issueId === IssueId.make(issueId),
        );
        if (!startedIssue) throw new Error(`expected ${issueId} to have started`);
        yield* run.createWorkerThread(
          startedIssue.command.threadId,
          `/tmp/acme-worktrees/${issueId}`,
          `issue/${issueId}`,
        );
        yield* run.receiptsWhile(receiptCount, run.endTurn(startedIssue.command.threadId, "idle"));
      });

      yield* finishWorker("issue-a", 2);
      yield* finishWorker("issue-b", 1);
      expect(harness.reviews).toHaveLength(1);
      const reviewerThreadId = harness.reviews[0]?.threadId;
      if (!reviewerThreadId) throw new Error("expected a reviewer thread");

      // The first reviewer dies on the provider. Its retry is parked out of the
      // queue, so the queue takes the next issue rather than waiting a minute
      // for a review that is not running.
      const seen = yield* run.receiptsWhile(2, run.endTurn(reviewerThreadId, "error"));
      expect(seen.toSorted()).toEqual([
        "autonomous.review.retry-scheduled",
        "autonomous.review.started",
      ]);
      expect(harness.reviews).toHaveLength(2);
      expect(harness.reviews[1]?.issueId).toBe(IssueId.make("issue-b"));
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("leaves a reviewer parked on a usage limit to its own recovery", () => {
    const harness = makeHarness({ testClock: true });
    return Effect.gen(function* () {
      const run = yield* bootRun();
      yield* run.createProject();
      yield* run.createIssue("issue-a");
      yield* run.createIssue("issue-b");
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const finishWorker = Effect.fn("finishWorker")(function* (
        issueId: string,
        receiptCount: number,
      ) {
        const startedIssue = harness.started.find(
          (entry) => entry.command.issueId === IssueId.make(issueId),
        );
        if (!startedIssue) throw new Error(`expected ${issueId} to have started`);
        yield* run.createWorkerThread(
          startedIssue.command.threadId,
          `/tmp/acme-worktrees/${issueId}`,
          `issue/${issueId}`,
        );
        yield* run.receiptsWhile(receiptCount, run.endTurn(startedIssue.command.threadId, "idle"));
      });

      yield* finishWorker("issue-a", 2);
      yield* finishWorker("issue-b", 1);
      const reviewerThreadId = harness.reviews[0]?.threadId;
      if (!reviewerThreadId) throw new Error("expected a reviewer thread");

      // An exhausted account is `ModelFailover`'s to recover: it restarts the
      // turn when the limit lifts, so spending a retry budget on it here would
      // park the issue over a wait that was always going to end by itself.
      yield* run.endTurn(reviewerThreadId, "error", {
        lastError: "Claude AI usage limit reached|1755100800",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      expect(harness.resumedReviews).toEqual([]);

      // The review is untouched and still holds the queue, so the verdict it
      // eventually reports is what releases the next issue — exactly as if the
      // limit had never happened.
      const seen = yield* run.receiptsWhile(
        1,
        run.dispatch({
          type: "issue.review.record",
          commandId: run.nextCommandId("review-after-limit"),
          issueId: IssueId.make("issue-a"),
          reviewerThreadId,
          verdict: "merged",
          notes: "Recovered on the backup model, rebased and merged.",
        }),
      );
      expect(seen).toEqual(["autonomous.review.started"]);
      expect(harness.resumedReviews).toEqual([]);
      expect(harness.reviews).toHaveLength(2);
      expect(harness.reviews[1]?.issueId).toBe(IssueId.make("issue-b"));
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
