import type { IssueDecompositionEntry, ProjectId } from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * Routing a decomposition block across boards.
 *
 * A plan for a feature rarely stops at one repository, and a story about the
 * backend has no business sitting on the frontend's board. Each entry may name
 * a linked project by workspace root; this module turns those names into the
 * project each story is actually created on, and rejects the one shape the
 * boards cannot represent — a dependency that crosses between them.
 *
 * Pure and path-based, so the same derivation serves the parser (which has
 * only the block) and the import card (which also has the projects).
 */

/** The minimum a project has to look like to receive routed stories. */
export interface DecompositionRoutingProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * An entry's project as a comparison key. `null` is the requesting project —
 * the same value an entry with no `project` gets, so "omitted" and "named the
 * board we are already on" group together instead of splitting one board in
 * two.
 */
export function decompositionEntryProjectKey(
  entry: Pick<IssueDecompositionEntry, "project">,
  currentWorkspaceRoot: string,
): string | null {
  if (entry.project === undefined) return null;
  const normalized = normalizeProjectPathForComparison(entry.project);
  return normalized === normalizeProjectPathForComparison(currentWorkspaceRoot) ? null : normalized;
}

/**
 * The first dependency that crosses a project boundary, or `null` when every
 * dependency stays on its own board.
 *
 * Cross-board dependencies are refused rather than dropped. An issue's
 * `dependsOn` is validated against its own project's backlog when it is
 * created, so a dependency naming a story on another board is rejected outright
 * — and because stories are created one at a time, letting the block through
 * would half-import the plan. The agent has to express the ordering some other
 * way: the delegating story's description, or a linked-project handoff at run
 * time.
 *
 * Compared by raw `project` value: this runs on the block alone, before any
 * workspace root is known, so two entries agree when they name the same
 * project and disagree otherwise.
 */
export function findCrossProjectDependency(
  entries: ReadonlyArray<Pick<IssueDecompositionEntry, "key" | "project" | "dependsOn">>,
): { readonly key: string; readonly dependencyKey: string } | null {
  const projectByKey = new Map(
    entries.map(
      (entry) =>
        [
          entry.key,
          entry.project === undefined ? null : normalizeProjectPathForComparison(entry.project),
        ] as const,
    ),
  );
  for (const entry of entries) {
    const project = projectByKey.get(entry.key) ?? null;
    for (const dependencyKey of entry.dependsOn ?? []) {
      // An unknown key is the caller's error to report, not ours to guess at.
      if (!projectByKey.has(dependencyKey)) continue;
      if ((projectByKey.get(dependencyKey) ?? null) !== project) {
        return { key: entry.key, dependencyKey };
      }
    }
  }
  return null;
}

/** One board's share of a decomposition block. */
export interface DecompositionRoutingGroup<TEntry> {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly entries: ReadonlyArray<TEntry>;
  /**
   * Workspace roots the block named that resolve to no routable project, and
   * whose stories therefore fall back onto this group. Only ever set on the
   * requesting project's group.
   */
  readonly unroutablePaths: ReadonlyArray<string>;
}

/**
 * Split a block into the boards its stories belong on.
 *
 * The requesting project always comes first and always exists, even with no
 * stories of its own, so the import card has something to anchor an empty-state
 * on. A story naming a folder that is not a routable project falls back to the
 * requesting board rather than being dropped — a link can be removed between
 * planning and import, and losing the story would be worse than misfiling it —
 * and the path comes back in `unroutablePaths` so the card can say so.
 */
export function groupDecompositionEntriesByProject<
  TEntry extends Pick<IssueDecompositionEntry, "project">,
>(input: {
  readonly entries: ReadonlyArray<TEntry>;
  readonly currentProject: DecompositionRoutingProject;
  readonly linkedProjects: ReadonlyArray<DecompositionRoutingProject>;
}): ReadonlyArray<DecompositionRoutingGroup<TEntry>> {
  const targetByPath = new Map(
    input.linkedProjects
      .filter((project) => project.id !== input.currentProject.id)
      .map((project) => [normalizeProjectPathForComparison(project.workspaceRoot), project]),
  );

  const current = {
    project: input.currentProject,
    entries: [] as TEntry[],
    unroutablePaths: [] as string[],
  };
  const routed = new Map<ProjectId, { project: DecompositionRoutingProject; entries: TEntry[] }>();

  for (const entry of input.entries) {
    const key = decompositionEntryProjectKey(entry, input.currentProject.workspaceRoot);
    if (key === null) {
      current.entries.push(entry);
      continue;
    }
    const target = targetByPath.get(key);
    if (target === undefined) {
      current.entries.push(entry);
      if (entry.project !== undefined && !current.unroutablePaths.includes(entry.project)) {
        current.unroutablePaths.push(entry.project);
      }
      continue;
    }
    const group = routed.get(target.id) ?? { project: target, entries: [] };
    group.entries.push(entry);
    routed.set(target.id, group);
  }

  return [
    {
      projectId: current.project.id,
      title: current.project.title,
      entries: current.entries,
      unroutablePaths: current.unroutablePaths,
    },
    ...[...routed.values()].map((group) => ({
      projectId: group.project.id,
      title: group.project.title,
      entries: group.entries as ReadonlyArray<TEntry>,
      unroutablePaths: [] as ReadonlyArray<string>,
    })),
  ];
}
