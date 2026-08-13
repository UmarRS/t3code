import {
  IssueDecompositionBlock,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  type IssueId,
  type IssuePriority,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { extractFencedBlocks } from "./fencedBlocks.ts";

/**
 * Story decomposition: an agent asked to break a feature into stories ends its
 * final message with one fenced ```t3-issues block of JSON. This module turns
 * that message into issue-shaped data and nothing else — no dispatching, no
 * clock, no ids. The caller supplies the ids, which is what lets the same
 * parser be exercised exhaustively in tests.
 *
 * Nothing here ever throws or fails: a malformed block is a *result*, so the
 * ingestion path can surface it to the user as an activity instead of dropping
 * a turn on the floor.
 */

/** One story after validation, with dependencies still expressed as block keys. */
export interface ParsedIssueDecompositionEntry {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly priority: IssuePriority | null;
  readonly modelSelection: ModelSelection | null;
  readonly dependsOnKeys: ReadonlyArray<string>;
}

export type IssueDecompositionParseResult =
  /** No `t3-issues` fence in the message. The overwhelmingly common case. */
  | { readonly kind: "absent" }
  /** A fence was found but its contents are unusable; `detail` is user-facing. */
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "parsed"; readonly entries: ReadonlyArray<ParsedIssueDecompositionEntry> };

// One decode does both jobs: parse the JSON text and validate its shape, so a
// syntax error and a wrong shape surface through the same reported detail.
const decodeBlock = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueDecompositionBlock));

/**
 * Parse the decomposition block out of an assistant message. Validates the JSON
 * against the contract schema, then checks the block-local invariants the
 * schema cannot see: keys are unique, dependencies name keys in this same block
 * (forward references are fine), and nothing depends on itself.
 */
export const parseIssueDecomposition = Effect.fn("parseIssueDecomposition")(function* (
  markdown: string,
): Effect.fn.Return<IssueDecompositionParseResult> {
  const blocks = extractFencedBlocks(markdown, ISSUE_DECOMPOSITION_BLOCK_LANGUAGE);
  if (blocks.length === 0) {
    return { kind: "absent" } as const;
  }
  if (blocks.length > 1) {
    return {
      kind: "invalid",
      detail: `Found ${blocks.length} ${ISSUE_DECOMPOSITION_BLOCK_LANGUAGE} blocks; expected exactly one.`,
    } as const;
  }

  const decoded = yield* decodeBlock(blocks[0] ?? "").pipe(
    Effect.map((entries) => ({ ok: true as const, entries })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
  );
  if (!decoded.ok) {
    return {
      kind: "invalid",
      detail: `Block is not a valid list of stories: ${decoded.message}`,
    } as const;
  }

  const keys = new Set<string>();
  for (const entry of decoded.entries) {
    if (keys.has(entry.key)) {
      return { kind: "invalid", detail: `Duplicate story key '${entry.key}'.` } as const;
    }
    keys.add(entry.key);
  }
  for (const entry of decoded.entries) {
    for (const dependencyKey of entry.dependsOn ?? []) {
      if (dependencyKey === entry.key) {
        return { kind: "invalid", detail: `Story '${entry.key}' depends on itself.` } as const;
      }
      if (!keys.has(dependencyKey)) {
        return {
          kind: "invalid",
          detail: `Story '${entry.key}' depends on unknown key '${dependencyKey}'.`,
        } as const;
      }
    }
  }

  // Emitted in dependency order so the caller can create the issues one by one
  // and every `dependsOn` already names an issue that exists. A block that
  // cannot be ordered has a cycle, which is a planning mistake worth telling
  // the user about rather than half-creating.
  const ordered = topologicallyOrder(decoded.entries);
  if (ordered === null) {
    return {
      kind: "invalid",
      detail: "Story dependencies form a cycle.",
    } as const;
  }

  return {
    kind: "parsed",
    entries: ordered.map((entry) => ({
      key: entry.key,
      title: entry.title,
      description: entry.description,
      priority: entry.priority ?? null,
      modelSelection: entry.modelSelection ?? null,
      dependsOnKeys: entry.dependsOn ?? [],
    })),
  } as const;
});

/** Kahn's algorithm, preserving the agent's ordering among ready entries. */
function topologicallyOrder<
  Entry extends { readonly key: string; readonly dependsOn?: ReadonlyArray<string> | undefined },
>(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> | null {
  const remaining = new Map(entries.map((entry) => [entry.key, entry] as const));
  const ordered: Entry[] = [];
  const placed = new Set<string>();
  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, entry] of remaining) {
      const ready = (entry.dependsOn ?? []).every((dependencyKey) => placed.has(dependencyKey));
      if (!ready) continue;
      ordered.push(entry);
      placed.add(key);
      remaining.delete(key);
      progressed = true;
    }
    if (!progressed) return null;
  }
  return ordered;
}

export interface ResolvedIssueDecompositionEntry {
  readonly issueId: IssueId;
  readonly title: string;
  readonly description: string;
  readonly priority: IssuePriority | null;
  readonly modelSelection: ModelSelection | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
}

/**
 * Swap block-local keys for the real issue ids the caller minted, one per entry
 * in order. Dependencies resolve against the whole block, so a story may depend
 * on one defined after it.
 */
export function resolveIssueDecomposition(
  entries: ReadonlyArray<ParsedIssueDecompositionEntry>,
  issueIds: ReadonlyArray<IssueId>,
): ReadonlyArray<ResolvedIssueDecompositionEntry> {
  const idByKey = new Map<string, IssueId>();
  entries.forEach((entry, index) => {
    const issueId = issueIds[index];
    if (issueId !== undefined) {
      idByKey.set(entry.key, issueId);
    }
  });
  const resolved: ResolvedIssueDecompositionEntry[] = [];
  entries.forEach((entry, index) => {
    const issueId = issueIds[index];
    if (issueId === undefined) return;
    resolved.push({
      issueId,
      title: entry.title,
      description: entry.description,
      priority: entry.priority,
      modelSelection: entry.modelSelection,
      dependsOn: entry.dependsOnKeys.flatMap((key) => {
        const dependencyId = idByKey.get(key);
        return dependencyId === undefined ? [] : [dependencyId];
      }),
    });
  });
  return resolved;
}
