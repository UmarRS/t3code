/**
 * AutonomousRunReactor - working a project's backlog without a human.
 *
 * Owns the loop behind autonomous mode: start every startable issue in
 * parallel, open a pull request when each worker finishes, review and merge
 * those pull requests one at a time, and stop when nothing is left to advance.
 *
 * @module AutonomousRunReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface AutonomousRunReactorShape {
  /**
   * Start reacting to the domain events that can change what a run should be
   * doing. The returned effect must be run in a scope so worker fibers are
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when both internal queues are empty and idle. Tests use this
   * instead of sleeping: the evaluation queue settles once every startable
   * issue has been started, and the merge queue once every review it owns has
   * been dispatched.
   */
  readonly drain: Effect.Effect<void>;
}

export class AutonomousRunReactor extends Context.Service<
  AutonomousRunReactor,
  AutonomousRunReactorShape
>()("t3/orchestration/Services/AutonomousRunReactor") {}
