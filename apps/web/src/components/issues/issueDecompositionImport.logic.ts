import { sha256 } from "@noble/hashes/sha2";
import {
  findIssueDependencyCycle,
  IssueDecompositionBlock,
  ISSUE_DECOMPOSITION_BLOCK_LANGUAGE,
  isExistingIssueReference,
  isIssueOpenToRevision,
  IssueId,
  type IssueDecompositionEntry,
  type IssuePriority,
  type IssueStatus,
  type MessageId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import {
  groupDecompositionEntriesByProject,
  type DecompositionRoutingProject,
} from "@t3tools/shared/issueDecompositionRouting";
import * as Schema from "effect/Schema";

const decodeIssueDecompositionBlock = Schema.decodeUnknownSync(IssueDecompositionBlock);

/**
 * Reads the single structured story block from a completed assistant message.
 * Invalid or ambiguous output stays ordinary chat instead of exposing an
 * action that could create only part of the plan.
 *
 * This is the half that needs nothing but the message: shape, unique keys, and
 * an acyclic order over the stories the block defines. Everything a block says
 * about issues that already exist is checked against the boards themselves, by
 * `planIssueDecompositionImport`.
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
      if (dependency === entry.key) return null;
      // A dependency this block does not define names an issue that already
      // exists; whether it really does is a question for the board.
      if (!byKey.has(dependency) && !isExistingIssueReference(dependency)) return null;
    }
  }
  const remaining = new Map(byKey);
  const placed = new Set<string>();
  const ordered: IssueDecompositionEntry[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [key, entry] of remaining) {
      if (
        !(entry.dependsOn ?? []).every(
          (dependency) => !byKey.has(dependency) || placed.has(dependency),
        )
      ) {
        continue;
      }
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
 * and remote clients. The message and block-local key are the namespace — a
 * story is created with the id that message would always give it.
 *
 * An entry that rewrites an existing story is the exception: it has an id
 * already, and deriving a second one would file the revision beside the story
 * it was meant to replace.
 */
export function issueIdForDecompositionEntry(
  messageId: MessageId,
  entry: Pick<IssueDecompositionEntry, "key" | "updates"> | string,
): IssueId {
  if (typeof entry !== "string" && entry.updates !== undefined) return entry.updates;
  const key = typeof entry === "string" ? entry : entry.key;
  const bytes = sha256(new TextEncoder().encode(`${messageId}:${key}`)).slice(0, 16);
  // UUIDv8 is explicitly application-defined, which matches this SHA-256 namespace scheme.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return IssueId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/** An issue already on one of the boards in scope, as the import reads it. */
export interface DecompositionImportIssue {
  readonly id: IssueId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: IssueStatus;
  readonly priority: IssuePriority | null;
  readonly modelSelection?: ModelSelection | null | undefined;
  readonly dependsOn: ReadonlyArray<IssueId>;
  readonly threadId?: string | null | undefined;
  readonly needsAttentionAt?: string | null | undefined;
}

/** The fields an entry writes, resolved to real ids. */
export interface PlannedIssueFields {
  readonly issueId: IssueId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  readonly priority: IssuePriority | null;
  readonly modelSelection: ModelSelection | null;
  readonly dependsOn: ReadonlyArray<IssueId>;
}

export interface PlannedIssueCreate extends PlannedIssueFields {
  readonly key: string;
}

export interface PlannedIssueUpdate extends PlannedIssueFields {
  readonly key: string;
  /** The story being rewritten, as it stands on the board right now. */
  readonly existing: DecompositionImportIssue;
  /**
   * True once the board already reads the way this entry would leave it, as
   * far as a summary can tell — the description does not ride the board's
   * rows, so this is what the card shows and not a reason to skip the write.
   */
  readonly applied: boolean;
  /** Whether the story is still work nobody has picked up, and safe to rewrite. */
  readonly revisable: boolean;
}

export interface PlannedIssueCancel {
  readonly issue: DecompositionImportIssue;
  readonly projectId: ProjectId;
  /** The story that replaces it, for the card to name. */
  readonly replacedByTitle: string;
  readonly applied: boolean;
}

/** One board's share of the plan. */
export interface IssueDecompositionImportGroup {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly creates: ReadonlyArray<PlannedIssueCreate>;
  readonly updates: ReadonlyArray<PlannedIssueUpdate>;
  readonly cancels: ReadonlyArray<PlannedIssueCancel>;
}

export interface IssueDecompositionImportPlan {
  readonly groups: ReadonlyArray<IssueDecompositionImportGroup>;
  /** Every creation in dependency order, across boards. */
  readonly creates: ReadonlyArray<PlannedIssueCreate>;
  readonly updates: ReadonlyArray<PlannedIssueUpdate>;
  readonly cancels: ReadonlyArray<PlannedIssueCancel>;
  /** Named workspace roots that route nowhere, so the card can say so. */
  readonly unroutablePaths: ReadonlyArray<string>;
}

function sameIds(left: ReadonlyArray<IssueId>, right: ReadonlyArray<IssueId>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameModelSelection(
  left: ModelSelection | null,
  right: ModelSelection | null | undefined,
): boolean {
  const other = right ?? null;
  if (left === null || other === null) return left === other;
  return left.instanceId === other.instanceId && left.model === other.model;
}

/**
 * Turns a parsed block into what applying it would actually do to the boards:
 * which stories are created, which existing ones are rewritten, and which are
 * canceled because something replaced them.
 *
 * Returns null when the block cannot be applied as a whole — a story naming an
 * issue that does not exist, that lives on another board, or that someone has
 * already started — which keeps a revision that would half-apply out of the UI
 * entirely, exactly as a dependency cycle does.
 *
 * An already-applied plan still plans: every action reports whether the board
 * already reads that way, so pressing the button twice is a no-op rather than
 * a second set of stories.
 */
export function planIssueDecompositionImport(input: {
  readonly entries: ReadonlyArray<IssueDecompositionEntry>;
  readonly messageId: MessageId;
  readonly currentProject: DecompositionRoutingProject;
  readonly linkedProjects: ReadonlyArray<DecompositionRoutingProject>;
  /** Every issue on the boards this block can reach. */
  readonly issues: ReadonlyArray<DecompositionImportIssue>;
}): IssueDecompositionImportPlan | null {
  const groups = groupDecompositionEntriesByProject({
    entries: input.entries,
    currentProject: input.currentProject,
    linkedProjects: input.linkedProjects,
  });
  const projectIdByKey = new Map(
    groups.flatMap((group) => group.entries.map((entry) => [entry.key, group.projectId] as const)),
  );
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue] as const));
  const issueIdByKey = new Map(
    input.entries.map(
      (entry) => [entry.key, issueIdForDecompositionEntry(input.messageId, entry)] as const,
    ),
  );

  // One story may only be claimed by one entry: two entries rewriting the same
  // issue, or one rewriting what another cancels, is a plan with no single
  // outcome.
  const claimed = new Set<IssueId>();
  const canceledIds = new Set<IssueId>();
  const claim = (issueId: IssueId): boolean => {
    if (claimed.has(issueId)) return false;
    claimed.add(issueId);
    return true;
  };

  const updates: PlannedIssueUpdate[] = [];
  const cancels: PlannedIssueCancel[] = [];
  for (const entry of input.entries) {
    const entryProjectId = projectIdByKey.get(entry.key);
    if (entryProjectId === undefined) return null;
    if (entry.updates !== undefined) {
      const existing = issuesById.get(entry.updates);
      if (existing === undefined) return null;
      if (existing.projectId !== entryProjectId) return null;
      // Whether it may still be rewritten is settled below, once the fields
      // this entry would write are resolved: a rewrite that already landed
      // stays valid even after somebody picks the story up.
      if (!claim(existing.id)) return null;
    }
    for (const supersededId of entry.supersedes ?? []) {
      const existing = issuesById.get(supersededId);
      if (existing === undefined) return null;
      if (existing.projectId !== entryProjectId) return null;
      // A story this block has already canceled reads as done, not as a
      // started story it may not touch — that is what makes a second apply a
      // no-op instead of an invalid block.
      const alreadyCanceled =
        existing.status === "canceled" &&
        existing.threadId == null &&
        existing.needsAttentionAt == null;
      if (!isIssueOpenToRevision(existing) && !alreadyCanceled) return null;
      if (!claim(existing.id)) return null;
      canceledIds.add(existing.id);
      cancels.push({
        issue: existing,
        projectId: entryProjectId,
        replacedByTitle: entry.title,
        applied: alreadyCanceled,
      });
    }
  }

  const creates: PlannedIssueCreate[] = [];
  for (const entry of input.entries) {
    const entryProjectId = projectIdByKey.get(entry.key);
    const issueId = issueIdByKey.get(entry.key);
    if (entryProjectId === undefined || issueId === undefined) return null;

    const dependsOn: IssueId[] = [];
    for (const dependency of entry.dependsOn ?? []) {
      const withinBlock = issueIdByKey.get(dependency);
      if (withinBlock !== undefined) {
        dependsOn.push(withinBlock);
        continue;
      }
      const existingId = IssueId.make(dependency);
      // Waiting on a story this same plan cancels is a story that never starts.
      if (canceledIds.has(existingId)) return null;
      // A dependency whose issue is gone does not block, here as everywhere.
      if (issuesById.has(existingId)) dependsOn.push(existingId);
    }

    const fields: PlannedIssueFields = {
      issueId,
      projectId: entryProjectId,
      title: entry.title,
      description: entry.description,
      priority: entry.priority ?? null,
      modelSelection: entry.modelSelection ?? null,
      dependsOn,
    };
    if (entry.updates === undefined) {
      creates.push({ ...fields, key: entry.key });
      continue;
    }
    const existing = issuesById.get(entry.updates);
    if (existing === undefined) return null;
    // The description is the one field a board summary does not carry, so this
    // says the visible fields already match, not that the rewrite landed.
    const applied =
      existing.title === fields.title &&
      existing.priority === fields.priority &&
      sameModelSelection(fields.modelSelection, existing.modelSelection) &&
      sameIds(existing.dependsOn, fields.dependsOn);
    const revisable = isIssueOpenToRevision(existing);
    // A story that already reads the way this entry would leave it has nothing
    // left to rewrite, so starting it afterwards must not retroactively make
    // the block invalid and take the card out of the transcript.
    if (!revisable && !applied) return null;
    updates.push({ ...fields, key: entry.key, existing, applied, revisable });
  }

  // The graph the plan would leave behind, so a revision cannot quietly draw a
  // cycle through stories that already exist.
  const projected = new Map<
    IssueId,
    { readonly id: IssueId; readonly dependsOn: ReadonlyArray<IssueId> }
  >(input.issues.map((issue) => [issue.id, { id: issue.id, dependsOn: issue.dependsOn }] as const));
  for (const planned of [...creates, ...updates]) {
    projected.set(planned.issueId, { id: planned.issueId, dependsOn: planned.dependsOn });
  }
  const graph = [...projected.values()];
  for (const planned of [...creates, ...updates]) {
    if (
      findIssueDependencyCycle(graph, {
        issueId: planned.issueId,
        dependsOn: planned.dependsOn,
      }) !== null
    ) {
      return null;
    }
  }

  return {
    groups: groups.map((group) => ({
      projectId: group.projectId,
      title: group.title,
      creates: creates.filter((planned) => planned.projectId === group.projectId),
      updates: updates.filter((planned) => planned.projectId === group.projectId),
      cancels: cancels.filter((planned) => planned.projectId === group.projectId),
    })),
    creates,
    updates,
    cancels,
    unroutablePaths: groups[0]?.unroutablePaths ?? [],
  };
}

/** Whether a plan has anything left to do against the board as it stands now. */
export function isIssueDecompositionImportApplied(
  plan: IssueDecompositionImportPlan,
  input: {
    readonly existingIssueIds: ReadonlySet<IssueId>;
    /** Ids this session has already written, before the board catches up. */
    readonly completedIds: ReadonlySet<IssueId>;
  },
): boolean {
  const created = (planned: PlannedIssueCreate) =>
    input.existingIssueIds.has(planned.issueId) || input.completedIds.has(planned.issueId);
  return (
    plan.creates.every(created) &&
    plan.updates.every((planned) => planned.applied || input.completedIds.has(planned.issueId)) &&
    plan.cancels.every((planned) => planned.applied || input.completedIds.has(planned.issue.id))
  );
}
