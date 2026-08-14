import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  CLAUDE_BACKUP_MODEL_BY_MODEL,
  claudeBackupModel,
  claudeBackupModelSelection,
  CODEX_BACKUP_INSTANCE_ID,
} from "./claudeBackupModels.ts";

it("backup instance is always the default codex instance", () => {
  assert.equal(CODEX_BACKUP_INSTANCE_ID, ProviderInstanceId.make("codex"));
});

it("maps every Claude model to its fixed codex backup", () => {
  assert.deepEqual(CLAUDE_BACKUP_MODEL_BY_MODEL, {
    "claude-fable-5": "gpt-5.6-sol",
    "claude-opus-5": "gpt-5.6-sol",
    "claude-opus-4-8": "gpt-5.5",
    "claude-opus-4-7": "gpt-5.5",
    "claude-opus-4-6": "gpt-5.4",
    "claude-opus-4-5": "gpt-5.4",
    "claude-sonnet-5": "gpt-5.5",
    "claude-sonnet-4-6": "gpt-5.4",
    "claude-haiku-4-5": "gpt-5.4-mini",
  });
  for (const [model, backup] of Object.entries(CLAUDE_BACKUP_MODEL_BY_MODEL)) {
    assert.equal(claudeBackupModel(model), backup);
  }
});

it("returns null for non-Claude and missing models", () => {
  assert.isNull(claudeBackupModel("gpt-5.6-sol"));
  assert.isNull(claudeBackupModel("gpt-5.5"));
  assert.isNull(claudeBackupModel("composer-2"));
  assert.isNull(claudeBackupModel("grok-build"));
  assert.isNull(claudeBackupModel(""));
  assert.isNull(claudeBackupModel(null));
  assert.isNull(claudeBackupModel(undefined));
});

it("falls back to gpt-5.5 for unknown Claude models", () => {
  assert.equal(claudeBackupModel("claude-opus-6"), "gpt-5.5");
  assert.equal(claudeBackupModel("claude-sonnet-6-0"), "gpt-5.5");
});

it("normalizes casing and whitespace before lookup", () => {
  assert.equal(claudeBackupModel(" Claude-Opus-5 "), "gpt-5.6-sol");
});

it("builds a codex backup selection and drops Claude-specific options", () => {
  const backup = claudeBackupModelSelection({ model: "claude-opus-5" });
  assert.deepEqual(backup, {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  });
});

it("returns null selection for a non-Claude primary (no ping-pong)", () => {
  assert.isNull(claudeBackupModelSelection({ model: "gpt-5.6-sol" }));
});
