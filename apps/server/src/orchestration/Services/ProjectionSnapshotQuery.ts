/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  IssueId,
  OrchestrationCheckpointSummary,
  OrchestrationIssue,
  OrchestrationIssueDetail,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadShell,
  ProjectAutonomousScheduleEntry,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProjectLinkView } from "@t3tools/shared/projectLinks";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** Just enough of a project for the schedule ticker to decide. */
export interface ProjectionScheduledProject {
  readonly projectId: ProjectId;
  /** Non-null means a run is live, and the ticker leaves the project alone. */
  readonly autonomousStartedAt: string | null;
  readonly autonomousSchedule: ReadonlyArray<ProjectAutonomousScheduleEntry>;
}

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read the active projects that carry a schedule.
   *
   * Deliberately narrower than the shell snapshot: this runs once a minute, so
   * it reads three columns of the projects that have anything to fire rather
   * than every project, thread and issue in the environment.
   */
  readonly listScheduledProjects: () => Effect.Effect<
    ReadonlyArray<ProjectionScheduledProject>,
    ProjectionRepositoryError
  >;

  /**
   * Threads whose session is parked on a provider limit that has now lifted.
   *
   * Like the schedule query this runs once a minute, so it reads one column of
   * the few sessions that carry a resume instant rather than the read model.
   */
  readonly listThreadIdsDueForResume: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Every cross-project link a project sees — the edges it owns plus the
   * mirrors of edges other projects pointed at it — with each link's path
   * already resolved against the environment's registered project roots.
   *
   * `targetProjectId` is null for a folder no project is rooted at: a valid
   * link that is read-only context and cannot take writes. Callers that route
   * work across projects read this rather than matching paths themselves.
   *
   * Empty for an unknown or deleted project.
   */
  readonly getProjectLinksById: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectLinkView>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * The live companion thread a parent already owns in `targetProjectId`, if
   * any. Delegating twice to the same linked project continues that agent's
   * conversation rather than starting a stranger with no memory of the first
   * task. Newest first, so a hand-archived companion steps aside for its
   * replacement.
   */
  readonly getCompanionThreadId: (input: {
    readonly parentThreadId: ThreadId;
    readonly targetProjectId: ProjectId;
  }) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;

  /**
   * Read a single live issue summary — everything but the markdown body.
   */
  readonly getIssueSummaryById: (
    issueId: IssueId,
  ) => Effect.Effect<Option.Option<OrchestrationIssue>, ProjectionRepositoryError>;

  /**
   * Read a single live issue including its markdown body. This is the only
   * read that hydrates a description; list payloads deliberately omit it.
   */
  readonly getIssueDetailById: (
    issueId: IssueId,
  ) => Effect.Effect<Option.Option<OrchestrationIssueDetail>, ProjectionRepositoryError>;

  /**
   * Read the live issue a thread is reviewing, if any. Turn-completion
   * ingestion uses this to tell a reviewer thread from a worker thread.
   */
  readonly getIssueByReviewerThreadId: (
    reviewerThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationIssue>, ProjectionRepositoryError>;

  /**
   * Read a project's live backlog as summaries, in creation order.
   */
  readonly listIssuesByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationIssue>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
