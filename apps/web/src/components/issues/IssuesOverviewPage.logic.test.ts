import { EnvironmentId, IssueId, ProjectId, type OrchestrationIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { issuesForProject, type ScopedIssue } from "./IssuesOverviewPage.logic";

const projectId = ProjectId.make("project-1");
const issue = (environmentId: string, id: string): ScopedIssue =>
  ({
    environmentId: EnvironmentId.make(environmentId),
    id: IssueId.make(id),
    projectId,
  }) as ScopedIssue;

describe("issuesForProject", () => {
  it("keeps projects with the same id on different environments separate", () => {
    const issues = [issue("local", "local-issue"), issue("remote", "remote-issue")];

    expect(
      issuesForProject(issues, {
        environmentId: EnvironmentId.make("remote"),
        id: projectId,
      }).map((candidate: OrchestrationIssue) => candidate.id),
    ).toEqual([IssueId.make("remote-issue")]);
  });
});
