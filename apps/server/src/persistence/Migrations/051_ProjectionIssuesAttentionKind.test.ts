import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionIssuesAttentionKind", (it) => {
  it.effect("leaves an already-flagged issue unclassified rather than guessing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO projection_issues (
          issue_id, project_id, title, status,
          needs_attention_at, needs_attention_reason,
          created_at, updated_at
        ) VALUES (
          'issue-1', 'project-1', 'Parked before kinds existed', 'in_progress',
          'then', 'Could not open a pull request: GitHub CLI command failed.',
          'now', 'now'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });
      const rows = yield* sql<{
        readonly reason: string | null;
        readonly kind: string | null;
      }>`
        SELECT
          needs_attention_reason AS "reason",
          needs_attention_kind AS "kind"
        FROM projection_issues
        WHERE issue_id = 'issue-1'
      `;
      assert.deepEqual(rows, [
        { reason: "Could not open a pull request: GitHub CLI command failed.", kind: null },
      ]);
    }),
  );

  it.effect("round-trips a kind written after the migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO projection_issues (
          issue_id, project_id, title, status,
          needs_attention_at, needs_attention_reason, needs_attention_kind,
          created_at, updated_at
        ) VALUES (
          'issue-2', 'project-1', 'Nobody reviewed this', 'in_review',
          'then', 'The reviewer could not run.', 'review_unavailable',
          'now', 'now'
        )
      `;
      const rows = yield* sql<{ readonly kind: string | null }>`
        SELECT needs_attention_kind AS "kind" FROM projection_issues
        WHERE issue_id = 'issue-2'
      `;
      assert.deepEqual(rows, [{ kind: "review_unavailable" }]);
    }),
  );
});
