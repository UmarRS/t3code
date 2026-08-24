import {
  CommandId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  THREAD_AUTO_SHIP_ACTIVITY_KIND,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
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
import { AutoShipReactor } from "../Services/AutoShipReactor.ts";
import { AutoShipReactorLive } from "./AutoShipReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const WORKTREE = "/tmp/acme-worktrees/thread-1";
const PR_URL = "https://example.test/pr/1";
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

/**
 * The reactor with real projections behind it and only git stubbed. The thread
 * state the reactor reads back is genuinely projected from the commands each
 * scenario dispatches, so a scenario that forgets to turn auto-ship on fails
 * for the same reason production would.
 */
function makeHarness(options?: {
  readonly shippableWork?: boolean | "fails";
  readonly pullRequest?: "created" | "none";
  readonly mergeFails?: boolean;
}) {
  const stackedActions: Array<{ readonly cwd: string; readonly action: string }> = [];
  const shippableChecks: Array<{ readonly cwd: string; readonly baseBranch: string }> = [];
  const merges: Array<{ readonly cwd: string; readonly reference: string }> = [];
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

  const gitLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    invalidateStatus: () => Effect.void,
    resolveBaseBranch: () => Effect.succeed("main"),
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
          pr:
            options?.pullRequest === "none"
              ? { status: "skipped_not_requested" as const }
              : { status: "created" as const, url: PR_URL },
          toast: { title: "done", cta: { kind: "none" as const } },
        };
      }),
    mergePullRequest: (input: { readonly cwd: string; readonly reference: string }) =>
      Effect.suspend(() => {
        merges.push(input);
        return options?.mergeFails === true
          ? Effect.fail(
              new GitCommandError({
                operation: "GitWorkflowService.mergePullRequest",
                command: "gh",
                cwd: input.cwd,
                detail: "required status checks have not passed",
              }),
            )
          : Effect.void;
      }),
  } as never);

  const layer = AutoShipReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, stackedActions, shippableChecks, merges };
}

/** Everything a scenario needs, with the reactor already subscribed. */
const bootShip = Effect.fn("bootShip")(function* (options?: { readonly worktree?: boolean }) {
  const engine = yield* OrchestrationEngineService;
  const reactor = yield* AutoShipReactor;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;
  yield* reactor.start();

  let commandSeq = 0;
  const nextCommandId = (tag: string) => {
    commandSeq += 1;
    return CommandId.make(`cmd-${tag}-${commandSeq}`);
  };
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.orDie);

  yield* dispatch({
    type: "project.create",
    commandId: nextCommandId("project"),
    projectId: PROJECT_ID,
    title: "Acme",
    workspaceRoot: "/tmp/acme",
    defaultModelSelection: MODEL,
    createdAt: NOW,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId("thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Bump dependencies",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "chore/bump",
    worktreePath: options?.worktree === false ? null : WORKTREE,
    createdAt: NOW,
  });

  const setAutoShip = (enabled: boolean) =>
    dispatch({
      type: "thread.auto-ship.set",
      commandId: nextCommandId(`auto-ship-${enabled}`),
      threadId: THREAD_ID,
      enabled,
      createdAt: NOW,
    });

  const endTurn = (status: OrchestrationSessionStatus = "idle") =>
    dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(`session-${status}`),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status,
        providerName: "claude",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        resumeAt: null,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });

  /**
   * Run `body` and resolve with the types of the next `count` ship receipts.
   * Every ship the reactor owns publishes exactly one, so this is the signal
   * that a trigger has been fully processed — `drain` alone is not, because it
   * can observe an empty queue before the event loop has enqueued anything.
   *
   * The event loop is a single FIFO fiber, so a trigger the reactor ignores can
   * be asserted by following it with one that does publish: when that receipt
   * arrives, the ignored event has already been through.
   */
  const receiptsWhile = <A, E, R>(count: number, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const collector = yield* Effect.forkChild(
        Stream.take(receipts.streamEventsForTest, count).pipe(Stream.runCollect),
      );
      yield* body;
      const collected = Array.from(yield* Fiber.join(collector));
      return collected.map((receipt) => receipt.type);
    });

  const shipActivities = Effect.gen(function* () {
    const detail = yield* snapshotQuery.getThreadDetailById(THREAD_ID);
    if (Option.isNone(detail)) return [];
    return detail.value.activities.filter(
      (activity) => activity.kind === THREAD_AUTO_SHIP_ACTIVITY_KIND,
    );
  });

  const threadShell = snapshotQuery
    .getThreadShellById(THREAD_ID)
    .pipe(Effect.map(Option.getOrThrow));

  /**
   * Session stops leave no trace in the projection — they are an intent the
   * provider reactor consumes — so the event log is the only place to see
   * whether the settle cleaned up after itself.
   */
  const sessionStopRequests = Stream.runCollect(
    engine
      .readEvents(0)
      .pipe(Stream.filter((event) => event.type === "thread.session-stop-requested")),
  ).pipe(Effect.map((events) => Array.from(events).length));

  return {
    reactor,
    setAutoShip,
    endTurn,
    receiptsWhile,
    shipActivities,
    threadShell,
    sessionStopRequests,
  };
});

describe("auto-ship reactor", () => {
  it.effect("commits, pushes, opens and merges when a turn ends with work to ship", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        // Enabling ships what is already there; clear that first pass out
        // before measuring the turn-end ship.
        yield* run.receiptsWhile(1, run.setAutoShip(true));
        harness.stackedActions.length = 0;
        harness.merges.length = 0;

        const types = yield* run.receiptsWhile(1, run.endTurn());

        expect(types).toEqual(["thread.auto-ship.completed"]);
        expect(harness.shippableChecks.at(-1)).toEqual({ cwd: WORKTREE, baseBranch: "main" });
        expect(harness.stackedActions).toEqual([{ cwd: WORKTREE, action: "commit_push_pr" }]);
        expect(harness.merges).toEqual([{ cwd: WORKTREE, reference: PR_URL }]);

        const activities = yield* run.shipActivities;
        expect(activities.at(-1)?.payload).toMatchObject({
          outcome: "merged",
          pullRequestUrl: PR_URL,
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("turning auto-ship on ships the work already in the worktree", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        const types = yield* run.receiptsWhile(1, run.setAutoShip(true));

        expect(types).toEqual(["thread.auto-ship.completed"]);
        expect(harness.stackedActions).toEqual([{ cwd: WORKTREE, action: "commit_push_pr" }]);
        expect(harness.merges).toEqual([{ cwd: WORKTREE, reference: PR_URL }]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a turn that changed nothing ships nothing and says nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ shippableWork: false });
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        const types = yield* run.receiptsWhile(
          2,
          run.setAutoShip(true).pipe(Effect.andThen(run.endTurn())),
        );

        expect(types).toEqual(["thread.auto-ship.skipped", "thread.auto-ship.skipped"]);
        expect(harness.stackedActions).toEqual([]);
        expect(harness.merges).toEqual([]);
        expect(yield* run.shipActivities).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a broken shippable probe never strands real work", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ shippableWork: "fails" });
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        yield* run.receiptsWhile(1, run.setAutoShip(true));

        expect(harness.stackedActions).toEqual([{ cwd: WORKTREE, action: "commit_push_pr" }]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a turn on a thread without auto-ship ships nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        // The turn end is ignored; the enable behind it is what publishes, and
        // FIFO ordering means its receipt proves the turn end was processed
        // first. One ship, from the enable, is the whole assertion.
        const types = yield* run.receiptsWhile(
          1,
          run.endTurn().pipe(Effect.andThen(run.setAutoShip(true))),
        );

        expect(types).toEqual(["thread.auto-ship.completed"]);
        expect(harness.stackedActions).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("turning auto-ship off stops the next turn from shipping", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        yield* run.receiptsWhile(1, run.setAutoShip(true));
        harness.stackedActions.length = 0;

        const types = yield* run.receiptsWhile(
          1,
          run
            .setAutoShip(false)
            .pipe(Effect.andThen(run.endTurn()), Effect.andThen(run.setAutoShip(true))),
        );

        expect(types).toEqual(["thread.auto-ship.completed"]);
        expect(harness.stackedActions).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a session that ended in an error ships nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        yield* run.receiptsWhile(1, run.setAutoShip(true));
        harness.stackedActions.length = 0;

        const types = yield* run.receiptsWhile(1, run.endTurn("error"));

        expect(types).toEqual(["thread.auto-ship.skipped"]);
        expect(harness.stackedActions).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a refused merge leaves the pull request open and links it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ mergeFails: true });
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        const types = yield* run.receiptsWhile(1, run.setAutoShip(true));

        expect(types).toEqual(["thread.auto-ship.failed"]);
        expect(harness.merges).toHaveLength(1);
        const activities = yield* run.shipActivities;
        expect(activities.at(-1)?.tone).toBe("error");
        expect(activities.at(-1)?.payload).toMatchObject({
          outcome: "opened",
          pullRequestUrl: PR_URL,
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("settles the thread once its work is merged", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        yield* run.receiptsWhile(1, run.endTurn().pipe(Effect.andThen(run.setAutoShip(true))));

        // The work is on main: nothing is left for anyone to do here, so the
        // thread parks itself the same way a user would park it.
        const thread = yield* run.threadShell;
        expect(thread.settledOverride).toBe("settled");
        expect(thread.settledAt).not.toBeNull();
        // And the idle provider session behind it is stopped, exactly as it
        // would be if a user had settled the thread from the sidebar.
        expect(yield* run.sessionStopRequests).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a ship that could not merge leaves the thread active", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ mergeFails: true });
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        yield* run.receiptsWhile(1, run.endTurn().pipe(Effect.andThen(run.setAutoShip(true))));

        // The pull request is open and waiting on a human. Parking the thread
        // would file that away as finished.
        const thread = yield* run.threadShell;
        expect(thread.settledOverride).toBeNull();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a run that produced no pull request is reported as a failed ship", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ pullRequest: "none" });
      yield* Effect.gen(function* () {
        const run = yield* bootShip();
        const types = yield* run.receiptsWhile(1, run.setAutoShip(true));

        expect(types).toEqual(["thread.auto-ship.failed"]);
        expect(harness.merges).toEqual([]);
        const activities = yield* run.shipActivities;
        expect(activities.at(-1)?.payload).toMatchObject({ outcome: "failed" });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
