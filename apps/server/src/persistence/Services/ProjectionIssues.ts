/**
 * ProjectionIssueRepository - Projection repository interface for issues.
 *
 * Owns persistence operations for projected issue records in the orchestration
 * read model. Rows carry the markdown description; the shell payloads and the
 * command read model deliberately leave it behind.
 *
 * @module ProjectionIssueRepository
 */
import {
  IsoDateTime,
  IssueAttentionKind,
  IssueAttentionReason,
  IssueId,
  IssuePriority,
  IssueReviewVerdict,
  IssueStatus,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionIssue = Schema.Struct({
  issueId: IssueId,
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.String,
  status: IssueStatus,
  priority: Schema.NullOr(IssuePriority),
  modelSelection: Schema.NullOr(ModelSelection),
  dependsOn: Schema.Array(IssueId),
  threadId: Schema.NullOr(ThreadId),
  pullRequestUrl: Schema.NullOr(Schema.String),
  needsAttentionAt: Schema.NullOr(IsoDateTime),
  needsAttentionReason: Schema.NullOr(IssueAttentionReason),
  /** Null for issues parked before kinds existed; never backfilled. */
  needsAttentionKind: Schema.NullOr(IssueAttentionKind),
  reviewVerdict: Schema.NullOr(IssueReviewVerdict),
  reviewerThreadId: Schema.NullOr(ThreadId),
  reviewedAt: Schema.NullOr(IsoDateTime),
  reviewNotes: Schema.String,
  /** The thread that delegated this issue in from another project, if any. */
  delegatedFromThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionIssue = typeof ProjectionIssue.Type;

export const GetProjectionIssueInput = Schema.Struct({
  issueId: IssueId,
});
export type GetProjectionIssueInput = typeof GetProjectionIssueInput.Type;

export const GetProjectionIssueByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionIssueByThreadInput = typeof GetProjectionIssueByThreadInput.Type;

export const ListProjectionIssuesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionIssuesByProjectInput = typeof ListProjectionIssuesByProjectInput.Type;

/**
 * ProjectionIssueRepositoryShape - Service API for projected issue records.
 */
export interface ProjectionIssueRepositoryShape {
  /**
   * Insert or replace a projected issue row.
   *
   * Upserts by `issueId`.
   */
  readonly upsert: (issue: ProjectionIssue) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected issue row by id, including soft-deleted rows.
   */
  readonly getById: (
    input: GetProjectionIssueInput,
  ) => Effect.Effect<Option.Option<ProjectionIssue>, ProjectionRepositoryError>;

  /**
   * Read the live issue a thread is doing the work for, if any.
   */
  readonly getByThreadId: (
    input: GetProjectionIssueByThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionIssue>, ProjectionRepositoryError>;

  /**
   * List live projected issues for a project, in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionIssuesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionIssue>, ProjectionRepositoryError>;
}

/**
 * ProjectionIssueRepository - Service tag for issue projection persistence.
 */
export class ProjectionIssueRepository extends Context.Service<
  ProjectionIssueRepository,
  ProjectionIssueRepositoryShape
>()("t3/persistence/Services/ProjectionIssues/ProjectionIssueRepository") {}
