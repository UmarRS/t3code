import { sha256 } from "@noble/hashes/sha2";
import {
  IssueDecompositionBlock,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  IssueId,
  type IssueDecompositionEntry,
  type MessageId,
} from "@t3tools/contracts";
import { findCrossProjectDependency } from "@t3tools/shared/issueDecompositionRouting";
import * as Schema from "effect/Schema";

const decodeIssueDecompositionBlock = Schema.decodeUnknownSync(IssueDecompositionBlock);

/**
 * Reads the single structured story block from a completed assistant message.
 * Invalid or ambiguous output stays ordinary chat instead of exposing an
 * action that could create only part of the plan.
 */
export function parseIssueDecompositionForImport(
  markdown: string,
): ReadonlyArray<IssueDecompositionEntry> | null {
  const escapedLanguage = ISSUE_DECOMPOSITION_BLOCK_LANGUAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    "(?:^|\\n)\\s*```" + escapedLanguage + "\\s*\\n([\\s\\S]*?)\\n\\s*```",
    "g",
  );
  const blocks = [...markdown.matchAll(pattern)];
  if (blocks.length !== 1) return null;

  try {
    const decoded = decodeIssueDecompositionBlock(JSON.parse(blocks[0]?.[1] ?? ""));
    return topologicallyOrder(decoded);
  } catch {
    return null;
  }
}

function topologicallyOrder(
  entries: ReadonlyArray<IssueDecompositionEntry>,
): ReadonlyArray<IssueDecompositionEntry> | null {
  const byKey = new Map<string, IssueDecompositionEntry>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) return null;
    byKey.set(entry.key, entry);
  }
  for (const entry of entries) {
    for (const dependency of entry.dependsOn ?? []) {
      if (dependency === entry.key || !byKey.has(dependency)) return null;
    }
  }
  // A dependency across boards cannot be created at all, so the block is
  // unusable rather than partly usable.
  if (findCrossProjectDependency(entries) !== null) return null;

  const remaining = new Map(byKey);
  const placed = new Set<string>();
  const ordered: IssueDecompositionEntry[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, entry] of remaining) {
      if (!(entry.dependsOn ?? []).every((dependency) => placed.has(dependency))) continue;
      remaining.delete(key);
      placed.add(key);
      ordered.push(entry);
      progressed = true;
    }
    if (!progressed) return null;
  }
  return ordered;
}

/**
 * Stable ids make the import safe to retry and consistent across web, desktop,
 * and remote clients. The message and block-local key are the namespace.
 */
export function issueIdForDecompositionEntry(messageId: MessageId, key: string): IssueId {
  const bytes = sha256(new TextEncoder().encode(`${messageId}:${key}`)).slice(0, 16);
  // UUIDv8 is explicitly application-defined, which matches this SHA-256 namespace scheme.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return IssueId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}
