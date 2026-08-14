import {
  CommandId,
  IssueId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
  type IssueReviewStartInput,
  type IssueStartCommand,
  type IssueStartOptions,
} from "../Services/IssueStartCoordinator.ts";
import { AutonomousRunReactor } from "../Services/AutonomousRunReactor.ts";
import { AutonomousRunReactorLive } from "./AutonomousRunReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

interface StartedIssue {
  readonly command: IssueStartCommand;
  readonly options: IssueStartOptions | undefined;
}

const providerSnapshots = [
  {
    instanceId: ProviderInstanceId.make("claude"),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [
      { slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false },
      { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false },
    ],
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
function makeHarness(options?: { readonly pullRequestFails?: boolean }) {
  const started: StartedIssue[] = [];
  const reviews: IssueReviewStartInput[] = [];
  const stackedActions: Array<{ readonly cwd: string; readonly action: string }> = [];
  const resolvedPullRequests: Array<{ readonly cwd: string; readonly reference: string }> = [];
  let pullRequestFails = options?.pullRequestFails ?? false;
  let pullRequestState: "open" | "merged" = "open";

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
      return {
        startIssue: (command: IssueStartCommand, startOptions?: IssueStartOptions) =>
          Effect.gen(function* () {
            started.push({ command, options: startOptions });
            return yield* engine.dispatch(command).pipe(Effect.orDie);
          }),
        startIssueReview: (input: IssueReviewStartInput) =>
          Effect.sync(() => {
            reviews.push(input);
            return { sequence: 0 };
          }),
      };
    }),
  ).pipe(Layer.provide(orchestrationLayer));

  const gitLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
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

  const layer = AutonomousRunReactorLive.pipe(
    Layer.provideMerge(coordinatorLayer),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    started,
    reviews,
    stackedActions,
    resolvedPullRequests,
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

  const createIssue = (id: string, dependsOn: ReadonlyArray<string> = []) =>
    dispatch({
      type: "issue.create",
      commandId: nextCommandId(`issue-${id}`),
      issueId: IssueId.make(id),
      projectId: PROJECT_ID,
      title: `Issue ${id}`,
      description: `Body of ${id}`,
      dependsOn: dependsOn.map((entry) => IssueId.make(entry)),
      createdAt: NOW,
    });

  const enableAutonomous = () =>
    dispatch({
      type: "project.autonomous.enable",
      commandId: nextCommandId("enable"),
      projectId: PROJECT_ID,
      createdAt: NOW,
    });

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

  const endTurn = (threadId: ThreadId, status: "idle" | "error") =>
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
        lastError: status === "error" ? "provider exploded" : null,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });

  /**
   * Collect the next `count` receipts while `body` runs. Forked first so the
   * subscription exists before the work that publishes them — the alternative
   * would be a sleep, which is what receipts exist to avoid.
   */
  const receiptsWhile = <A, E, R>(count: number, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const collector = yield* Effect.forkChild(
        Stream.take(receipts.streamEventsForTest, count).pipe(Stream.runCollect),
      );
      yield* body;
      const collected = yield* Fiber.join(collector);
      return Array.from(collected).map((receipt) => receipt.type);
    });

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
    createIssue,
    enableAutonomous,
    createWorkerThread,
    endTurn,
    receiptsWhile,
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
      // Parked, not merged: the run must not claim this landed.
      expect(issue?.status).toBe("in_progress");
      expect(harness.reviews).toEqual([]);
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
        1,
        run.dispatch({
          type: "issue.attention.clear",
          commandId: run.nextCommandId("retry-pr"),
          issueId: IssueId.make("issue-a"),
        }),
      );

      expect(seen).toEqual(["autonomous.pull-request.opened"]);
      expect(harness.started).toHaveLength(1);
      expect(harness.stackedActions).toHaveLength(2);
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

  it.effect("finishes an issue when its active pull request was merged outside Atlas", () => {
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
      harness.markPullRequestMerged();

      // Any subsequent project evaluation reconciles the external state; the
      // background minute tick uses this same path in production.
      yield* run.enableAutonomous();
      yield* run.reactor.drain;

      const issue = yield* run.findIssue("issue-a");
      expect(issue?.status).toBe("done");
      expect(issue?.reviewVerdict).toBe("merged");
      expect(harness.resolvedPullRequests).toContainEqual({
        cwd: "/tmp/acme-worktrees/issue-a",
        reference: "https://example.test/pr/1",
      });

      const project = yield* run.snapshotQuery.getProjectShellById(PROJECT_ID);
      expect(Option.getOrThrow(project).autonomousStartedAt).toBeNull();
      expect(Option.getOrThrow(project).autonomousFinishedReason).toBe("completed");
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
});
