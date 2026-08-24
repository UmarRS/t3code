/**
 * AutoShipReactor - landing a thread's work without a review step.
 *
 * Auto-ship is a per-thread switch. While it is on, every turn that ends
 * having changed the codebase is committed, pushed, opened as a pull request
 * and merged, in that order, with nobody asked to look at it in between. It is
 * the deliberate opposite of autonomous mode's merge queue: no reviewer thread,
 * no verdict, no board — the user said this thread's work ships, so it ships.
 *
 * @module AutoShipReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface AutoShipReactorShape {
  /**
   * Start reacting to turn ends. The returned effect must be run in a scope so
   * the ship worker is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the ship queue is empty and idle. Tests wait on this instead
   * of sleeping: a ship is dispatched from a turn end, so there is no other
   * moment at which "the ship has finished" is observable from outside.
   */
  readonly drain: Effect.Effect<void>;
}

export class AutoShipReactor extends Context.Service<AutoShipReactor, AutoShipReactorShape>()(
  "t3/orchestration/Services/AutoShipReactor",
) {}
