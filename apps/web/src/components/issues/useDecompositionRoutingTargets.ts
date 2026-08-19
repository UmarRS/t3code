import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { DecompositionRoutingProject } from "@t3tools/shared/issueDecompositionRouting";
import { deriveProjectLinkViews } from "@t3tools/shared/projectLinks";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";

/**
 * A linked project stories can be routed to, carrying the description the link
 * was created with — the prompt needs it to tell the agent what the repository
 * is for, and the import card only needs the identity half.
 */
export interface DecompositionRoutingTarget extends DecompositionRoutingProject {
  readonly description: string;
}

const EMPTY: ReadonlyArray<DecompositionRoutingTarget> = Object.freeze([]);

/**
 * The linked projects a decomposition may file stories on: the registered ones,
 * which are the only links with a board to receive them. Context-only links are
 * left out — there is no project there to create an issue in.
 *
 * Scoped to one environment, because a link path names a folder on the machine
 * that owns the project and the same path elsewhere is a different folder.
 * Paths come from the target project itself rather than the link, so the agent
 * is handed one canonical spelling of each root to copy into a story.
 */
export function useDecompositionRoutingTargets(ref: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): ReadonlyArray<DecompositionRoutingTarget> {
  const projects = useProjects();
  const { environmentId, projectId } = ref;
  return useMemo(() => {
    const scoped = projects.filter((candidate) => candidate.environmentId === environmentId);
    const project = scoped.find((candidate) => candidate.id === projectId);
    if (project === undefined) return EMPTY;
    const byId = new Map(scoped.map((candidate) => [candidate.id, candidate]));

    const targets: DecompositionRoutingTarget[] = [];
    const seen = new Set<ProjectId>();
    for (const view of deriveProjectLinkViews({ project, projects: scoped })) {
      // A project linked in both directions yields an owned edge and a mirror.
      if (view.targetProjectId === null || view.targetProjectId === projectId) continue;
      if (seen.has(view.targetProjectId)) continue;
      const target = byId.get(view.targetProjectId);
      if (target === undefined) continue;
      seen.add(target.id);
      targets.push({
        id: target.id,
        title: target.title,
        workspaceRoot: target.workspaceRoot,
        description: view.description,
      });
    }
    return targets.length === 0 ? EMPTY : targets;
  }, [environmentId, projectId, projects]);
}
