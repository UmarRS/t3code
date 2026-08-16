import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionThreadsCompanion", (it) => {
  it.effect("adds nullable companion columns to existing thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-existing',
          'project-1',
          'Existing',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          0, 0, 0, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const parent = columns.find((column) => column.name === "parent_thread_id");
      const origin = columns.find((column) => column.name === "origin_link_id");
      assert.equal(parent?.name, "parent_thread_id");
      assert.equal(origin?.name, "origin_link_id");
      // Nullable: an ordinary thread has no parent, and null is that answer.
      assert.equal(parent?.notnull, 0);
      assert.equal(origin?.notnull, 0);

      const rows = yield* sql<{
        readonly parent_thread_id: string | null;
        readonly origin_link_id: string | null;
      }>`
        SELECT parent_thread_id, origin_link_id
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.equal(rows[0]?.parent_thread_id, null);
      assert.equal(rows[0]?.origin_link_id, null);
    }),
  );

  it.effect("indexes the parent so companion lookups do not scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(
        indexes.some((index) => index.name === "projection_threads_parent_thread_id"),
        "expected the parent thread index to exist",
      );
    }),
  );

  it.effect("is idempotent when the columns already exist", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 47 });
    }),
  );
});
