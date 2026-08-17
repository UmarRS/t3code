import type { IssueStatus, OrchestrationIssue } from "@t3tools/contracts";

/**
 * How many issue sub-rows a project shows before collapsing the remainder
 * into a single "+N more" row. The sidebar's job here is a glance at what is
 * moving, not a second issues board — five rows keeps a project's block
 * shorter than the thread list it sits above.
 */
export const SIDEBAR_PROJECT_ISSUE_LIMIT = 5;

/**
 * Sorts favorites to the top while leaving everything else in the order the
 * caller already decided (manual project order or the sidebar's activity
 * sort). Stable within each partition on purpose: favoriting a project must
 * move exactly that row and nothing else.
 */
export function sortProjectsWithFavoritesFirst<T>(
  projects: ReadonlyArray<T>,
  isFavorite: (project: T) => boolean,
): T[] {
  const favorites: T[] = [];
  const rest: T[] = [];
  for (const project of projects) {
    (isFavorite(project) ? favorites : rest).push(project);
  }
  return [...favorites, ...rest];
}

/**
 * Favorites open by default so the projects the user cares about show their
 * work without a click, but an explicit toggle always wins — including
 * "collapsed" on a favorite, which is why the store records absence rather
 * than seeding a default.
 */
export function resolveProjectExpanded(input: {
  readonly explicit: boolean | undefined;
  readonly isFavorite: boolean;
}): boolean {
  return input.explicit ?? input.isFavorite;
}

export type SidebarProjectIssueKind = "running" | "settled";

export interface SidebarProjectIssueEntry {
  readonly issue: OrchestrationIssue;
  readonly kind: SidebarProjectIssueKind;
  readonly needsAttention: boolean;
}

export interface SidebarProjectIssueList {
  readonly entries: ReadonlyArray<SidebarProjectIssueEntry>;
  /** Issues that matched but did not fit under the cap; 0 hides the "+N more" row. */
  readonly hiddenCount: number;
}

function issueKind(status: IssueStatus): SidebarProjectIssueKind | null {
  if (status === "in_progress" || status === "in_review") return "running";
  // `done` only. `archived` is finished work already filed away and `canceled`
  // is work that never happened — neither is worth a sidebar row.
  if (status === "done") return "settled";
  return null;
}

/** Newest-touched first, with the id as a tiebreaker so the order is total. */
function compareRecency(a: OrchestrationIssue, b: OrchestrationIssue): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Picks the issues worth showing under a project row and orders them by how
 * much they want a human: flagged work first (it is blocked on the user),
 * then whatever is running, then recently finished work as context. Deleted
 * issues never appear — they are tombstones the board hides too.
 */
export function selectSidebarProjectIssues(
  issues: ReadonlyArray<OrchestrationIssue>,
  options?: { readonly limit?: number },
): SidebarProjectIssueList {
  const limit = options?.limit ?? SIDEBAR_PROJECT_ISSUE_LIMIT;
  const matched = issues.flatMap((issue): SidebarProjectIssueEntry[] => {
    if (issue.deletedAt != null) return [];
    const kind = issueKind(issue.status);
    if (kind === null) return [];
    return [{ issue, kind, needsAttention: issue.needsAttentionAt != null }];
  });
  const rank = (entry: SidebarProjectIssueEntry) =>
    entry.needsAttention && entry.kind === "running" ? 0 : entry.kind === "running" ? 1 : 2;
  const ordered = matched
    .slice()
    .sort((a, b) => rank(a) - rank(b) || compareRecency(a.issue, b.issue));
  return {
    entries: limit >= 0 ? ordered.slice(0, limit) : ordered,
    hiddenCount: limit >= 0 ? Math.max(0, ordered.length - limit) : 0,
  };
}
