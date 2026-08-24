import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Park a thread whose work has landed on the base branch.
 *
 * A merge is the end of a thread's story: the change is on main, the pull
 * request is closed, and nobody is waiting on anybody. Leaving such a thread in
 * the active list is what makes a board that runs itself unreadable — a worker
 * and a reviewer per issue, all of them finished, burying the one thread that
 * still needs a human.
 *
 * Settling is the same park a user performs by hand, dispatched by the server:
 * the thread stays readable, un-settling brings it back, and the worktree sweep
 * starts counting from here. Deliberately not an archive — merged is not the
 * same as unwanted, and the next turn on the thread un-settles it by itself.
 *
 * Best-effort by construction. The decider refuses to settle a thread that is
 * running, holding an approval, or about to start a turn, and that refusal is
 * the right answer: someone re-engaged the thread after the merge, so it is no
 * longer finished work. None of that is a failure of the ship that called it.
 *
 * Takes its services as values rather than from the Effect context so the
 * reactors that call it keep requirement-free event loops.
 */
export const makeSettleMergedThread = (services: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}) =>
  Effect.fn("settleMergedThread")(function* (input: {
    readonly threadId: ThreadId;
    /** Names the merge being settled, so one merge dispatches one settle. */
    readonly mergeKey: string;
  }) {
    const threadOption = yield* services.projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(threadOption)) return;
    const thread = threadOption.value;
    // An archived thread is already out of the way and a settled one has
    // nowhere further to go: either way the dispatch would only be noise.
    if (thread.archivedAt !== null || thread.settledOverride === "settled") return;

    const settled = yield* services.orchestrationEngine
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-after-merge:${input.mergeKey}:${input.threadId}`),
        threadId: input.threadId,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logDebug("merged work was not settled", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
    if (!settled) return;

    // The same cleanup an interactive settle performs: a parked thread must
    // not keep a provider session alive behind it. `onlyIfSettled` is what
    // makes that safe — if the thread was re-engaged between the two commands,
    // the decider drops the stop instead of killing the new session.
    if (thread.session === null || thread.session.status === "stopped") return;
    yield* services.orchestrationEngine
      .dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`settle-after-merge-stop:${input.mergeKey}:${input.threadId}`),
        threadId: input.threadId,
        createdAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
        onlyIfSettled: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("merged work kept its provider session", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });
