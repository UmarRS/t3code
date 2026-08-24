import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_issues)
  `;

  // The structured half of the needs-attention flag, alongside the free-text
  // reason. Nullable with no backfill on purpose: every issue parked before
  // this column existed was parked for a reason nobody classified, and
  // guessing a kind out of its prose here would bake one substring match into
  // the database forever. Null means unclassified, and the UI falls back to
  // reading the reason for exactly those rows.
  if (!columns.some((column) => column.name === "needs_attention_kind")) {
    yield* sql`
      ALTER TABLE projection_issues
      ADD COLUMN needs_attention_kind TEXT
    `;
  }
});
