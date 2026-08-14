import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Issues are the planning layer above threads: one row per issue, soft
  // deleted like projects and threads so a delete never orphans events.
  // `depends_on_json` is defaulted rather than nullable so every row decodes as
  // an array without the row decoder special-casing anything.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_issues (
      issue_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      priority TEXT,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      thread_id TEXT,
      pull_request_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  // The dashboard reads a project's live backlog in creation order, and the
  // pull-request command resolves an issue from its linked thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_issues_project_created
    ON projection_issues (project_id, deleted_at, created_at, issue_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_issues_thread
    ON projection_issues (thread_id)
    WHERE thread_id IS NOT NULL
  `;
});
