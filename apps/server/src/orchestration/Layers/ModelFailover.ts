import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivityTone,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  claudeBackupModelSelection,
  CODEX_BACKUP_INSTANCE_ID,
} from "../../provider/claudeBackupModels.ts";
import {
  classifyProviderExhaustion,
  describeProviderExhaustionKind,
  parseProviderExhaustionResetAt,
  type ProviderExhaustionKind,
} from "../../provider/providerExhaustion.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ModelFailoverService,
  type ModelFailoverShape,
  type ProviderExhaustionRecovery,
} from "../Services/ModelFailover.ts";

/** Activity kind projected into the thread timeline when a failover happens. */
export const MODEL_FAILOVER_ACTIVITY_KIND = "model.failover";

/** Activity kind projected when a thread parks to wait for a limit to lift. */
export const LIMIT_PARKED_ACTIVITY_KIND = "model.limit.parked";

/** Activity kind projected when a parked thread picks its work back up. */
export const LIMIT_RESUMED_ACTIVITY_KIND = "model.limit.resumed";

const MAX_RECORDED_FAILOVER_DETAIL_CHARS = 600;

// A provider that claims its limit lifts more than a day out is either wrong or
// quoting a window we should not silently sit on; those fall through to the
// backup model (or, with no backup, to the ordinary needs-attention path).
const MAX_PARK_MS = 25 * 60 * 60 * 1000;

interface FailoverRecord {
  readonly fromModel: string;
  readonly toModel: string;
  readonly kind: ProviderExhaustionKind;
  readonly at: string;
}

function truncateDetail(value: string): string {
  return value.length > MAX_RECORDED_FAILOVER_DETAIL_CHARS
    ? `${value.slice(0, MAX_RECORDED_FAILOVER_DETAIL_CHARS - 3)}...`
    : value;
}

const NO_RECOVERY: ProviderExhaustionRecovery = { kind: "none" };
const NOT_RESUMED = { resumed: false, sequence: 0 } as const;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  // Per-thread failover memory for the current attempt. Written when a
  // failover restart is dispatched; read to (a) suppress a concurrent second
  // failover and (b) enrich a subsequent backup failure with both attempts.
  // In-memory on purpose: the durable record is the timeline activity.
  const failoverRecords = new Map<ThreadId, FailoverRecord>();
  const recoveryInFlight = new Set<ThreadId>();

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const isRecoverableThread = (
    thread: OrchestrationThread | undefined,
  ): thread is OrchestrationThread =>
    thread !== undefined && thread.deletedAt === null && thread.archivedAt === null;

  /**
   * Release a possibly still-registered provider session so the next turn binds
   * cleanly, and clear any park the thread was holding. The resume cursor lives
   * on the persisted binding rather than the session, so a same-model turn
   * started after this reattaches the provider's own conversation and continues
   * where the interrupted turn was cut off.
   */
  const stopSession = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly tag: string;
  }) {
    const { sequence } = yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: yield* serverCommandId(`${input.tag}-session-stop`),
      threadId: input.threadId,
      createdAt: input.createdAt,
    });
    return sequence;
  });

  /** Start the thread's most recent user turn again, on `modelSelection`. */
  const startLatestTurn = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly modelSelection: OrchestrationThread["modelSelection"];
    readonly createdAt: string;
    readonly tag: string;
  }) {
    const lastUserMessage = input.thread.messages.findLast((message) => message.role === "user");
    if (!lastUserMessage) {
      yield* Effect.logWarning("provider exhaustion recovery skipped: no user message to restart", {
        threadId: input.thread.id,
        model: input.modelSelection.model,
      });
      return null;
    }

    const { sequence } = yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId(`${input.tag}-turn-start`),
      threadId: input.thread.id,
      message: {
        messageId: lastUserMessage.id,
        role: "user",
        text: lastUserMessage.text,
        attachments: lastUserMessage.attachments ?? [],
      },
      modelSelection: input.modelSelection,
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      createdAt: input.createdAt,
    });
    return sequence;
  });

  const appendActivity = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly tag: string;
    readonly kind: string;
    readonly tone: OrchestrationThreadActivityTone;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId(input.tag),
      threadId: input.thread.id,
      activity: {
        id: yield* serverEventId(),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: input.thread.latestTurn?.turnId ?? null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  /**
   * Park the thread until `resumeAt`. The session keeps its error status and
   * message — the thread genuinely did fail — and gains the instant at which
   * the server will restart the turn on its own.
   */
  const parkForLimitReset = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly resumeAt: string;
    readonly exhaustionKind: ProviderExhaustionKind;
    readonly failureDetail: string;
    readonly createdAt: string;
  }) {
    const session = input.thread.session;
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: yield* serverCommandId("limit-park-session-set"),
      threadId: input.thread.id,
      session: {
        threadId: input.thread.id,
        status: "error",
        providerName: session?.providerName ?? null,
        ...(session?.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session?.runtimeMode ?? input.thread.runtimeMode,
        activeTurnId: null,
        lastError: session?.lastError ?? input.failureDetail,
        resumeAt: input.resumeAt,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    yield* appendActivity({
      thread: input.thread,
      tag: "limit-park-activity",
      kind: LIMIT_PARKED_ACTIVITY_KIND,
      tone: "info",
      summary: `Paused: '${input.thread.modelSelection.model}' ${describeProviderExhaustionKind(input.exhaustionKind)}. Resuming automatically at ${input.resumeAt}.`,
      payload: {
        model: input.thread.modelSelection,
        reason: input.exhaustionKind,
        resumeAt: input.resumeAt,
        detail: truncateDetail(input.failureDetail),
      },
      createdAt: input.createdAt,
    });

    yield* Effect.logInfo("thread parked until provider limit resets", {
      threadId: input.thread.id,
      model: input.thread.modelSelection.model,
      reason: input.exhaustionKind,
      resumeAt: input.resumeAt,
    });
  });

  const performFailover = Effect.fnUntraced(function* (input: {
    readonly thread: OrchestrationThread;
    readonly failureDetail: string;
    readonly createdAt: string;
    readonly exhaustionKind: ProviderExhaustionKind;
  }) {
    const failedSelection = input.thread.modelSelection;
    const backupSelection = claudeBackupModelSelection(failedSelection);
    // No backup exists for non-Claude models — this is what caps failover at
    // one hop and prevents ping-ponging back from the codex backup.
    if (backupSelection === null) {
      return NO_RECOVERY;
    }

    const codexConfigured = yield* providerService.getInstanceInfo(CODEX_BACKUP_INSTANCE_ID).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!codexConfigured) {
      yield* Effect.logWarning("model failover skipped: codex backup instance not configured", {
        threadId: input.thread.id,
        failedModel: failedSelection.model,
      });
      return NO_RECOVERY;
    }

    failoverRecords.set(input.thread.id, {
      fromModel: failedSelection.model,
      toModel: backupSelection.model,
      kind: input.exhaustionKind,
      at: input.createdAt,
    });

    // Stop the failed provider session before switching models so the restarted
    // turn binds a fresh codex session instead of tripping the cross-driver
    // session-switch guards.
    yield* stopSession({
      threadId: input.thread.id,
      createdAt: input.createdAt,
      tag: "model-failover",
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("model-failover-meta-update"),
      threadId: input.thread.id,
      modelSelection: backupSelection,
    });

    yield* appendActivity({
      thread: input.thread,
      tag: "model-failover-activity",
      kind: MODEL_FAILOVER_ACTIVITY_KIND,
      tone: "info",
      summary: `Switched to backup model '${backupSelection.model}' (codex) because '${failedSelection.model}' ${describeProviderExhaustionKind(input.exhaustionKind)}.`,
      payload: {
        from: failedSelection,
        to: backupSelection,
        reason: input.exhaustionKind,
        detail: truncateDetail(input.failureDetail),
      },
      createdAt: input.createdAt,
    });

    const restartedSequence = yield* startLatestTurn({
      thread: input.thread,
      modelSelection: backupSelection,
      createdAt: input.createdAt,
      tag: "model-failover",
    });
    if (restartedSequence === null) {
      return NO_RECOVERY;
    }

    yield* Effect.logInfo("model failover restarted turn on codex backup", {
      threadId: input.thread.id,
      fromModel: failedSelection.model,
      toModel: backupSelection.model,
      reason: input.exhaustionKind,
    });
    return {
      kind: "failed-over",
      model: backupSelection.model,
    } satisfies ProviderExhaustionRecovery;
  });

  const performRecovery = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly failureDetail: string;
    readonly createdAt: string;
    readonly exhaustionKind: ProviderExhaustionKind;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!isRecoverableThread(thread)) {
      return NO_RECOVERY;
    }

    // Waiting beats switching: the same session picks the work back up with its
    // context, so it is only worth giving up on the model when the provider
    // gave us no instant to wait for.
    const nowMs = yield* Clock.currentTimeMillis;
    const resetAtMs = parseProviderExhaustionResetAt(input.failureDetail, nowMs);
    if (resetAtMs !== null && resetAtMs - nowMs <= MAX_PARK_MS) {
      const resumeAt = DateTime.formatIso(DateTime.makeUnsafe(resetAtMs));
      yield* parkForLimitReset({
        thread,
        resumeAt,
        exhaustionKind: input.exhaustionKind,
        failureDetail: input.failureDetail,
        createdAt: input.createdAt,
      });
      return { kind: "parked", resumeAt } satisfies ProviderExhaustionRecovery;
    }

    return yield* performFailover({
      thread,
      failureDetail: input.failureDetail,
      createdAt: input.createdAt,
      exhaustionKind: input.exhaustionKind,
    });
  });

  const recoverFromExhaustion: ModelFailoverShape["recoverFromExhaustion"] = Effect.fn(
    "recoverFromExhaustion",
  )(function* (input) {
    const exhaustionKind = classifyProviderExhaustion(input.failureDetail);
    if (exhaustionKind === null) {
      return NO_RECOVERY;
    }
    if (recoveryInFlight.has(input.threadId)) {
      return NO_RECOVERY;
    }
    recoveryInFlight.add(input.threadId);
    return yield* performRecovery({ ...input, exhaustionKind }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider exhaustion recovery failed; leaving thread on its error path", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(NO_RECOVERY)),
      ),
      Effect.ensuring(Effect.sync(() => recoveryInFlight.delete(input.threadId))),
    );
  });

  const performResume = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!isRecoverableThread(thread)) {
      return NOT_RESUMED;
    }

    // Stopping clears the park before the turn restarts, so a thread that hits
    // the same wall again parks on a fresh instant instead of being retried
    // every minute against a resumeAt that is now in the past.
    const stoppedSequence = yield* stopSession({
      threadId: input.threadId,
      createdAt: input.createdAt,
      tag: "limit-resume",
    });

    const restartedSequence = yield* startLatestTurn({
      thread,
      modelSelection: thread.modelSelection,
      createdAt: input.createdAt,
      tag: "limit-resume",
    });
    if (restartedSequence === null) {
      return { resumed: false, sequence: stoppedSequence };
    }

    yield* appendActivity({
      thread,
      tag: "limit-resume-activity",
      kind: LIMIT_RESUMED_ACTIVITY_KIND,
      tone: "info",
      summary: `Resumed on '${thread.modelSelection.model}' after the provider limit lifted.`,
      payload: { model: thread.modelSelection, resumeAt: thread.session?.resumeAt ?? null },
      createdAt: input.createdAt,
    });

    yield* Effect.logInfo("resumed thread after provider limit reset", {
      threadId: input.threadId,
      model: thread.modelSelection.model,
    });
    return { resumed: true, sequence: restartedSequence };
  });

  const resumeParkedThread: ModelFailoverShape["resumeParkedThread"] = Effect.fn(
    "resumeParkedThread",
  )(function* (input) {
    if (recoveryInFlight.has(input.threadId)) {
      return NOT_RESUMED;
    }
    recoveryInFlight.add(input.threadId);
    return yield* performResume(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("resuming a parked thread failed; leaving it parked", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(NOT_RESUMED)),
      ),
      Effect.ensuring(Effect.sync(() => recoveryInFlight.delete(input.threadId))),
    );
  });

  const withFailoverContext: ModelFailoverShape["withFailoverContext"] = Effect.fnUntraced(
    function* (threadId, detail) {
      const record = failoverRecords.get(threadId);
      if (!record) {
        return detail;
      }
      const thread = yield* resolveThread(threadId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const runsOnBackup =
        thread !== undefined &&
        thread.modelSelection.instanceId === CODEX_BACKUP_INSTANCE_ID &&
        thread.modelSelection.model === record.toModel;
      if (!runsOnBackup) {
        return detail;
      }
      return `${detail}\n\nAutomatic failover history: primary model '${record.fromModel}' ${describeProviderExhaustionKind(record.kind)}, then backup model '${record.toModel}' (codex) failed too.`;
    },
  );

  return {
    recoverFromExhaustion,
    resumeParkedThread,
    withFailoverContext,
  } satisfies ModelFailoverShape;
});

export const ModelFailoverLive = Layer.effect(ModelFailoverService, make);
