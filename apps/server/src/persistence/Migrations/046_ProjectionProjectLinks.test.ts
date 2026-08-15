import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionProjectLinks", (it) => {
  it.effect("adds the project links column to existing project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-existing',
          'Existing',
          '/repos/existing',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const links = columns.find((column) => column.name === "project_links_json");
      assert.equal(links?.name, "project_links_json");
      assert.equal(links?.notnull, 1);

      // Rows written before links existed have to read back as valid JSON.
      const rows = yield* sql<{ readonly project_links_json: string }>`
        SELECT project_links_json FROM projection_projects WHERE project_id = 'project-existing'
      `;
      assert.equal(rows[0]?.project_links_json, "[]");
    }),
  );

  it.effect("is idempotent when the column already exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 46 });
    }),
  );
});
