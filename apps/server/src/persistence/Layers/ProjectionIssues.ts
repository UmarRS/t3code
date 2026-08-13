import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { IssueId, ModelSelection } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionIssueByThreadInput,
  GetProjectionIssueInput,
  ListProjectionIssuesByProjectInput,
  ProjectionIssue,
  ProjectionIssueRepository,
  type ProjectionIssueRepositoryShape,
} from "../Services/ProjectionIssues.ts";

const ProjectionIssueDbRow = ProjectionIssue.mapFields(
  Struct.assign({
    // The column carries a '[]' default, so every row decodes as an array.
    dependsOn: Schema.fromJsonString(Schema.Array(IssueId)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);

const makeProjectionIssueRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionIssueRow = SqlSchema.void({
    Request: ProjectionIssue,
    execute: (row) =>
      sql`
        INSERT INTO projection_issues (
          issue_id,
          project_id,
          title,
          description,
          status,
          priority,
          model_selection_json,
          depends_on_json,
          thread_id,
          pull_request_url,
          needs_attention_at,
          needs_attention_reason,
          review_verdict,
          reviewer_thread_id,
          reviewed_at,
          review_notes,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.issueId},
          ${row.projectId},
          ${row.title},
          ${row.description},
          ${row.status},
          ${row.priority},
          ${row.modelSelection === null ? null : JSON.stringify(row.modelSelection)},
          ${JSON.stringify(row.dependsOn)},
          ${row.threadId},
          ${row.pullRequestUrl},
          ${row.needsAttentionAt},
          ${row.needsAttentionReason},
          ${row.reviewVerdict},
          ${row.reviewerThreadId},
          ${row.reviewedAt},
          ${row.reviewNotes},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (issue_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          model_selection_json = excluded.model_selection_json,
          depends_on_json = excluded.depends_on_json,
          thread_id = excluded.thread_id,
          pull_request_url = excluded.pull_request_url,
          needs_attention_at = excluded.needs_attention_at,
          needs_attention_reason = excluded.needs_attention_reason,
          review_verdict = excluded.review_verdict,
          reviewer_thread_id = excluded.reviewer_thread_id,
          reviewed_at = excluded.reviewed_at,
          review_notes = excluded.review_notes,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionIssueRow = SqlSchema.findOneOption({
    Request: GetProjectionIssueInput,
    Result: ProjectionIssueDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT
          issue_id AS "issueId",
          project_id AS "projectId",
          title,
          description,
          status,
          priority,
          model_selection_json AS "modelSelection",
          depends_on_json AS "dependsOn",
          thread_id AS "threadId",
          pull_request_url AS "pullRequestUrl",
          needs_attention_at AS "needsAttentionAt",
          needs_attention_reason AS "needsAttentionReason",
          review_verdict AS "reviewVerdict",
          reviewer_thread_id AS "reviewerThreadId",
          reviewed_at AS "reviewedAt",
          review_notes AS "reviewNotes",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_issues
        WHERE issue_id = ${issueId}
      `,
  });

  const getProjectionIssueRowByThread = SqlSchema.findOneOption({
    Request: GetProjectionIssueByThreadInput,
    Result: ProjectionIssueDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          issue_id AS "issueId",
          project_id AS "projectId",
          title,
          description,
          status,
          priority,
          model_selection_json AS "modelSelection",
          depends_on_json AS "dependsOn",
          thread_id AS "threadId",
          pull_request_url AS "pullRequestUrl",
          needs_attention_at AS "needsAttentionAt",
          needs_attention_reason AS "needsAttentionReason",
          review_verdict AS "reviewVerdict",
          reviewer_thread_id AS "reviewerThreadId",
          reviewed_at AS "reviewedAt",
          review_notes AS "reviewNotes",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_issues
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, issue_id ASC
        LIMIT 1
      `,
  });

  const listProjectionIssueRows = SqlSchema.findAll({
    Request: ListProjectionIssuesByProjectInput,
    Result: ProjectionIssueDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          issue_id AS "issueId",
          project_id AS "projectId",
          title,
          description,
          status,
          priority,
          model_selection_json AS "modelSelection",
          depends_on_json AS "dependsOn",
          thread_id AS "threadId",
          pull_request_url AS "pullRequestUrl",
          needs_attention_at AS "needsAttentionAt",
          needs_attention_reason AS "needsAttentionReason",
          review_verdict AS "reviewVerdict",
          reviewer_thread_id AS "reviewerThreadId",
          reviewed_at AS "reviewedAt",
          review_notes AS "reviewNotes",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_issues
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, issue_id ASC
      `,
  });

  const upsert: ProjectionIssueRepositoryShape["upsert"] = (row) =>
    upsertProjectionIssueRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionIssueRepository.upsert:query")),
    );

  const getById: ProjectionIssueRepositoryShape["getById"] = (input) =>
    getProjectionIssueRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionIssueRepository.getById:query")),
    );

  const getByThreadId: ProjectionIssueRepositoryShape["getByThreadId"] = (input) =>
    getProjectionIssueRowByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionIssueRepository.getByThreadId:query")),
    );

  const listByProjectId: ProjectionIssueRepositoryShape["listByProjectId"] = (input) =>
    listProjectionIssueRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionIssueRepository.listByProjectId:query")),
    );

  return {
    upsert,
    getById,
    getByThreadId,
    listByProjectId,
  } satisfies ProjectionIssueRepositoryShape;
});

export const ProjectionIssueRepositoryLive = Layer.effect(
  ProjectionIssueRepository,
  makeProjectionIssueRepository,
);
