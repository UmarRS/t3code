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
  LinkedProjectDelegationStatus,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
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
  readonly companionThreadId: ThreadId;
  readonly status: LinkedProjectDelegationStatus;
  readonly targetProjectTitle: string;
  readonly targetWorkspaceRoot: string;
  /**
   * The companion's closing message. Absent on `timed-out`, and on a run that
   * ended without saying anything.
   */
  readonly result?: string | undefined;
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
   * Run `task` as an agent in `targetProjectId` on behalf of `parentThreadId`,
   * and wait for it to finish.
   *
   * Reuses the parent's existing companion for that project when there is one,
   * so a second delegation continues the same conversation. Returns
   * `timed-out` rather than failing when the run outlives `timeout`: the agent
   * is still working and can be polled with {@link readDelegation}.
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
