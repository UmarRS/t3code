import { EnvironmentId, IssueId, ProjectId, type OrchestrationIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  issuesForProject,
  projectAccent,
  projectMatchesOverviewQuery,
  sortOverviewProjects,
  type ScopedIssue,
} from "./IssuesOverviewPage.logic";

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

describe("projectAccent", () => {
  it("is stable and distributes different project keys across the palette", () => {
    expect(projectAccent("local:atlas")).toBe(projectAccent("local:atlas"));
    expect(new Set(["atlas", "client", "server", "docs"].map(projectAccent)).size).toBeGreaterThan(
      1,
    );
  });
});

describe("sortOverviewProjects", () => {
  it("moves favorites first without disturbing either partition", () => {
    expect(sortOverviewProjects(["a", "b", "c", "d"], (key) => key === "c" || key === "b")).toEqual(
      ["b", "c", "a", "d"],
    );
  });
});

describe("projectMatchesOverviewQuery", () => {
  const project = { title: "Atlas", workspaceRoot: "/Users/umar/tools/t3code" };

  it("matches project names, paths and environment labels case-insensitively", () => {
    expect(projectMatchesOverviewQuery(project, "Local Mac", "ATLAS")).toBe(true);
    expect(projectMatchesOverviewQuery(project, "Local Mac", "tools/t3")).toBe(true);
    expect(projectMatchesOverviewQuery(project, "Local Mac", "local mac")).toBe(true);
    expect(projectMatchesOverviewQuery(project, "Local Mac", "remote")).toBe(false);
  });
});
