import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_issues)
  `;

  // Which thread delegated this issue in from another project. Nullable rather
  // than defaulted: an ordinary issue has no delegating thread, and the absence
  // is exactly what "nobody delegated this" means. Non-null is also the signal
  // the autonomous run reactor reads to work the issue without a live run on
  // its project, so it has to survive a restart like any other issue state.
  if (!columns.some((column) => column.name === "delegated_from_thread_id")) {
    yield* sql`
      ALTER TABLE projection_issues
      ADD COLUMN delegated_from_thread_id TEXT
    `;
  }
});
