import {
  CommandId,
  EventId,
  isSessionParkedForResume,
  THREAD_AUTO_SHIP_ACTIVITY_KIND,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadAutoShipActivityPayload,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { forkParked } from "../../serverActivation.ts";
import { makeSettleMergedThread } from "../settleMergedWork.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { AutoShipReactor, type AutoShipReactorShape } from "../Services/AutoShipReactor.ts";

/**
 * The auto-ship loop.
 *
 * One queue, drained serially. A ship is commit → push → pull request → merge,
 * and it runs on two occasions: a turn on an auto-ship thread ended, or the
 * switch was just turned on for a thread that is already idle. The second is
 * what makes the toggle answerable — flipping it on ships the work already in
 * the worktree instead of waiting for a turn the user may never send.
 *
 * A server restart is deliberately *not* one of those occasions. Auto-ship
 * ships at the end of a turn; a boot is not a turn end, and sweeping every
 * auto-ship thread on startup would open pull requests nobody was watching for.
 * Work stranded by a restart ships at the end of the next turn — the shippable
 * check still sees it, and the pull-request step reuses the branch's open PR.
 */

/** The same stacked action the composer's pull-request button runs. */
const AUTO_SHIP_ACTION = "commit_push_pr" as const;

type ShipItem = { readonly threadId: ThreadId };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const receipts = yield* RuntimeReceiptBus;

  const settleMergedThread = makeSettleMergedThread({
    orchestrationEngine,
    projectionSnapshotQuery,
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`auto-ship:${tag}:${uuid}`)));

  /** Threads whose ship is running right now, so a second trigger does not start a second one. */
  const shipsInFlight = new Set<string>();

  /**
   * Auto-ship's only way of talking to the user. It writes to the thread's own
   * timeline rather than to a toast or a log, because the thread is where the
   * work is and where someone will look to find out what happened to it.
   */
  const appendActivity = Effect.fn("appendActivity")(function* (
    thread: OrchestrationThreadShell,
    summary: string,
    payload: ThreadAutoShipActivityPayload,
  ) {
    const createdAt = yield* nowIso;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("activity"),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: payload.outcome === "merged" ? "info" : "error",
          kind: THREAD_AUTO_SHIP_ACTIVITY_KIND,
          summary,
          payload,
          // The turn is over by the time a ship reports, so it hangs off the
          // turn it shipped rather than floating loose at the end of the log.
          turnId: thread.latestTurn?.turnId ?? null,
          createdAt,
        },
        createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const reportFailure = Effect.fn("reportFailure")(function* (
    thread: OrchestrationThreadShell,
    summary: string,
    detail: string,
    pullRequestUrl?: string,
  ) {
    yield* appendActivity(thread, summary, {
      outcome: pullRequestUrl === undefined ? "failed" : "opened",
      ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
      detail: detail.slice(0, 2_000),
    });
    yield* receipts.publish({
      type: "thread.auto-ship.failed",
      threadId: thread.id,
      reason: detail,
      createdAt: yield* nowIso,
    });
  });

  const skip = Effect.fn("skip")(function* (threadId: ThreadId, reason: string) {
    yield* receipts.publish({
      type: "thread.auto-ship.skipped",
      threadId,
      reason,
      createdAt: yield* nowIso,
    });
  });

  /**
   * One thread's ship. Re-reads the thread rather than trusting the queued
   * item: the switch may have been turned off, or the thread archived, between
   * the trigger and this running.
   */
  const shipThread = Effect.fn("shipThread")(function* (threadId: ThreadId) {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(threadOption)) return;
    const thread = threadOption.value;
    if (thread.autoShipEnabledAt == null) {
      yield* skip(threadId, "Auto-ship was turned off before the ship started.");
      return;
    }
    const cwd = thread.worktreePath;
    if (cwd === null) {
      yield* reportFailure(
        thread,
        "Auto-ship could not run",
        "This thread has no worktree, so it has no branch to ship.",
      );
      return;
    }

    // The agent may have committed or even pushed this branch itself during
    // the turn. Recover that state before measuring the commit range: a stale
    // local base is what makes already-delivered work look shippable again.
    yield* gitWorkflow.invalidateStatus(cwd);

    // Failing to resolve the base is not a reason to strand work: fall back to
    // the same default the pull-request step falls back to.
    const baseBranch = yield* gitWorkflow.resolveBaseBranch({ cwd }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("auto-ship base branch resolution failed", {
          threadId,
          cwd,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as("main")),
      ),
    );

    // Most turns change nothing — a question answered, a file read. Asking a
    // provider to open a pull request for an empty range fails, and reporting
    // that as a failed ship would call every ordinary turn broken.
    //
    // A probe that cannot answer falls through to the normal path: it must
    // never be the reason real work is stranded.
    const shippable = yield* gitWorkflow.hasShippableWork({ cwd, baseBranch }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("auto-ship shippable-work check failed", {
          threadId,
          cwd,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(true)),
      ),
    );
    if (!shippable) {
      yield* skip(threadId, "The turn left nothing to ship.");
      return;
    }

    // The same server-side action the PR button runs, so there is one
    // implementation of commit/push/PR rather than a second one for robots.
    const actionId = `auto-ship:${threadId}:${yield* crypto.randomUUIDv4}`;
    const opened = yield* gitWorkflow
      .runStackedAction({ actionId, cwd, action: AUTO_SHIP_ACTION })
      .pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
    if (!opened.ok) {
      yield* reportFailure(thread, "Auto-ship could not open a pull request", opened.message);
      return;
    }

    const pullRequestUrl = opened.value.pr.url ?? null;
    const reference = pullRequestUrl ?? opened.value.pr.number?.toString() ?? null;
    if (reference === null) {
      yield* reportFailure(
        thread,
        "Auto-ship could not open a pull request",
        "The commit/push/PR run finished without producing a pull request.",
      );
      return;
    }

    const merged = yield* gitWorkflow.mergePullRequest({ cwd, reference }).pipe(
      Effect.as({ ok: true as const }),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    );
    if (!merged.ok) {
      // The work is on the remote and the pull request is open; only the merge
      // was refused. Say so, and hand over the link rather than the failure.
      yield* reportFailure(
        thread,
        "Auto-ship opened a pull request but could not merge it",
        merged.message,
        pullRequestUrl ?? reference,
      );
      return;
    }

    yield* appendActivity(thread, "Auto-ship merged this thread's work", {
      outcome: "merged",
      ...(pullRequestUrl === null ? {} : { pullRequestUrl }),
    });
    // The work has landed, so the thread is done until someone gives it more
    // to do. Settled after the activity, never before: the timeline entry is
    // the record of what happened, and it must be there when the thread parks.
    yield* settleMergedThread({ threadId, mergeKey: reference });
    yield* receipts.publish({
      type: "thread.auto-ship.completed",
      threadId,
      pullRequestUrl,
      createdAt: yield* nowIso,
    });
  });

  const shipQueue = yield* makeDrainableWorker((item: ShipItem) =>
    shipThread(item.threadId).pipe(
      Effect.ensuring(Effect.sync(() => shipsInFlight.delete(item.threadId))),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("auto-ship failed to ship a thread", {
          threadId: item.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const enqueueShip = Effect.fn("enqueueShip")(function* (threadId: ThreadId) {
    if (shipsInFlight.has(threadId)) return;
    shipsInFlight.add(threadId);
    yield* shipQueue.enqueue({ threadId });
  });

  /**
   * Whether a thread is in a state a ship may run from: auto-ship on, nothing
   * running, and nothing waiting on the user. A thread holding a pending
   * approval has not finished its turn, whatever its session says.
   */
  const readyToShip = (thread: OrchestrationThreadShell): boolean =>
    thread.autoShipEnabledAt != null &&
    thread.archivedAt === null &&
    thread.worktreePath !== null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput;

  const handleTurnEnd = Effect.fn("handleTurnEnd")(function* (
    threadId: ThreadId,
    sessionStatus: string,
  ) {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(threadOption)) return;
    if (!readyToShip(threadOption.value)) return;
    // An errored session did not finish what it started. Its partial work is
    // exactly the kind a human should look at before it lands. Checked after
    // `readyToShip` so the skip receipt is only published for the threads
    // auto-ship actually owns — session events are global.
    if (sessionStatus === "error") {
      yield* skip(threadId, "The session ended in an error, so nothing was shipped.");
      return;
    }
    yield* enqueueShip(threadId);
  });

  /**
   * The switch was just turned on. Ship what is already there, unless a turn is
   * running — that turn's end will trigger the ship itself, and shipping
   * mid-turn would race the agent's own writes.
   */
  const handleAutoShipEnabled = Effect.fn("handleAutoShipEnabled")(function* (threadId: ThreadId) {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(threadOption)) return;
    const thread = threadOption.value;
    if (!readyToShip(thread)) return;
    const status = thread.session?.status ?? null;
    if (status === "starting" || status === "running") return;
    yield* enqueueShip(threadId);
  });

  const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.auto-ship-set") {
      if (event.payload.autoShipEnabledAt === null) return;
      yield* handleAutoShipEnabled(event.payload.threadId);
      return;
    }
    if (event.type !== "thread.session-set") return;
    // A session parked on a provider limit has not finished its turn — the
    // server restarts it when the limit lifts. Shipping there would land half
    // the work the user asked for.
    if (isSessionParkedForResume(event.payload.session)) return;
    const status = event.payload.session.status;
    // Only a session that has left "running" marks the end of a turn.
    if (status === "starting" || status === "running") return;
    yield* handleTurnEnd(event.payload.threadId, status);
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("auto-ship reactor failed to process an event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: AutoShipReactorShape["start"] = Effect.fn("start")(function* () {
    // Same split as the autonomous run reactor: the domain stream is hot, so
    // an eager fiber buffers events from the moment `start` returns, while the
    // consumer that acts on them stays parked until activation.
    const subscribed = yield* Deferred.make<void>();
    const buffered = yield* Queue.unbounded<OrchestrationEvent>();
    yield* Effect.forkScoped(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          Stream.onStart(Deferred.succeed(subscribed, undefined)),
        ),
        (event) => Queue.offer(buffered, event).pipe(Effect.asVoid),
      ),
    );
    yield* forkParked(
      Queue.take(buffered).pipe(Effect.flatMap(processEventSafely), Effect.forever),
    );
    yield* Deferred.await(subscribed);
  });

  return {
    start,
    drain: shipQueue.drain,
  } satisfies AutoShipReactorShape;
});

export const AutoShipReactorLive = Layer.effect(AutoShipReactor, make);
