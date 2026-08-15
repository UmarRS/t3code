import type { ProjectId, ProjectLink } from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * Cross-project links are stored on one side only: the project that created
 * the link owns the single edge. Everything the other side sees — the mirror —
 * is derived here, from the same list, so there is one source of truth and
 * removing the edge removes the link for both projects at once.
 *
 * Derivation is pure and takes the projects it should consider, which callers
 * scope to one environment: a link path names a folder on the machine that
 * owns the project, and the same absolute path on another machine is a
 * different folder.
 */

/** The minimum a project has to look like to take part in link derivation. */
export interface ProjectLinkProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly links?: ReadonlyArray<ProjectLink> | undefined;
}

/**
 * One link as a project sees it. `path` and `description` are already resolved
 * for this side of the link, so a caller building agent context or a settings
 * row never has to know whether it is looking at an owned edge or a mirror.
 */
export interface ProjectLinkView {
  readonly link: ProjectLink;
  /** Project that stores the edge. Remove commands resolve back to it. */
  readonly ownerProjectId: ProjectId;
  /** Absolute folder this side of the link points at. */
  readonly path: string;
  /** What to tell an agent the folder is. */
  readonly description: string;
  /** Registered project rooted at `path`, or null for a context-only folder. */
  readonly targetProjectId: ProjectId | null;
  /** True when this side only sees the link because the other side made it. */
  readonly mirrored: boolean;
}

/**
 * The registered project rooted exactly at `path`, if there is one. Deleted
 * projects are the caller's to filter out; pass only the projects that count.
 */
export function resolveProjectLinkTarget(
  path: string,
  projects: ReadonlyArray<ProjectLinkProject>,
): ProjectId | null {
  const normalized = normalizeProjectPathForComparison(path);
  return (
    projects.find(
      (project) => normalizeProjectPathForComparison(project.workspaceRoot) === normalized,
    )?.id ?? null
  );
}

/**
 * A mirror describes the *other* project, which never wrote a description of
 * itself. Its title plus the description it wrote about us is the most honest
 * thing available, and reads well in a prompt.
 */
function mirrorDescription(owner: ProjectLinkProject, link: ProjectLink): string {
  return `Linked from ${owner.title}, which describes this project as: ${link.description}`;
}

/**
 * Every link `project` should see: the edges it owns first, in the order the
 * user added them, then the mirrors of edges other projects pointed at it.
 */
export function deriveProjectLinkViews(input: {
  readonly project: ProjectLinkProject;
  readonly projects: ReadonlyArray<ProjectLinkProject>;
}): ReadonlyArray<ProjectLinkView> {
  const { project, projects } = input;
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(project.workspaceRoot);

  const owned = (project.links ?? []).map(
    (link): ProjectLinkView => ({
      link,
      ownerProjectId: project.id,
      path: link.path,
      description: link.description,
      targetProjectId: resolveProjectLinkTarget(link.path, projects),
      mirrored: false,
    }),
  );

  const mirrored: ProjectLinkView[] = [];
  for (const owner of projects) {
    if (owner.id === project.id) continue;
    for (const link of owner.links ?? []) {
      if (normalizeProjectPathForComparison(link.path) !== normalizedWorkspaceRoot) continue;
      mirrored.push({
        link,
        ownerProjectId: owner.id,
        path: owner.workspaceRoot,
        description: mirrorDescription(owner, link),
        targetProjectId: owner.id,
        mirrored: true,
      });
    }
  }
  mirrored.sort((left, right) => left.path.localeCompare(right.path));

  return [...owned, ...mirrored];
}

/**
 * True when these two projects are already linked in either direction. The
 * decider uses this to keep a pair from accumulating two edges that would
 * disagree about which one is the source of truth.
 */
export function projectsAreLinked(left: ProjectLinkProject, right: ProjectLinkProject): boolean {
  const normalizedLeft = normalizeProjectPathForComparison(left.workspaceRoot);
  const normalizedRight = normalizeProjectPathForComparison(right.workspaceRoot);
  return (
    (left.links ?? []).some(
      (link) => normalizeProjectPathForComparison(link.path) === normalizedRight,
    ) ||
    (right.links ?? []).some(
      (link) => normalizeProjectPathForComparison(link.path) === normalizedLeft,
    )
  );
}
