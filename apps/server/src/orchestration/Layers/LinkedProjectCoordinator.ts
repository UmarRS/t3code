import {
  CommandId,
  EventId,
  LINKED_PROJECT_AGENT_ACTIVITY_KIND,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type LinkedProjectDelegationStatus,
  type OrchestrationThread,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  LinkedProjectCoordinator,
  type LinkedProjectCoordinatorShape,
  type LinkedProjectDelegationResult,
  type RoutableLinkedProject,
} from "../Services/LinkedProjectCoordinator.ts";

const isDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/**
 * How long `delegate` waits before handing back a `timed-out` result. A real
 * cross-repo task routinely runs longer than a provider will hold a tool call
 * open, so the ceiling exists to return control, not to stop the companion —
 * it keeps working and the caller polls it by thread id.
 */
const DEFAULT_DELEGATION_TIMEOUT = Duration.minutes(10);

const toDispatchError = (message: string) => (cause: unknown) =>
  isDispatchCommandError(cause) ? cause : new OrchestrationDispatchCommandError({ message, cause });

/** The companion's closing message for a turn, if it left one. */
const closingMessage = (thread: OrchestrationThread): string | undefined => {
  const assistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  const message =
    assistantMessageId === null
      ? [...thread.messages].reverse().find((candidate) => candidate.role === "assistant")
      : thread.messages.find((candidate) => candidate.id === assistantMessageId);
  const text = message?.text.trim();
  return text === undefined || text.length === 0 ? undefined : text;
};

const statusForTurn = (thread: OrchestrationThread): LinkedProjectDelegationStatus =>
  thread.latestTurn === null || thread.latestTurn.state === "running"
    ? "timed-out"
    : thread.latestTurn.state === "completed"
      ? "completed"
      : "failed";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)),
      Effect.mapError(toDispatchError("Failed to generate a command identifier.")),
    );

  const serverEventId = () =>
    crypto.randomUUIDv4.pipe(
      Effect.map(EventId.make),
      Effect.mapError(toDispatchError("Failed to generate an activity identifier.")),
    );

  const listRoutableLinks: LinkedProjectCoordinatorShape["listRoutableLinks"] = (projectId) =>
    Effect.gen(function* () {
      const links = yield* projectionSnapshotQuery.getProjectLinksById(projectId);
      const routable: Array<RoutableLinkedProject> = [];
      for (const link of links) {
        if (link.targetProjectId === null) continue;
        const project = yield* projectionSnapshotQuery.getProjectShellById(link.targetProjectId);
        if (Option.isNone(project)) continue;
        routable.push({
          projectId: link.targetProjectId,
          title: project.value.title,
          workspaceRoot: project.value.workspaceRoot,
          description: link.description,
        });
      }
      return routable;
    });

  const requireThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OrchestrationDispatchCommandError({
                message: `Thread '${threadId}' does not exist.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Reuse the parent's companion for this project when one is live, so a
   * follow-up delegation lands in an agent that remembers the first task.
   */
  const ensureCompanionThread = (input: {
    readonly parent: OrchestrationThread;
    readonly target: RoutableLinkedProject;
    readonly originLinkId: string | undefined;
  }) =>
    Effect.gen(function* () {
      const existing = yield* projectionSnapshotQuery.getCompanionThreadId({
        parentThreadId: input.parent.id,
        targetProjectId: input.target.projectId,
      });
      if (Option.isSome(existing)) {
        return existing.value;
      }

      const companionThreadId = ThreadId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(toDispatchError("Failed to generate a companion thread identifier.")),
        ),
      );
      const createdAt = yield* nowIso;

      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("linked-project-thread-create"),
          threadId: companionThreadId,
          projectId: input.target.projectId,
          title: `${input.parent.title} — ${input.target.title}`,
          // Snapshot the parent's *persisted* selection rather than its live
          // session model: the session carries a bare provider model string and
          // loses the instance and options. Reading it now also pins the model
          // before a failover on the parent can rewrite it.
          modelSelection: input.parent.modelSelection,
          runtimeMode: input.parent.runtimeMode,
          interactionMode: input.parent.interactionMode,
          branch: null,
          worktreePath: null,
          parentThreadId: input.parent.id,
          ...(input.originLinkId !== undefined ? { originLinkId: input.originLinkId } : {}),
          createdAt,
        })
        .pipe(Effect.mapError(toDispatchError("Failed to create the companion thread.")));

      return companionThreadId;
    });

  /**
   * Wait for the turn that follows `previousTurnId` to leave the running
   * state. Subscribing before the turn is dispatched would be racy the other
   * way round, so the caller dispatches first and this re-reads the thread on
   * every session change — delegation is rare enough that the extra reads cost
   * nothing next to a model turn.
   */
  const awaitTurnSettled = (input: {
    readonly companionThreadId: ThreadId;
    readonly previousTurnId: string | null;
    readonly timeout: Duration.Duration;
  }) =>
    Effect.gen(function* () {
      const settled = (thread: OrchestrationThread) =>
        thread.latestTurn !== null &&
        thread.latestTurn.turnId !== input.previousTurnId &&
        thread.latestTurn.state !== "running";

      const watch = Effect.gen(function* () {
        const events = yield* Queue.unbounded<void>();
        yield* Effect.forkScoped(
          Stream.runForEach(
            orchestrationEngine.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.aggregateKind === "thread" && event.aggregateId === input.companionThreadId,
              ),
            ),
            () => Queue.offer(events, undefined).pipe(Effect.asVoid),
          ),
        );

        // Check once before waiting: the turn can settle between the dispatch
        // and this subscription going live.
        let thread = yield* requireThread(input.companionThreadId);
        while (!settled(thread)) {
          yield* Queue.take(events);
          thread = yield* requireThread(input.companionThreadId);
        }
        return thread;
      }).pipe(Effect.scoped);

      return yield* watch.pipe(
        Effect.timeoutOption(input.timeout),
        Effect.flatMap(
          Option.match({
            onNone: () => requireThread(input.companionThreadId),
            onSome: Effect.succeed,
          }),
        ),
      );
    });

  const describe = (
    thread: OrchestrationThread,
    target: RoutableLinkedProject,
    status: LinkedProjectDelegationStatus,
  ): LinkedProjectDelegationResult => {
    const result = status === "timed-out" ? undefined : closingMessage(thread);
    return {
      companionThreadId: thread.id,
      status,
      targetProjectTitle: target.title,
      targetWorkspaceRoot: target.workspaceRoot,
      ...(result !== undefined ? { result } : {}),
    };
  };

  const delegate: LinkedProjectCoordinatorShape["delegate"] = (input) =>
    Effect.gen(function* () {
      const parent = yield* requireThread(input.parentThreadId);
      const routable = yield* listRoutableLinks(parent.projectId);
      const target = routable.find((candidate) => candidate.projectId === input.targetProjectId);
      if (target === undefined) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Project '${input.targetProjectId}' is not a routable linked project of thread '${input.parentThreadId}'.`,
        });
      }

      const links = yield* projectionSnapshotQuery.getProjectLinksById(parent.projectId);
      const originLinkId = links.find((link) => link.targetProjectId === input.targetProjectId)
        ?.link.id;

      const companionThreadId = yield* ensureCompanionThread({ parent, target, originLinkId });
      const before = yield* requireThread(companionThreadId);
      const previousTurnId = before.latestTurn?.turnId ?? null;

      const createdAt = yield* nowIso;
      const messageId = MessageId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(toDispatchError("Failed to generate a message identifier.")),
        ),
      );

      // A real user message, not an injected prompt: ModelFailover replays the
      // last user message when it switches providers, so a companion that
      // exhausts its model has to have one to replay.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: yield* serverCommandId("linked-project-turn"),
          threadId: companionThreadId,
          message: { messageId, role: "user", text: input.task, attachments: [] },
          modelSelection: parent.modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          createdAt,
        })
        .pipe(Effect.mapError(toDispatchError("Failed to start the companion's turn.")));

      const settledThread = yield* awaitTurnSettled({
        companionThreadId,
        previousTurnId,
        timeout:
          input.timeoutMillis === undefined
            ? DEFAULT_DELEGATION_TIMEOUT
            : Duration.millis(input.timeoutMillis),
      });
      const status = statusForTurn(settledThread);
      const result = describe(settledThread, target, status);

      // Fold the outcome into the parent's timeline. Best effort: the caller
      // already has the result, and losing the breadcrumb must not fail it.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: yield* serverCommandId("linked-project-activity"),
          threadId: parent.id,
          activity: {
            id: yield* serverEventId(),
            tone: status === "failed" ? "error" : "info",
            kind: LINKED_PROJECT_AGENT_ACTIVITY_KIND,
            summary:
              status === "completed"
                ? `Agent in ${target.title} finished its task.`
                : status === "timed-out"
                  ? `Agent in ${target.title} is still working.`
                  : `Agent in ${target.title} could not finish its task.`,
            payload: {
              companionThreadId,
              targetProjectTitle: target.title,
              targetWorkspaceRoot: target.workspaceRoot,
              status,
              task: input.task,
              ...(result.result !== undefined ? { result: result.result } : {}),
            },
            turnId: parent.latestTurn?.turnId ?? null,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.ignoreCause({ log: true }));

      return result;
    });

  const readDelegation: LinkedProjectCoordinatorShape["readDelegation"] = (companionThreadId) =>
    Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery.getThreadDetailById(companionThreadId);
      if (Option.isNone(thread)) {
        return {
          companionThreadId,
          status: "failed" as const,
          targetProjectTitle: "unknown",
          targetWorkspaceRoot: "unknown",
        };
      }
      const project = yield* projectionSnapshotQuery.getProjectShellById(thread.value.projectId);
      const status = statusForTurn(thread.value);
      const result = status === "timed-out" ? undefined : closingMessage(thread.value);
      return {
        companionThreadId,
        status,
        targetProjectTitle: Option.isSome(project) ? project.value.title : "unknown",
        targetWorkspaceRoot: Option.isSome(project) ? project.value.workspaceRoot : "unknown",
        ...(result !== undefined ? { result } : {}),
      };
    });

  return { listRoutableLinks, delegate, readDelegation } satisfies LinkedProjectCoordinatorShape;
});

export const LinkedProjectCoordinatorLive = Layer.effect(LinkedProjectCoordinator, make);
