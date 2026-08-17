import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import { ModelFailoverService } from "../Services/ModelFailover.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  LimitResumeReactor,
  type LimitResumeReactorShape,
} from "../Services/LimitResumeReactor.ts";

/**
 * Resuming threads parked on a provider limit.
 *
 * The ticker's whole job is to wake each minute and ask which parked sessions
 * are due. What keeps that safe is mostly what it does not do:
 *
 * - It resumes one thread at a time. A machine that slept through several
 *   resets wakes up owing many restarts, and firing them together would hand
 *   the freshly-reset account a thundering herd of turns.
 * - It cannot resume the same park twice. Restarting stops the session first,
 *   which clears `resumeAt`, so a thread stops being due the moment it is
 *   picked up — a raced tick or a restart finds nothing left to do.
 * - It never invents work. Resuming restarts the thread's own last user turn on
 *   the thread's own model; a thread with nothing to restart is left parked for
 *   a human.
 *
 * A minute the server slept through is deliberately *not* skipped here (unlike
 * the schedule ticker): a limit that lifted while the machine was asleep is
 * still lifted, and the parked work is still waiting.
 */

const MINUTE_MS = 60_000;

const make = Effect.gen(function* () {
  const modelFailover = yield* ModelFailoverService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const resumeDue = Effect.fn("resumeDue")(function* (at: Date) {
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(at));
    const threadIds = yield* projectionSnapshotQuery.listThreadIdsDueForResume(nowIso);
    let resumed = 0;
    for (const threadId of threadIds) {
      const restart = yield* modelFailover.resumeParkedThread({ threadId, createdAt: nowIso });
      if (restart.resumed) {
        resumed += 1;
      }
    }
    return resumed;
  });

  const runDueAt: LimitResumeReactorShape["runDueAt"] = (at) =>
    resumeDue(at).pipe(
      Effect.catch((error) =>
        Effect.logWarning("limit resume could not read parked sessions", {
          error: error.message,
        }).pipe(Effect.as(0)),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("limit resume tick failed", { defect }).pipe(Effect.as(0)),
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

  const start: LimitResumeReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(Effect.forever(tick));
  });

  return {
    start,
    runDueAt,
  } satisfies LimitResumeReactorShape;
});

export const LimitResumeReactorLive = Layer.effect(LimitResumeReactor, make);
