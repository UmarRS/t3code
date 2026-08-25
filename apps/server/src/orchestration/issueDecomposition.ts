import {
  IssueDecompositionBlock,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  isExistingIssueReference,
  isIssueOpenToRevision,
  IssueId,
  type IssuePriority,
  type IssueStatus,
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
  /** Workspace root of the linked project this story belongs on, if it named one. */
  readonly project: string | null;
  readonly dependsOnKeys: ReadonlyArray<string>;
  /** Dependencies that name an issue already on a board rather than a story here. */
  readonly dependsOnIssueIds: ReadonlyArray<IssueId>;
  /** The existing issue this story rewrites, if it revises one. */
  readonly updates: IssueId | null;
  /** Existing issues this story replaces, canceled when the plan is applied. */
  readonly supersedes: ReadonlyArray<IssueId>;
}

/**
 * An issue already on a board, as the parser needs to see it to check what a
 * block says about it. Callers that have no board to check against may leave
 * them out; the block-local rules are checked either way.
 */
export interface DecompositionRevisionCandidate {
  readonly id: IssueId;
  readonly status: IssueStatus;
  readonly threadId?: string | null | undefined;
  readonly needsAttentionAt?: string | null | undefined;
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
 * (forward references are fine) or issues that already exist, and nothing
 * depends on itself.
 *
 * Given the boards the block reaches, it also checks what the block says about
 * what is already on them: a story may only rewrite (`updates`) or replace
 * (`supersedes`) work nobody has started, no two stories may claim the same
 * one, and a plan may not depend on a story it is canceling.
 */
export const parseIssueDecomposition = Effect.fn("parseIssueDecomposition")(function* (
  markdown: string,
  options?: {
    /** Every issue the block may name, across the boards its stories route to. */
    readonly existingIssues?: ReadonlyArray<DecompositionRevisionCandidate> | undefined;
  },
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
      // A name this block does not define is an existing issue's id, which is
      // how a new story waits on work that is already planned.
      if (!keys.has(dependencyKey) && !isExistingIssueReference(dependencyKey)) {
        return {
          kind: "invalid",
          detail: `Story '${entry.key}' depends on unknown key '${dependencyKey}'.`,
        } as const;
      }
    }
  }

  const revisionFailure = validateRevisionTargets(decoded.entries, options?.existingIssues);
  if (revisionFailure !== null) {
    return { kind: "invalid", detail: revisionFailure } as const;
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
      project: entry.project ?? null,
      dependsOnKeys: (entry.dependsOn ?? []).filter((dependency) => keys.has(dependency)),
      dependsOnIssueIds: (entry.dependsOn ?? []).flatMap((dependency) =>
        keys.has(dependency) ? [] : [IssueId.make(dependency)],
      ),
      updates: entry.updates ?? null,
      supersedes: entry.supersedes ?? [],
    })),
  } as const;
});

/**
 * What the block says about issues that already exist, checked against them.
 * Returns the user-facing reason the block cannot be applied, or null.
 *
 * With no boards to check against there is nothing to say: the caller is
 * parsing the block for its shape alone, and the surface that applies it does
 * the checking.
 */
function validateRevisionTargets(
  entries: ReadonlyArray<{
    readonly key: string;
    readonly dependsOn?: ReadonlyArray<string> | undefined;
    readonly updates?: IssueId | undefined;
    readonly supersedes?: ReadonlyArray<IssueId> | undefined;
  }>,
  existingIssues: ReadonlyArray<DecompositionRevisionCandidate> | undefined,
): string | null {
  if (existingIssues === undefined) return null;
  const byId = new Map(existingIssues.map((issue) => [issue.id, issue] as const));
  const claimed = new Set<IssueId>();
  const canceled = new Set<IssueId>();

  for (const entry of entries) {
    const targets = [
      ...(entry.updates === undefined ? [] : [{ id: entry.updates, cancels: false }]),
      ...(entry.supersedes ?? []).map((id) => ({ id, cancels: true })),
    ];
    for (const target of targets) {
      const existing = byId.get(target.id);
      if (existing === undefined) {
        return `Story '${entry.key}' names issue '${target.id}', which is not on the board.`;
      }
      // A story this plan has already canceled reads as done rather than as
      // work it may not touch, so applying the same block twice is a no-op.
      const alreadyCanceled = target.cancels && existing.status === "canceled";
      if (!isIssueOpenToRevision(existing) && !alreadyCanceled) {
        return `Story '${entry.key}' ${target.cancels ? "supersedes" : "updates"} issue '${target.id}', which has already started.`;
      }
      if (claimed.has(target.id)) {
        return `Issue '${target.id}' is claimed by more than one story.`;
      }
      claimed.add(target.id);
      if (target.cancels) canceled.add(target.id);
    }
  }

  for (const entry of entries) {
    for (const dependency of entry.dependsOn ?? []) {
      if (canceled.has(IssueId.make(dependency))) {
        return `Story '${entry.key}' depends on issue '${dependency}', which this plan cancels.`;
      }
    }
  }
  return null;
}

/**
 * Kahn's algorithm, preserving the agent's ordering among ready entries. Only
 * the block's own stories are ordered: a dependency on an issue that already
 * exists is satisfied before the plan starts.
 */
function topologicallyOrder<
  Entry extends { readonly key: string; readonly dependsOn?: ReadonlyArray<string> | undefined },
>(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> | null {
  const remaining = new Map(entries.map((entry) => [entry.key, entry] as const));
  const keys = new Set(remaining.keys());
  const ordered: Entry[] = [];
  const placed = new Set<string>();
  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, entry] of remaining) {
      const ready = (entry.dependsOn ?? []).every(
        (dependencyKey) => !keys.has(dependencyKey) || placed.has(dependencyKey),
      );
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
  /** Workspace root of the linked project this story belongs on, if it named one. */
  readonly project: string | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
  /** True when this rewrites `issueId` rather than creating it. */
  readonly updatesExisting: boolean;
  /** Existing issues to cancel once the rest of the plan has been applied. */
  readonly supersedes: ReadonlyArray<IssueId>;
}

/**
 * Swap block-local keys for the real issue ids the caller minted, one per entry
 * in order. Dependencies resolve against the whole block, so a story may depend
 * on one defined after it, and a dependency naming an existing issue is carried
 * through untouched.
 *
 * A story that rewrites an existing issue keeps that issue's id; the id the
 * caller minted for it goes unused, which keeps the ids positional and the
 * caller free of the distinction.
 */
export function resolveIssueDecomposition(
  entries: ReadonlyArray<ParsedIssueDecompositionEntry>,
  issueIds: ReadonlyArray<IssueId>,
): ReadonlyArray<ResolvedIssueDecompositionEntry> {
  const idByKey = new Map<string, IssueId>();
  entries.forEach((entry, index) => {
    const issueId = entry.updates ?? issueIds[index];
    if (issueId !== undefined) {
      idByKey.set(entry.key, issueId);
    }
  });
  const resolved: ResolvedIssueDecompositionEntry[] = [];
  entries.forEach((entry, index) => {
    const issueId = entry.updates ?? issueIds[index];
    if (issueId === undefined) return;
    resolved.push({
      issueId,
      title: entry.title,
      description: entry.description,
      priority: entry.priority,
      modelSelection: entry.modelSelection,
      project: entry.project,
      dependsOn: [
        ...entry.dependsOnKeys.flatMap((key) => {
          const dependencyId = idByKey.get(key);
          return dependencyId === undefined ? [] : [dependencyId];
        }),
        ...entry.dependsOnIssueIds,
      ],
      updatesExisting: entry.updates !== null,
      supersedes: entry.supersedes,
    });
  });
  return resolved;
}
