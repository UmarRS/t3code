/**
 * AutonomousScheduleReactor - starting autonomous runs at the times a project
 * asked for.
 *
 * Owns one ticker that wakes on every minute boundary, compares the server's
 * own wall clock against each project's schedule, and dispatches the same
 * `project.autonomous.enable` the toggle in the UI sends. Nothing else about a
 * run changes: a scheduled run finishes and disables itself through the
 * ordinary completion path.
 *
 * @module AutonomousScheduleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface AutonomousScheduleReactorShape {
  /**
   * Start the minute ticker. The returned effect must be run in a scope so the
   * ticker is finalized on shutdown. Nothing fires for the minute in progress
   * when this is called: a slot the server slept through is a slot it missed.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Fire every entry due at `at`, read in the server's own timezone. The ticker
   * calls this once per minute boundary; tests call it directly to name an
   * instant instead of waiting for one.
   */
  readonly runDueAt: (at: Date) => Effect.Effect<void>;
}

export class AutonomousScheduleReactor extends Context.Service<
  AutonomousScheduleReactor,
  AutonomousScheduleReactorShape
>()("t3/orchestration/Services/AutonomousScheduleReactor") {}
