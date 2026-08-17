import { CommandId, ISSUE_ARCHIVE_AFTER_MS, type IssueId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  IssueArchiveReactor,
  type IssueArchiveReactorShape,
} from "../Services/IssueArchiveReactor.ts";

/**
 * Filing finished issues away.
 *
 * The ticker's whole job is to wake each minute and ask which `done` issues
 * have gone a day without being touched. What keeps that safe is mostly what it
 * does not do:
 *
 * - It invents no new kind of move. Archiving is the ordinary
 *   `issue.status.set` the card's own status menu sends, so the event, the
 *   projection and the board update are the ones a human archive would produce
 *   — and pulling an issue back out is just another status set.
 * - It cannot archive the same `done` twice. The command id names the issue
 *   *and* the `updatedAt` being filed, so a raced tick or a restart inside the
 *   same minute re-decides nothing. Even without that, the decider makes
 *   re-setting a status the issue already has a no-op that re-emits the
 *   existing `updatedAt` — so the sweep is idempotent twice over, and a repeat
 *   cannot push an issue's archive deadline out from under itself.
 * - It never revives work. Only `done` is due; `canceled` is an abandoned
 *   decision a human may still want to revisit where they left it, and deleted
 *   issues are filtered in SQL.
 *
 * A minute the server slept through is deliberately *not* skipped here (unlike
 * the schedule ticker): a day that elapsed while the machine was down still
 * elapsed, so a backlog of finished work archives on the first tick after boot
 * rather than waiting another day.
 */

const MINUTE_MS = 60_000;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const archiveIssue = Effect.fn("archiveIssue")(function* (issueId: IssueId, updatedAt: string) {
    return yield* orchestrationEngine
      .dispatch({
        type: "issue.status.set",
        // Deterministic: the same finished issue dispatched twice is one
        // accepted command. Keyed on the `updatedAt` being archived so a later
        // trip back through `done` gets its own id rather than colliding with
        // this one.
        commandId: CommandId.make(`issue-archive:${issueId}:${updatedAt}`),
        issueId,
        status: "archived",
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("issue archive could not file an issue away", {
            issueId,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
  });

  const archiveDue = Effect.fn("archiveDue")(function* (at: Date) {
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(at.getTime() - ISSUE_ARCHIVE_AFTER_MS));
    const issues = yield* projectionSnapshotQuery.listIssuesDueForArchive(cutoff);
    let archived = 0;
    for (const issue of issues) {
      if (yield* archiveIssue(issue.issueId, issue.updatedAt)) {
        archived += 1;
      }
    }
    return archived;
  });

  const runDueAt: IssueArchiveReactorShape["runDueAt"] = (at) =>
    archiveDue(at).pipe(
      Effect.catch((error) =>
        Effect.logWarning("issue archive could not read finished issues", {
          error: error.message,
        }).pipe(Effect.as(0)),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("issue archive tick failed", { defect }).pipe(Effect.as(0)),
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

  const start: IssueArchiveReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(Effect.forever(tick));
  });

  return {
    start,
    runDueAt,
  } satisfies IssueArchiveReactorShape;
});

export const IssueArchiveReactorLive = Layer.effect(IssueArchiveReactor, make);
