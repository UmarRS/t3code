import { EnvironmentId, IssueId, ProjectId, type IssueStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allWorkColumnsAreEmpty,
  allWorkIssueMatchesQuery,
  allWorkIssueReference,
  buildAllWorkColumns,
  type AllWorkIssue,
} from "./AllWorkBoard.logic";

const issue = (id: string, status: IssueStatus, overrides?: Partial<AllWorkIssue>): AllWorkIssue =>
  ({
    id: IssueId.make(id),
    projectId: ProjectId.make("project-1"),
    environmentId: EnvironmentId.make("local"),
    title: id,
    status,
    priority: null,
    dependsOn: [],
    threadId: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  }) as AllWorkIssue;

describe("buildAllWorkColumns", () => {
  it("keeps the project board's pipeline and drops archived work", () => {
    const columns = buildAllWorkColumns([
      issue("a", "in_progress"),
      issue("b", "archived"),
      issue("c", "backlog"),
    ]);

    expect(columns.map((column) => column.status)).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
    expect(columns.flatMap((column) => column.issues.map((entry) => entry.id))).toEqual(["c", "a"]);
  });

  it("merges the same status across projects and environments into one column", () => {
    const columns = buildAllWorkColumns([
      issue("a", "in_progress", { environmentId: EnvironmentId.make("remote") }),
      issue("b", "in_progress", { projectId: ProjectId.make("project-2") }),
    ]);

    expect(
      columns.find((column) => column.status === "in_progress")?.issues.map((entry) => entry.id),
    ).toEqual(["a", "b"]);
  });

  it("counts flagged issues per column", () => {
    const columns = buildAllWorkColumns([
      issue("a", "in_review", { needsAttentionAt: "2026-08-20T01:00:00.000Z" }),
      issue("b", "in_review"),
    ]);

    expect(columns.find((column) => column.status === "in_review")?.attentionCount).toBe(1);
  });
});

describe("allWorkIssueMatchesQuery", () => {
  const entry = { title: "Fix the composer", projectTitle: "Atlas" };

  it("matches the issue title and its project, case-insensitively", () => {
    expect(allWorkIssueMatchesQuery(entry, "")).toBe(true);
    expect(allWorkIssueMatchesQuery(entry, "COMPOSER")).toBe(true);
    expect(allWorkIssueMatchesQuery(entry, "atlas")).toBe(true);
    expect(allWorkIssueMatchesQuery(entry, "docs")).toBe(false);
  });

  it("still matches on title when the project is unknown", () => {
    expect(allWorkIssueMatchesQuery({ title: "Fix it", projectTitle: null }, "fix")).toBe(true);
  });
});

describe("allWorkColumnsAreEmpty", () => {
  it("is true only when nothing survived the filter", () => {
    expect(allWorkColumnsAreEmpty(buildAllWorkColumns([]))).toBe(true);
    expect(allWorkColumnsAreEmpty(buildAllWorkColumns([issue("a", "done")]))).toBe(false);
  });
});

describe("allWorkIssueReference", () => {
  it("names the branch, with the pull request number once there is one", () => {
    expect(allWorkIssueReference({ branch: "issue/abc", pullRequestUrl: null })).toBe("issue/abc");
    expect(
      allWorkIssueReference({
        branch: "issue/abc",
        pullRequestUrl: "https://github.com/UmarRS/t3code/pull/23",
      }),
    ).toBe("issue/abc #23");
  });

  it("has nothing to say about work that has not started", () => {
    expect(allWorkIssueReference({ branch: null, pullRequestUrl: null })).toBe(null);
    expect(allWorkIssueReference({ branch: undefined, pullRequestUrl: "https://x/pull/1" })).toBe(
      null,
    );
  });
});
