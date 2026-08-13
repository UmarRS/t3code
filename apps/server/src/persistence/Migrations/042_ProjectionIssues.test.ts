import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionIssues", (it) => {
  it.effect("creates the issue projection table with defaulted list columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_issues)
      `;
      const byName = new Map(columns.map((column) => [column.name, column] as const));

      assert.equal(byName.get("issue_id")?.pk, 1);
      // Defaulted, not nullable, so every row reads back as valid JSON and the
      // row decoder never special-cases a pre-existing row.
      assert.equal(byName.get("depends_on_json")?.notnull, 1);
      assert.equal(byName.get("depends_on_json")?.dflt_value, "'[]'");
      assert.equal(byName.get("description")?.notnull, 1);
      // Soft delete and the optional links stay nullable.
      assert.equal(byName.get("deleted_at")?.notnull, 0);
      assert.equal(byName.get("thread_id")?.notnull, 0);
      assert.equal(byName.get("priority")?.notnull, 0);
      assert.equal(byName.get("pull_request_url")?.notnull, 0);
    }),
  );

  it.effect("indexes the dashboard and pull-request lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_issues)
      `;
      const names = new Set(indexes.map((index) => index.name));

      assert.isTrue(names.has("idx_projection_issues_project_created"));
      assert.isTrue(names.has("idx_projection_issues_thread"));
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_issues'
      `;
      assert.equal(tables.length, 1);
    }),
  );
});
