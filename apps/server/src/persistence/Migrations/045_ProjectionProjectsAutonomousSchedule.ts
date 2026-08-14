import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  // Defaulted rather than nullable so every row reads back as valid JSON and
  // the row decoder never has to special-case projects that predate schedules.
  if (!columns.some((column) => column.name === "autonomous_schedule_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN autonomous_schedule_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
