import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  // Nullable: only a session parked by provider exhaustion carries a resume
  // instant, so "no value" is the ordinary state and must not need backfilling.
  if (!columns.some((column) => column.name === "resume_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN resume_at TEXT
    `;
  }

  // The resume ticker asks "which sessions are due?" every minute, so the due
  // check must not scan every session row on a machine with a long history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_resume_at
    ON projection_thread_sessions (resume_at)
    WHERE resume_at IS NOT NULL
  `;
});
