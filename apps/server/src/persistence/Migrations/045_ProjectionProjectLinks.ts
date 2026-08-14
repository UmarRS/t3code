import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  // Cross-project links ride as JSON on the project row, like scripts_json:
  // they are read whole, written whole, and never queried by their fields.
  // Defaulted rather than nullable so every row reads back as valid JSON and
  // the row decoder never has to special-case pre-link projects.
  if (!columns.some((column) => column.name === "project_links_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN project_links_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
