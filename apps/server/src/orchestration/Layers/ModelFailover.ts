import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
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
  type ProviderExhaustionKind,
} from "../../provider/providerExhaustion.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ModelFailoverService, type ModelFailoverShape } from "../Services/ModelFailover.ts";

/** Activity kind projected into the thread timeline when a failover happens. */
export const MODEL_FAILOVER_ACTIVITY_KIND = "model.failover";

const MAX_RECORDED_FAILOVER_DETAIL_CHARS = 600;

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
  const failoverInFlight = new Set<ThreadId>();

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const performFailover = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly failureDetail: string;
    readonly createdAt: string;
    readonly exhaustionKind: ProviderExhaustionKind;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
      return false;
    }

    const failedSelection = thread.modelSelection;
    const backupSelection = claudeBackupModelSelection(failedSelection);
    // No backup exists for non-Claude models — this is what caps failover at
    // one hop and prevents ping-ponging back from the codex backup.
    if (backupSelection === null) {
      return false;
    }

    const codexConfigured = yield* providerService.getInstanceInfo(CODEX_BACKUP_INSTANCE_ID).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!codexConfigured) {
      yield* Effect.logWarning("model failover skipped: codex backup instance not configured", {
        threadId: input.threadId,
        failedModel: failedSelection.model,
      });
      return false;
    }

    const lastUserMessage = thread.messages.findLast((message) => message.role === "user");
    if (!lastUserMessage) {
      yield* Effect.logWarning("model failover skipped: no user message to restart", {
        threadId: input.threadId,
        failedModel: failedSelection.model,
      });
      return false;
    }

    failoverRecords.set(input.threadId, {
      fromModel: failedSelection.model,
      toModel: backupSelection.model,
      kind: input.exhaustionKind,
      at: input.createdAt,
    });

    // Stop the (possibly still-registered) failed provider session first so
    // the restarted turn binds a fresh codex session instead of tripping the
    // cross-driver session-switch guards.
    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: yield* serverCommandId("model-failover-session-stop"),
      threadId: input.threadId,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("model-failover-meta-update"),
      threadId: input.threadId,
      modelSelection: backupSelection,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("model-failover-activity"),
      threadId: input.threadId,
      activity: {
        id: yield* serverEventId(),
        tone: "info",
        kind: MODEL_FAILOVER_ACTIVITY_KIND,
        summary: `Switched to backup model '${backupSelection.model}' (codex) because '${failedSelection.model}' ${describeProviderExhaustionKind(input.exhaustionKind)}.`,
        payload: {
          from: failedSelection,
          to: backupSelection,
          reason: input.exhaustionKind,
          detail: truncateDetail(input.failureDetail),
        },
        turnId: thread.latestTurn?.turnId ?? null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("model-failover-turn-start"),
      threadId: input.threadId,
      message: {
        messageId: lastUserMessage.id,
        role: "user",
        text: lastUserMessage.text,
        attachments: lastUserMessage.attachments ?? [],
      },
      modelSelection: backupSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: input.createdAt,
    });

    yield* Effect.logInfo("model failover restarted turn on codex backup", {
      threadId: input.threadId,
      fromModel: failedSelection.model,
      toModel: backupSelection.model,
      reason: input.exhaustionKind,
    });
    return true;
  });

  const maybeFailoverToBackup: ModelFailoverShape["maybeFailoverToBackup"] = Effect.fn(
    "maybeFailoverToBackup",
  )(function* (input) {
    const exhaustionKind = classifyProviderExhaustion(input.failureDetail);
    if (exhaustionKind === null) {
      return false;
    }
    if (failoverInFlight.has(input.threadId)) {
      return false;
    }
    failoverInFlight.add(input.threadId);
    return yield* performFailover({ ...input, exhaustionKind }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("model failover failed; leaving thread on its error path", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
      Effect.ensuring(Effect.sync(() => failoverInFlight.delete(input.threadId))),
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
    maybeFailoverToBackup,
    withFailoverContext,
  } satisfies ModelFailoverShape;
});

export const ModelFailoverLive = Layer.effect(ModelFailoverService, make);
