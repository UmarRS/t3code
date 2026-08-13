import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const issueColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_issues)
  `;
  const hasIssueColumn = (name: string) => issueColumns.some((column) => column.name === name);

  // Needs-attention is a flag beside the status, not a status of its own: an
  // issue keeps where it got to and is simply excluded from autonomous work.
  if (!hasIssueColumn("needs_attention_at")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN needs_attention_at TEXT`;
  }
  if (!hasIssueColumn("needs_attention_reason")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN needs_attention_reason TEXT`;
  }

  // Reviewer outcome. `review_notes` is defaulted rather than nullable for the
  // same reason `depends_on_json` is: every row then decodes without the row
  // decoder special-casing issues that predate reviews.
  if (!hasIssueColumn("review_verdict")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN review_verdict TEXT`;
  }
  if (!hasIssueColumn("reviewer_thread_id")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN reviewer_thread_id TEXT`;
  }
  if (!hasIssueColumn("reviewed_at")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN reviewed_at TEXT`;
  }
  if (!hasIssueColumn("review_notes")) {
    yield* sql`ALTER TABLE projection_issues ADD COLUMN review_notes TEXT NOT NULL DEFAULT ''`;
  }

  // Turn-completion ingestion resolves "which issue is this reviewer thread
  // reviewing" on every reviewer turn, so the lookup gets its own index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_issues_reviewer_thread
    ON projection_issues (reviewer_thread_id)
    WHERE reviewer_thread_id IS NOT NULL
  `;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const hasProjectColumn = (name: string) => projectColumns.some((column) => column.name === name);

  // Run state lives on the project: non-null started_at means a run is live,
  // and the finished pair records why the last one ended so the UI can tell a
  // completed run from a stopped one.
  if (!hasProjectColumn("autonomous_started_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN autonomous_started_at TEXT`;
  }
  if (!hasProjectColumn("autonomous_finished_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN autonomous_finished_at TEXT`;
  }
  if (!hasProjectColumn("autonomous_finished_reason")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN autonomous_finished_reason TEXT`;
  }
});
