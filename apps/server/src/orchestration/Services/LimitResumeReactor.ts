/**
 * LimitResumeReactor - picking parked work back up when a provider limit lifts.
 *
 * A turn that failed because the account ran out of capacity parks its session
 * with the instant the provider said the limit resets. This reactor owns the
 * one ticker that wakes on each minute boundary, asks which parked sessions are
 * due, and restarts each one's interrupted turn on its own model — so the work
 * continues in the same provider session rather than waiting on a human.
 *
 * @module LimitResumeReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface LimitResumeReactorShape {
  /**
   * Start the minute ticker. The returned effect must be run in a scope so the
   * ticker is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resume every session parked for an instant at or before `at`, and answer
   * how many threads actually restarted. Unlike the schedule ticker this does
   * look backwards: a limit that lifted while the machine was asleep is still
   * lifted, so a park the server slept through resumes on the next tick rather
   * than being dropped. Tests call this directly to name an instant instead of
   * waiting for one.
   */
  readonly runDueAt: (at: Date) => Effect.Effect<number>;
}

export class LimitResumeReactor extends Context.Service<
  LimitResumeReactor,
  LimitResumeReactorShape
>()("t3/orchestration/Services/LimitResumeReactor") {}
