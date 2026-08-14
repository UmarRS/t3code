/**
 * Fixed Claude → Codex backup-model mapping used for automatic failover when a
 * Claude worker exhausts its credits/limits. The backup is derived at failure
 * time from this single deterministic table — it is never chosen by prompts or
 * stored on threads — so it covers generated stories and pre-existing threads
 * alike. The backup instance is always the default `codex` instance.
 *
 * @module claudeBackupModels
 */
import type { ModelSelection } from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";

export const CODEX_BACKUP_INSTANCE_ID = defaultInstanceIdForDriver(
  ProviderDriverKind.make("codex"),
);

export const CLAUDE_BACKUP_MODEL_BY_MODEL: Readonly<Record<string, string>> = {
  "claude-fable-5": "gpt-5.6-sol",
  "claude-opus-5": "gpt-5.6-sol",
  "claude-opus-4-8": "gpt-5.5",
  "claude-opus-4-7": "gpt-5.5",
  "claude-opus-4-6": "gpt-5.4",
  "claude-opus-4-5": "gpt-5.4",
  "claude-sonnet-5": "gpt-5.5",
  "claude-sonnet-4-6": "gpt-5.4",
  "claude-haiku-4-5": "gpt-5.4-mini",
};

/** Backup for Claude models the table does not know (future releases). */
const UNKNOWN_CLAUDE_BACKUP_MODEL = "gpt-5.5";

/**
 * Codex backup model for a Claude model slug. Returns null for anything that
 * is not a Claude model; unknown Claude models fall back to a safe default so
 * failover keeps working when a new Claude release lands before this table.
 */
export function claudeBackupModel(model: string | null | undefined): string | null {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (!normalized.startsWith("claude-")) {
    return null;
  }
  return CLAUDE_BACKUP_MODEL_BY_MODEL[normalized] ?? UNKNOWN_CLAUDE_BACKUP_MODEL;
}

/**
 * Full backup selection for a failing Claude selection, or null when the
 * selection is not a Claude model (this is what guarantees at most one
 * automatic failover: once a thread runs on the codex backup, no further
 * backup exists). Claude-specific option selections (context window, effort)
 * are deliberately dropped — they do not apply to codex models.
 */
export function claudeBackupModelSelection(
  selection: Pick<ModelSelection, "model">,
): ModelSelection | null {
  const backupModel = claudeBackupModel(selection.model);
  if (backupModel === null) {
    return null;
  }
  return {
    instanceId: CODEX_BACKUP_INSTANCE_ID,
    model: backupModel,
  };
}
