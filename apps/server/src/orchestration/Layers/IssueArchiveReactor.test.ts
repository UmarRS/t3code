import { ISSUE_ARCHIVE_AFTER_MS, IssueId, type OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { IssueArchiveReactor } from "../Services/IssueArchiveReactor.ts";
import { IssueArchiveReactorLive } from "./IssueArchiveReactor.ts";

const ISSUE_A = IssueId.make("issue-a");
/** Finished at the same instant as A, so both fall due on the same tick. */
const ISSUE_B = IssueId.make("issue-b");
const FINISHED_AT = "2026-08-16T04:10:00.000Z";
/** Exactly one archive threshold after `FINISHED_AT`. */
const DUE_AT = DateTime.formatIso(
  DateTime.makeUnsafe(Date.parse(FINISHED_AT) + ISSUE_ARCHIVE_AFTER_MS),
);

function createHarness(options?: {
  readonly due?: ReadonlyArray<{ readonly issueId: IssueId; readonly updatedAt: string }>;
  readonly dueFails?: boolean;
  readonly dispatchFails?: boolean;
}) {
  const cutoffs: string[] = [];
  const listIssuesDueForArchive = vi.fn((cutoff: string) => {
    cutoffs.push(cutoff);
    return options?.dueFails === true
      ? Effect.die(new Error("projection unavailable"))
      : Effect.succeed(options?.due ?? []);
  });
  const dispatched: OrchestrationCommand[] = [];
  const dispatch = vi.fn((command: OrchestrationCommand) => {
    dispatched.push(command);
    return options?.dispatchFails === true
      ? Effect.die(new Error("dispatch blew up"))
      : Effect.succeed({ sequence: 7 });
  });

  const layer = IssueArchiveReactorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({ listIssuesDueForArchive }),
        Layer.mock(OrchestrationEngineService)({ dispatch }),
      ),
    ),
  );

  const runDueAt = (at: string) =>
    Effect.flatMap(Effect.service(IssueArchiveReactor), (reactor) =>
      reactor.runDueAt(DateTime.toDate(DateTime.makeUnsafe(at))),
    ).pipe(Effect.provide(layer));

  return { runDueAt, listIssuesDueForArchive, dispatch, dispatched, cutoffs };
}

describe("IssueArchiveReactor", () => {
  it.effect("archives an issue whose day in done has elapsed", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [{ issueId: ISSUE_A, updatedAt: FINISHED_AT }] });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(1);
      expect(harness.dispatched).toEqual([
        {
          type: "issue.status.set",
          commandId: `issue-archive:${ISSUE_A}:${FINISHED_AT}`,
          issueId: ISSUE_A,
          status: "archived",
        },
      ]);
    }),
  );

  // Everything not-yet-due, canceled, still in flight, or soft-deleted is
  // filtered by the projection query's own predicate; the reactor's contract is
  // that it asks for exactly the threshold-old cutoff and files nothing else.
  it.effect("asks for the issues finished a full threshold ago", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [] });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
      expect(harness.cutoffs).toEqual([FINISHED_AT]);
      expect(harness.dispatch).not.toHaveBeenCalled();
    }),
  );

  it.effect("archives every due issue on one tick", () =>
    Effect.gen(function* () {
      const harness = createHarness({
        due: [
          { issueId: ISSUE_A, updatedAt: FINISHED_AT },
          { issueId: ISSUE_B, updatedAt: FINISHED_AT },
        ],
      });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(2);
      expect(harness.dispatch).toHaveBeenCalledTimes(2);
    }),
  );

  // The decider makes re-setting the status a no-op, and the command id is
  // derived from the updatedAt being filed — so a tick that runs twice over the
  // same rows produces the same one command, not a second archive.
  it.effect("dispatches the same command id when a tick repeats", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [{ issueId: ISSUE_A, updatedAt: FINISHED_AT }] });

      yield* harness.runDueAt(DUE_AT);
      yield* harness.runDueAt(DUE_AT);

      expect(harness.dispatched).toHaveLength(2);
      expect(harness.dispatched[0]).toEqual(harness.dispatched[1]);
    }),
  );

  it.effect("gives a later trip through done its own command id", () =>
    Effect.gen(function* () {
      const reFinishedAt = "2026-08-16T09:00:00.000Z";
      const harness = createHarness({ due: [{ issueId: ISSUE_A, updatedAt: reFinishedAt }] });

      yield* harness.runDueAt(DUE_AT);

      expect(harness.dispatched[0]).toMatchObject({
        commandId: `issue-archive:${ISSUE_A}:${reFinishedAt}`,
      });
    }),
  );

  it.effect("survives a projection read that fails", () =>
    Effect.gen(function* () {
      const harness = createHarness({ dueFails: true });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
    }),
  );

  it.effect("survives a dispatch that fails, so one bad issue cannot stop the ticker", () =>
    Effect.gen(function* () {
      const harness = createHarness({
        due: [{ issueId: ISSUE_A, updatedAt: FINISHED_AT }],
        dispatchFails: true,
      });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
    }),
  );
});
