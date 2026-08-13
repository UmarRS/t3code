import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_AutonomousMode", (it) => {
  it.effect("adds the attention flag and review columns to issues", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_issues)
      `;
      const byName = new Map(columns.map((column) => [column.name, column] as const));

      // The flag is nullable beside the status, not a status of its own.
      assert.equal(byName.get("needs_attention_at")?.notnull, 0);
      assert.equal(byName.get("needs_attention_reason")?.notnull, 0);
      assert.equal(byName.get("review_verdict")?.notnull, 0);
      assert.equal(byName.get("reviewer_thread_id")?.notnull, 0);
      assert.equal(byName.get("reviewed_at")?.notnull, 0);
      // Defaulted so pre-review rows decode without special-casing.
      assert.equal(byName.get("review_notes")?.notnull, 1);
      assert.equal(byName.get("review_notes")?.dflt_value, "''");
    }),
  );

  it.effect("adds the run-state columns to projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const names = new Set(columns.map((column) => column.name));

      assert.isTrue(names.has("autonomous_started_at"));
      assert.isTrue(names.has("autonomous_finished_at"));
      assert.isTrue(names.has("autonomous_finished_reason"));
    }),
  );

  it.effect("indexes the reviewer-thread lookup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_issues)
      `;
      assert.isTrue(
        indexes.some((index) => index.name === "idx_projection_issues_reviewer_thread"),
      );
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_issues)
      `;
      assert.equal(columns.filter((column) => column.name === "review_notes").length, 1);
    }),
  );
});
