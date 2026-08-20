import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationIssue } from "@t3tools/contracts";

export interface ScopedIssue extends OrchestrationIssue {
  readonly environmentId: EnvironmentProject["environmentId"];
}

export const PROJECT_ACCENTS = ["blue", "teal", "purple", "orange", "pink", "green"] as const;

export type ProjectAccent = (typeof PROJECT_ACCENTS)[number];

/** Stable visual identity for a physical project across reloads and devices. */
export function projectAccent(projectKey: string): ProjectAccent {
  let hash = 0;
  for (let index = 0; index < projectKey.length; index += 1) {
    hash = (hash * 31 + projectKey.charCodeAt(index)) | 0;
  }
  return PROJECT_ACCENTS[Math.abs(hash) % PROJECT_ACCENTS.length] ?? "blue";
}

/** Favorites lead; both partitions retain the environment's existing order. */
export function sortOverviewProjects<T>(
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

export function projectMatchesOverviewQuery(
  project: Pick<EnvironmentProject, "title" | "workspaceRoot">,
  environmentLabel: string | undefined,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [project.title, project.workspaceRoot, environmentLabel]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

/** Project ids are only unique within an environment. */
export function issuesForProject(
  issues: ReadonlyArray<ScopedIssue>,
  project: Pick<EnvironmentProject, "environmentId" | "id">,
): ReadonlyArray<OrchestrationIssue> {
  return issues.filter(
    (issue) => issue.environmentId === project.environmentId && issue.projectId === project.id,
  );
}
