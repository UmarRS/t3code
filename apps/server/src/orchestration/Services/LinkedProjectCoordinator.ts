/**
 * LinkedProjectCoordinator - handing work to an agent in a linked project.
 *
 * A project link says "this other repository is part of the same job". When
 * the link points at a *registered* project, the app can do more than mention
 * it in a prompt: it can open a thread there, run an agent with the parent's
 * model and the same write access any thread gets, and fold the result back
 * into the conversation that asked for it.
 *
 * The companion is a real thread rather than a second session on the parent,
 * because provider sessions are keyed 1:1 by thread id all the way down to the
 * `provider_session_runtime` primary key. Making it a thread also means the
 * companion's cwd, worktree, checkpoints, diffs and git actions come out of the
 * machinery every other thread already uses.
 *
 * @module LinkedProjectCoordinator
 */
import type {
  IssueId,
  LinkedProjectDelegationStatus,
  LinkedProjectSummary,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** A link this project can actually route work to. */
export interface RoutableLinkedProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  /** The link's own description — what the owner said this repository is for. */
  readonly description: string;
}

export interface LinkedProjectDelegationResult {
  /**
   * The thread doing the delegated work. A companion thread on the interactive
   * path, and the issue's worker thread on the autonomous one — either way it
   * is what {@link LinkedProjectCoordinatorShape.readDelegation} polls.
   */
  readonly companionThreadId: ThreadId;
  readonly status: LinkedProjectDelegationStatus;
  readonly targetProjectTitle: string;
  readonly targetWorkspaceRoot: string;
  /**
   * The companion's closing message. Absent on `timed-out`, and on a run that
   * ended without saying anything.
   */
  readonly result?: string | undefined;
  /** The issue the task was filed as. Present only on a `queued` delegation. */
  readonly issueId?: IssueId | undefined;
}

export interface LinkedProjectCoordinatorShape {
  /**
   * Links from `projectId` that resolve to a registered project. Context-only
   * links are excluded: there is no project to open a thread in.
   */
  readonly listRoutableLinks: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<RoutableLinkedProject>, ProjectionRepositoryError>;

  /**
   * Every link the thread's project sees, routable or not, shaped for the
   * agent-facing tool. Keeps path matching and the routable predicate in one
   * place instead of spreading them across callers.
   */
  readonly listLinksForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<LinkedProjectSummary>,
    OrchestrationDispatchCommandError | ProjectionRepositoryError
  >;

  /**
   * Resolve a workspace-root path to a routable linked project of this
   * thread's own project. `None` when nothing matches — the caller decides
   * whether that is "unknown" or "context only".
   */
  readonly resolveTarget: (input: {
    readonly parentThreadId: ThreadId;
    readonly path: string;
  }) => Effect.Effect<
    Option.Option<RoutableLinkedProject>,
    OrchestrationDispatchCommandError | ProjectionRepositoryError
  >;

  /**
   * Run `task` as an agent in `targetProjectId` on behalf of `parentThreadId`.
   *
   * Two shapes, chosen by what the caller is. A conversational thread gets a
   * companion: an agent opened in the target project that this call waits for,
   * reusing the parent's existing companion so a second delegation continues
   * the same conversation, and returning `timed-out` rather than failing when
   * the run outlives `timeout` — the agent is still working and can be polled
   * with {@link readDelegation}.
   *
   * A thread that is itself working an issue autonomously gets something else
   * entirely: the task is filed as an issue on the target project's board and
   * started there immediately, so the delegated change arrives through that
   * board's pipeline — its own worktree, a pull request, a review, and an
   * automatic merge — instead of being written into another repository by an
   * agent nobody is tracking. That returns `queued` straight away, because a
   * caller with no human in it must not sit on a tool call for ten minutes.
   */
  readonly delegate: (input: {
    readonly parentThreadId: ThreadId;
    readonly targetProjectId: ProjectId;
    readonly task: string;
    readonly timeoutMillis?: number | undefined;
  }) => Effect.Effect<
    LinkedProjectDelegationResult,
    OrchestrationDispatchCommandError | ProjectionRepositoryError
  >;

  /**
   * Current state of a companion thread, for polling a delegation that timed
   * out. Fails only on a read error; an unknown thread is a `failed` result.
   */
  readonly readDelegation: (
    companionThreadId: ThreadId,
  ) => Effect.Effect<LinkedProjectDelegationResult, ProjectionRepositoryError>;
}

export class LinkedProjectCoordinator extends Context.Service<
  LinkedProjectCoordinator,
  LinkedProjectCoordinatorShape
>()("t3/orchestration/Services/LinkedProjectCoordinator") {}
