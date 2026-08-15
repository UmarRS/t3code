import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Nullable rather than defaulted: the absence of a parent is the common case
  // and reads back as "an ordinary thread", so there is no sentinel to invent.
  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  // Which link the companion was spawned through. Kept alongside the parent so
  // a companion can be traced back to the edge that justified it even after
  // that link is removed from the project.
  if (!columns.some((column) => column.name === "origin_link_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN origin_link_id TEXT
    `;
  }

  // The sidebar filters companions out of the top-level list on every render,
  // and the coordinator looks one up per delegation; both scan on the parent.
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_parent_thread_id
    ON projection_threads (parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
