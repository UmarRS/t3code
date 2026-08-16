import {
  CommandId,
  EventId,
  ISSUE_ATTENTION_REASON_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  IssueId,
  LINKED_PROJECT_AGENT_ACTIVITY_KIND,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type LinkedProjectDelegationStatus,
  type OrchestrationIssue,
  type OrchestrationThread,
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

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { IssueStartCoordinator } from "../Services/IssueStartCoordinator.ts";
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

/**
 * The modes a delegated issue is worked in. Same reasoning as the autonomous
 * run loop's: the delegating caller is an agent, not a person, so a worker left
 * in a mode that can stop to ask for approval would simply hang forever.
 */
const DELEGATED_RUNTIME_MODE = "full-access" as const;
const DELEGATED_INTERACTION_MODE = "default" as const;

/**
 * An issue title out of the delegated task. The first non-empty line is what
 * an agent writes as its headline, so it is the best one-liner available; the
 * whole task still becomes the description, so nothing is lost by trimming.
 */
const issueTitleForTask = (task: string, fallback: string): string => {
  const firstLine = task
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const headline = firstLine === undefined || firstLine.length === 0 ? fallback : firstLine;
  return headline.length <= ISSUE_TITLE_MAX_LENGTH
    ? headline
    : `${headline.slice(0, ISSUE_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
};

const toDispatchError = (message: string) => (cause: unknown) =>
  isDispatchCommandError(cause) ? cause : new OrchestrationDispatchCommandError({ message, cause });

/** The companion's closing message for a turn, if it left one. */
const closingMessage = (thread: OrchestrationThread): string | undefined => {
  const assistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  const message =
    assistantMessageId === null
      ? thread.messages.toReversed().find((candidate) => candidate.role === "assistant")
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
  const issueStartCoordinator = yield* IssueStartCoordinator;

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

  const listLinksForThread: LinkedProjectCoordinatorShape["listLinksForThread"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* requireThread(threadId);
      const [links, routable] = yield* Effect.all([
        projectionSnapshotQuery.getProjectLinksById(thread.projectId),
        listRoutableLinks(thread.projectId),
      ]);
      const byRoot = new Map(
        routable.map((entry) => [normalizeProjectPathForComparison(entry.workspaceRoot), entry]),
      );
      return links.map((link) => {
        const target = byRoot.get(normalizeProjectPathForComparison(link.path));
        return {
          path: link.path,
          // A context-only folder has no project to take a title from, so its
          // own path is the most useful thing to call it.
          title: target?.title ?? link.path,
          description: link.description,
          routable: target !== undefined,
        };
      });
    });

  const resolveTarget: LinkedProjectCoordinatorShape["resolveTarget"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* requireThread(input.parentThreadId);
      const routable = yield* listRoutableLinks(thread.projectId);
      const wanted = normalizeProjectPathForComparison(input.path);
      return Option.fromNullishOr(
        routable.find((entry) => normalizeProjectPathForComparison(entry.workspaceRoot) === wanted),
      );
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

  /**
   * Fold a delegation into the parent's timeline. Best effort everywhere it is
   * used: the caller already has the result, and losing the breadcrumb must
   * not fail the delegation that produced it.
   */
  const appendParentActivity = (input: {
    readonly parent: OrchestrationThread;
    readonly target: RoutableLinkedProject;
    readonly companionThreadId: ThreadId;
    readonly status: LinkedProjectDelegationStatus;
    readonly summary: string;
    readonly task: string;
    readonly result: string | undefined;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("linked-project-activity");
      const activityId = yield* serverEventId();
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.parent.id,
        activity: {
          id: activityId,
          tone: input.status === "failed" ? "error" : "info",
          kind: LINKED_PROJECT_AGENT_ACTIVITY_KIND,
          summary: input.summary,
          payload: {
            companionThreadId: input.companionThreadId,
            targetProjectTitle: input.target.title,
            targetWorkspaceRoot: input.target.workspaceRoot,
            status: input.status,
            task: input.task,
            ...(input.result !== undefined ? { result: input.result } : {}),
          },
          turnId: input.parent.latestTurn?.turnId ?? null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * The issue `parent` is autonomously working, if it is working one.
   *
   * Two ways to qualify, and both have to count. The obvious one is an issue
   * on a project whose run is live. The other is an issue that was itself
   * delegated in from somewhere else: its project has no run of its own, but
   * its worker is just as unattended, so a delegation it makes must be routed
   * the same way rather than falling back to an untracked companion.
   */
  const autonomousWorkerIssue = (parent: OrchestrationThread) =>
    Effect.gen(function* () {
      const project = yield* projectionSnapshotQuery.getProjectShellById(parent.projectId);
      const runIsLive = Option.isSome(project) && project.value.autonomousStartedAt != null;
      const issues = yield* projectionSnapshotQuery.listIssuesByProjectId(parent.projectId);
      const issue = issues.find((candidate) => candidate.threadId === parent.id);
      if (issue === undefined) return Option.none<OrchestrationIssue>();
      return runIsLive || issue.delegatedFromThreadId != null
        ? Option.some(issue)
        : Option.none<OrchestrationIssue>();
    });

  /**
   * Delegation from an autonomous worker: file the task on the target
   * project's board and start it there, rather than running it in a companion.
   *
   * A companion writes to the other repository with no worktree, no branch and
   * no pull request, which is fine when a human is watching the thread and
   * wrong when nobody is. Going through the board instead puts the delegated
   * change on the same rails the target project's own autonomous work runs on
   * — isolated worktree, pull request, reviewer, automatic merge — and leaves a
   * row on that board a human can find afterwards.
   *
   * This returns as soon as the work is started. The caller is an agent in the
   * middle of its own turn, and the alternative is holding a tool call open for
   * as long as a cross-repo change takes.
   */
  const delegateAsIssue = (input: {
    readonly parent: OrchestrationThread;
    readonly target: RoutableLinkedProject;
    readonly task: string;
  }) =>
    Effect.gen(function* () {
      const issueId = IssueId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(toDispatchError("Failed to generate an issue identifier.")),
        ),
      );
      // `startIssue` takes the ids rather than minting them, so the worker
      // thread is known before it exists — which is what lets this return a
      // thread the caller can poll without waiting for anything.
      const workerThreadId = ThreadId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(toDispatchError("Failed to generate a worker thread identifier.")),
        ),
      );
      const messageId = MessageId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(toDispatchError("Failed to generate a message identifier.")),
        ),
      );
      const createdAt = yield* nowIso;

      yield* orchestrationEngine
        .dispatch({
          type: "issue.create",
          commandId: yield* serverCommandId("linked-project-issue-create"),
          issueId,
          projectId: input.target.projectId,
          title: issueTitleForTask(input.task, `Delegated from ${input.parent.title}`),
          // The whole task, unabridged: the title is a headline, and the worker
          // reads the description.
          description: input.task,
          delegatedFromThreadId: input.parent.id,
          createdAt,
        })
        .pipe(Effect.mapError(toDispatchError("Failed to file the delegated task as an issue.")));

      // The target project's own default wins: the model its owner chose for
      // that repository beats whatever the caller happens to be running. A
      // project with no default inherits the parent's rather than refusing the
      // work.
      const targetProject = yield* projectionSnapshotQuery.getProjectShellById(
        input.target.projectId,
      );
      const modelSelection =
        (Option.isSome(targetProject) ? targetProject.value.defaultModelSelection : null) ??
        input.parent.modelSelection;

      const failure = yield* issueStartCoordinator
        .startIssue(
          {
            type: "issue.start",
            commandId: yield* serverCommandId(`linked-project-issue-start:${issueId}`),
            issueId,
            threadId: workerThreadId,
            messageId,
            modelSelection,
            runtimeMode: DELEGATED_RUNTIME_MODE,
            interactionMode: DELEGATED_INTERACTION_MODE,
            // Fork from the remote's tip, like every other autonomous start:
            // the delegated branch is going to become a pull request.
            startFromOrigin: true,
            createdAt,
          },
          { autonomous: true },
        )
        .pipe(
          Effect.as(Option.none<string>()),
          Effect.catch((error) => Effect.succeed(Option.some(error.message))),
        );

      if (Option.isSome(failure)) {
        // The issue exists and nothing is working it. Flag it rather than
        // leaving a dead row on somebody else's board with no explanation.
        yield* orchestrationEngine
          .dispatch({
            type: "issue.attention.flag",
            commandId: yield* serverCommandId(`linked-project-issue-flag:${issueId}`),
            issueId,
            reason:
              `Delegated from another project, but the work could not be started: ${failure.value}`.slice(
                0,
                ISSUE_ATTENTION_REASON_MAX_LENGTH,
              ),
          })
          .pipe(Effect.ignoreCause({ log: true }));

        const message = `The task was filed on ${input.target.title}'s board as issue ${issueId}, but it could not be started: ${failure.value}. It is flagged there for a human.`;
        yield* appendParentActivity({
          parent: input.parent,
          target: input.target,
          companionThreadId: workerThreadId,
          status: "failed",
          summary: `The task filed on ${input.target.title}'s board could not be started.`,
          task: input.task,
          result: message,
          createdAt,
        });
        return {
          companionThreadId: workerThreadId,
          status: "failed" as const,
          targetProjectTitle: input.target.title,
          targetWorkspaceRoot: input.target.workspaceRoot,
          result: message,
          issueId,
        };
      }

      yield* appendParentActivity({
        parent: input.parent,
        target: input.target,
        companionThreadId: workerThreadId,
        status: "queued",
        summary: `Agent in ${input.target.title} took the task as an issue on its board.`,
        task: input.task,
        result: undefined,
        createdAt,
      });

      return {
        companionThreadId: workerThreadId,
        status: "queued" as const,
        targetProjectTitle: input.target.title,
        targetWorkspaceRoot: input.target.workspaceRoot,
        issueId,
      };
    });

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

      // Nobody is watching a worker that is doing an issue, so its cross-repo
      // work goes on the target project's board instead of into a companion
      // whose changes no pull request would ever carry.
      if (Option.isSome(yield* autonomousWorkerIssue(parent))) {
        return yield* delegateAsIssue({ parent, target, task: input.task });
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

      yield* appendParentActivity({
        parent,
        target,
        companionThreadId,
        status,
        summary:
          status === "completed"
            ? `Agent in ${target.title} finished its task.`
            : status === "timed-out"
              ? `Agent in ${target.title} is still working.`
              : `Agent in ${target.title} could not finish its task.`,
        task: input.task,
        result: result.result,
        createdAt,
      });

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

  return {
    listRoutableLinks,
    listLinksForThread,
    resolveTarget,
    delegate,
    readDelegation,
  } satisfies LinkedProjectCoordinatorShape;
});

export const LinkedProjectCoordinatorLive = Layer.effect(LinkedProjectCoordinator, make);
