/**
 * IssueArchiveReactor - filing finished issues away once they stop moving.
 *
 * A board that keeps every issue it ever finished stops being a board. This
 * reactor owns the one ticker that wakes on each minute boundary, asks which
 * `done` issues have sat untouched for `ISSUE_ARCHIVE_AFTER_MS`, and moves
 * each to `archived` with the same `issue.status.set` the status menu sends —
 * so an automatic archive is indistinguishable from a hand one, and a user can
 * pull the issue straight back out.
 *
 * @module IssueArchiveReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface IssueArchiveReactorShape {
  /**
   * Start the minute ticker. The returned effect must be run in a scope so the
   * ticker is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Archive every issue whose day in `done` had elapsed by `at`, and answer how
   * many were dispatched. Unlike the schedule ticker this does look backwards:
   * a deadline that passed while the machine was asleep still passed, so a day
   * that elapsed over a shutdown archives on the first tick after boot rather
   * than being dropped. Tests call this directly to name an instant instead of
   * waiting a day for one.
   */
  readonly runDueAt: (at: Date) => Effect.Effect<number>;
}

export class IssueArchiveReactor extends Context.Service<
  IssueArchiveReactor,
  IssueArchiveReactorShape
>()("t3/orchestration/Services/IssueArchiveReactor") {}
