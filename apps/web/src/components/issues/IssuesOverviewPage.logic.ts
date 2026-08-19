import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationIssue } from "@t3tools/contracts";

export interface ScopedIssue extends OrchestrationIssue {
  readonly environmentId: EnvironmentProject["environmentId"];
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
