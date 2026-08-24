import {
  autonomousScheduleSlotKey,
  CommandId,
  reachableAutonomousProjectIds,
  scheduleEntriesDueAt,
  type OrchestrationIssue,
  type ProjectAutonomousScheduleEntry,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import {
  AutonomousScheduleReactor,
  type AutonomousScheduleReactorShape,
} from "../Services/AutonomousScheduleReactor.ts";

/**
 * Scheduled autonomous runs.
 *
 * A schedule is a list of wall-clock times, so the ticker's only job is to wake
 * on each minute boundary and ask which entries name that minute. What makes
 * this safe is mostly what it does not do:
 *
 * - It never looks backwards. A minute the server slept through is gone, which
 *   is what "missed slots are skipped" means in practice: a machine that was
 *   asleep at 09:00 does not start a run when it wakes at 14:00.
 * - It never starts a second run. A project with a live run is left alone, so a
 *   schedule firing while yesterday's run is still working is a no-op.
 * - It fires each slot once. The enable it dispatches carries a command id
 *   derived from the project, the date and the entry, and command receipts are
 *   persisted — so a restart inside the same minute re-decides nothing.
 *
 * Starting a run is the same command the toggle in the UI sends, which is what
 * makes a scheduled run indistinguishable from a manual one from here on: it
 * finishes and disables itself through the ordinary completion path.
 */

const MINUTE_MS = 60_000;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * The other boards this board's plan depends on, which a scheduled run starts
   * alongside it for exactly the reason the manual switch does: a board that
   * ticks while a board it waits on is still off gives up on that work and
   * flags it. A schedule has nobody watching to notice, so it needs this more
   * than the switch does, not less.
   */
  const additionalProjectIdsFor = Effect.fn("additionalProjectIdsFor")(function* (
    projectId: ProjectId,
  ) {
    const issues = yield* projectionSnapshotQuery
      .listIssues()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<OrchestrationIssue>));
    return [...reachableAutonomousProjectIds(issues, projectId)].filter(
      (candidate) => candidate !== projectId,
    );
  });

  const startRunForEntry = Effect.fn("startRunForEntry")(function* (
    projectId: ProjectId,
    entry: ProjectAutonomousScheduleEntry,
    at: Date,
  ) {
    const createdAt = yield* nowIso;
    const started = yield* orchestrationEngine
      .dispatch({
        type: "project.autonomous.enable",
        // Deterministic: the same slot dispatched twice is one accepted
        // command, whether the repeat comes from a restart or a raced tick.
        commandId: CommandId.make(autonomousScheduleSlotKey(projectId, entry, at)),
        projectId,
        additionalProjectIds: yield* additionalProjectIdsFor(projectId),
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("autonomous schedule could not start a run", {
            projectId,
            entryId: entry.id,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!started) return;
    yield* receipts.publish({
      type: "autonomous.schedule.fired",
      projectId,
      entryId: entry.id,
      createdAt,
    });
  });

  const evaluateMinute = Effect.fn("evaluateMinute")(function* (at: Date) {
    const projects = yield* projectionSnapshotQuery.listScheduledProjects();
    for (const project of projects) {
      // A live run owns the project until it finishes. Re-enabling it would be
      // harmless, but it would make a schedule look like it restarted work it
      // never touched.
      if (project.autonomousStartedAt != null) continue;
      // Two entries can name the same minute (different weekday rules landing
      // on the same day). One of them starts the run; the rest are satisfied
      // by it.
      const [due] = scheduleEntriesDueAt(project.autonomousSchedule, at);
      if (due === undefined) continue;
      yield* startRunForEntry(project.projectId, due, at);
    }
  });

  const runDueAt: AutonomousScheduleReactorShape["runDueAt"] = (at) =>
    evaluateMinute(at).pipe(
      Effect.catch((error) =>
        Effect.logWarning("autonomous schedule could not read projects", {
          error: error.message,
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("autonomous schedule tick failed", { defect }),
      ),
    );

  /**
   * Wake on each minute boundary. The evaluated instant is pinned to the
   * boundary the sleep aimed at, so a wake-up that lands a hair early still
   * evaluates the minute it meant to and the ticker always moves forward.
   */
  const tick = Effect.gen(function* () {
    const startedAtMs = yield* Clock.currentTimeMillis;
    const boundaryMs = Math.floor(startedAtMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    yield* Effect.sleep(Duration.millis(boundaryMs - startedAtMs));
    const wokeAtMs = yield* Clock.currentTimeMillis;
    yield* runDueAt(DateTime.toDate(DateTime.makeUnsafe(Math.max(wokeAtMs, boundaryMs))));
  });

  const start: AutonomousScheduleReactorShape["start"] = Effect.fn("start")(function* () {
    // The minute in progress is deliberately not evaluated: whatever it held
    // already passed while the server was down.
    yield* forkParked(Effect.forever(tick));
  });

  return {
    start,
    runDueAt,
  } satisfies AutonomousScheduleReactorShape;
});

export const AutonomousScheduleReactorLive = Layer.effect(AutonomousScheduleReactor, make);
