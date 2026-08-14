import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_IssueModelSelection", (it) => {
  it.effect("adds a nullable model selection to existing issue rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_issues (
          issue_id, project_id, title, status, created_at, updated_at
        ) VALUES ('issue-1', 'project-1', 'Existing issue', 'backlog', 'now', 'now')
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });
      const rows = yield* sql<{ readonly modelSelection: string | null }>`
        SELECT model_selection_json AS "modelSelection" FROM projection_issues
      `;
      assert.deepEqual(rows, [{ modelSelection: null }]);
    }),
  );
});
