import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  localTimeOfDay,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectAutonomousScheduleEntry,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { AutonomousScheduleReactor } from "../Services/AutonomousScheduleReactor.ts";
import { AutonomousScheduleReactorLive } from "./AutonomousScheduleReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5",
};

/** Local wall-clock instants: schedules are read in the server's own timezone. */
const at = (
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds = 0,
) =>
  DateTime.toDateUtc(
    DateTime.makeZonedUnsafe(
      { year, month, day, hour: hours, minute: minutes, second: seconds },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    ),
  );

// 2026-03-02 is a Monday, 2026-03-07 a Saturday.
const MONDAY_0900 = at(2026, 3, 2, 9, 0);
const SATURDAY_0900 = at(2026, 3, 7, 9, 0);

const entry = (
  overrides: Partial<ProjectAutonomousScheduleEntry> = {},
): ProjectAutonomousScheduleEntry => ({
  id: "morning",
  time: localTimeOfDay(MONDAY_0900),
  daysOfWeek: [],
  enabled: true,
  ...overrides,
});

/**
 * The real engine, projections and reactor over an in-memory database. Nothing
 * here is stubbed: a scheduled start is only interesting if it is the same
 * command a person clicking the toggle sends.
 */
function makeHarness() {
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

  return AutonomousScheduleReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(OrchestrationEventStoreLive.pipe(Layer.provide(SqlitePersistenceMemory))),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const bootSchedule = Effect.fn("bootSchedule")(function* () {
  const engine = yield* OrchestrationEngineService;
  const reactor = yield* AutonomousScheduleReactor;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;
  const eventStore = yield* OrchestrationEventStore;

  let commandSeq = 0;
  const nextCommandId = (tag: string) => {
    commandSeq += 1;
    return CommandId.make(`cmd-${tag}-${commandSeq}`);
  };
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.orDie);

  const createProject = (projectId = PROJECT_ID) =>
    dispatch({
      type: "project.create",
      commandId: nextCommandId("project"),
      projectId,
      title: `Project ${projectId}`,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: MODEL,
      createdAt: NOW,
    });

  const setSchedule = (
    schedule: ReadonlyArray<ProjectAutonomousScheduleEntry>,
    projectId = PROJECT_ID,
  ) =>
    dispatch({
      type: "project.autonomous.schedule.set",
      commandId: nextCommandId("schedule"),
      projectId,
      schedule,
    });

  const enableAutonomous = (projectId = PROJECT_ID) =>
    dispatch({
      type: "project.autonomous.enable",
      commandId: nextCommandId("enable"),
      projectId,
      createdAt: NOW,
    });

  const disableAutonomous = (projectId = PROJECT_ID) =>
    dispatch({
      type: "project.autonomous.disable",
      commandId: nextCommandId("disable"),
      projectId,
      reason: "user",
    });

  /** Every persisted event of a type, which is how "fired once" is asserted. */
  const eventsOfType = (type: OrchestrationEvent["type"]) =>
    Stream.runCollect(eventStore.readFromSequence(0)).pipe(
      Effect.map((events) => Array.from(events).filter((event) => event.type === type)),
      Effect.orDie,
    );

  const projectShell = (projectId = PROJECT_ID) =>
    snapshotQuery.getProjectShellById(projectId).pipe(Effect.orDie);

  /** Collect the next `count` receipts while `body` runs. */
  const receiptsWhile = <A, E, R>(count: number, body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const collector = yield* Effect.forkChild(
        Stream.take(receipts.streamEventsForTest, count).pipe(Stream.runCollect),
      );
      yield* body;
      return Array.from(yield* Fiber.join(collector));
    });

  return {
    reactor,
    dispatch,
    createProject,
    setSchedule,
    enableAutonomous,
    disableAutonomous,
    eventsOfType,
    projectShell,
    receiptsWhile,
  };
});

describe("AutonomousScheduleReactor", () => {
  it.effect("starts a run when an enabled entry names the minute", () =>
    Effect.gen(function* () {
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.setSchedule([entry()]);

      const seen = yield* run.receiptsWhile(1, run.reactor.runDueAt(MONDAY_0900));
      expect(seen.map((receipt) => receipt.type)).toEqual(["autonomous.schedule.fired"]);

      const project = yield* run.projectShell();
      expect(Option.isSome(project) && project.value.autonomousStartedAt != null).toBe(true);
      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(makeHarness())),
  );

  it.effect("leaves a minute no entry names alone", () =>
    Effect.gen(function* () {
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.setSchedule([
        entry({ id: "weekdays", daysOfWeek: [1, 2, 3, 4, 5] }),
        entry({ id: "disabled", enabled: false }),
      ]);

      // Right time, wrong day for the weekday entry; the disabled one never
      // fires at all.
      yield* run.reactor.runDueAt(SATURDAY_0900);
      // One minute later on a day both entries would otherwise accept.
      yield* run.reactor.runDueAt(at(2026, 3, 2, 9, 1));

      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(makeHarness())),
  );

  it.effect("does not touch a project whose run is already live", () =>
    Effect.gen(function* () {
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.setSchedule([entry()]);
      yield* run.enableAutonomous();

      yield* run.reactor.runDueAt(MONDAY_0900);

      // Only the manual enable. A schedule firing into a live run is a no-op,
      // so the run that is working now is never restarted under it.
      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(makeHarness())),
  );

  it.effect("fires a slot once even if the same minute is evaluated twice", () =>
    Effect.gen(function* () {
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.setSchedule([entry()]);

      yield* run.reactor.runDueAt(MONDAY_0900);
      // The run ends (or a user stops it) inside the same minute, and the
      // process restarts: the slot's command id is already accepted, so
      // re-evaluating the minute cannot start a second run.
      yield* run.disableAutonomous();
      yield* run.reactor.runDueAt(MONDAY_0900);

      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(1);

      // The next day's slot is a different command, so the schedule keeps
      // working after the repeat.
      yield* run.reactor.runDueAt(at(2026, 3, 3, 9, 0));
      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(makeHarness())),
  );

  it.effect("fires every project that names the minute, once each", () =>
    Effect.gen(function* () {
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.createProject(OTHER_PROJECT_ID);
      // Two entries on one project can name the same minute; the run they ask
      // for is the same run.
      yield* run.setSchedule([entry(), entry({ id: "also-morning", daysOfWeek: [1] })]);
      yield* run.setSchedule([entry({ id: "other" })], OTHER_PROJECT_ID);

      yield* run.reactor.runDueAt(MONDAY_0900);

      const enabled = yield* run.eventsOfType("project.autonomous-enabled");
      expect(enabled.map((event) => event.aggregateId).toSorted()).toEqual([
        PROJECT_ID,
        OTHER_PROJECT_ID,
      ]);
    }).pipe(Effect.scoped, Effect.provide(makeHarness())),
  );

  it.effect("never fires the minute it started in, only the next boundary", () =>
    Effect.gen(function* () {
      // Half a minute into 09:00, which is exactly the slot a restart must not
      // replay.
      yield* TestClock.setTime(at(2026, 3, 2, 9, 0, 30).getTime());
      const run = yield* bootSchedule();
      yield* run.createProject();
      yield* run.setSchedule([
        entry({ id: "already-passed" }),
        entry({ id: "next-minute", time: localTimeOfDay(at(2026, 3, 2, 9, 1)) }),
      ]);

      yield* run.reactor.start();
      const seen = yield* run.receiptsWhile(1, TestClock.adjust(Duration.seconds(30)));

      // The 09:00 slot is gone: the ticker's first evaluation is the 09:01
      // boundary it slept to.
      expect(seen).toEqual([
        {
          type: "autonomous.schedule.fired",
          projectId: PROJECT_ID,
          entryId: "next-minute",
          createdAt: seen[0]?.createdAt ?? "",
        },
      ]);
      expect(yield* run.eventsOfType("project.autonomous-enabled")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(makeHarness()), Effect.provide(TestClock.layer())),
  );
});
