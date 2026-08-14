import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "focus_path")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN focus_path TEXT
    `;
  }

  // Defaulted rather than nullable so every row reads back as valid JSON and
  // the row decoder never has to special-case pre-scope threads.
  if (!columns.some((column) => column.name === "linked_paths_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_paths_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
