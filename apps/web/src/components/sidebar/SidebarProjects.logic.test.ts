import type { IssueStatus, OrchestrationIssue } from "@t3tools/contracts";
import { IssueId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SIDEBAR_PROJECT_ISSUE_LIMIT,
  resolveProjectExpanded,
  selectSidebarProjectIssues,
  sortProjectsWithFavoritesFirst,
} from "./SidebarProjects.logic";

function issue(
  id: string,
  overrides: {
    readonly status?: IssueStatus;
    readonly updatedAt?: string;
    readonly needsAttentionAt?: string | null;
    readonly deletedAt?: string | null;
  } = {},
): OrchestrationIssue {
  return {
    id: IssueId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Issue ${id}`,
    status: overrides.status ?? "in_progress",
    priority: null,
    modelSelection: null,
    dependsOn: [],
    threadId: null,
    pullRequestUrl: null,
    needsAttentionAt: overrides.needsAttentionAt ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
  };
}

const ids = (list: { readonly issue: OrchestrationIssue }[]) =>
  list.map((entry) => entry.issue.id as string);

describe("sortProjectsWithFavoritesFirst", () => {
  it("lifts favorites to the top while preserving the caller's order", () => {
    const projects = ["a", "b", "c", "d"];
    expect(sortProjectsWithFavoritesFirst(projects, (p) => p === "c" || p === "b")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("is a no-op when nothing is favorited", () => {
    expect(sortProjectsWithFavoritesFirst(["a", "b"], () => false)).toEqual(["a", "b"]);
  });
});

describe("resolveProjectExpanded", () => {
  it("defaults favorites to expanded and everything else to collapsed", () => {
    expect(resolveProjectExpanded({ explicit: undefined, isFavorite: true })).toBe(true);
    expect(resolveProjectExpanded({ explicit: undefined, isFavorite: false })).toBe(false);
  });

  it("lets an explicit choice win in both directions", () => {
    expect(resolveProjectExpanded({ explicit: false, isFavorite: true })).toBe(false);
    expect(resolveProjectExpanded({ explicit: true, isFavorite: false })).toBe(true);
  });
});

describe("selectSidebarProjectIssues", () => {
  it("keeps running and done issues, dropping backlog, canceled and archived", () => {
    const result = selectSidebarProjectIssues([
      issue("backlog", { status: "backlog" }),
      issue("running", { status: "in_progress" }),
      issue("review", { status: "in_review" }),
      issue("done", { status: "done" }),
      issue("canceled", { status: "canceled" }),
      issue("archived", { status: "archived" }),
    ]);

    expect(ids([...result.entries]).sort()).toEqual(["done", "review", "running"]);
    expect(
      result.entries.filter((entry) => entry.kind === "settled").map((e) => e.issue.id),
    ).toEqual(["done"]);
  });

  it("drops deleted issues", () => {
    const result = selectSidebarProjectIssues([
      issue("gone", { deletedAt: "2026-01-02T00:00:00.000Z" }),
      issue("here"),
    ]);
    expect(ids([...result.entries])).toEqual(["here"]);
  });

  it("orders flagged work first, then running, then finished, each newest first", () => {
    const result = selectSidebarProjectIssues([
      issue("done-old", { status: "done", updatedAt: "2026-01-01T00:00:00.000Z" }),
      issue("done-new", { status: "done", updatedAt: "2026-01-05T00:00:00.000Z" }),
      issue("running-old", { status: "in_progress", updatedAt: "2026-01-02T00:00:00.000Z" }),
      issue("running-new", { status: "in_review", updatedAt: "2026-01-04T00:00:00.000Z" }),
      issue("flagged", {
        status: "in_progress",
        updatedAt: "2026-01-01T00:00:00.000Z",
        needsAttentionAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(ids([...result.entries])).toEqual([
      "flagged",
      "running-new",
      "running-old",
      "done-new",
      "done-old",
    ]);
    expect(result.entries[0]?.needsAttention).toBe(true);
  });

  it("caps the list and reports the remainder", () => {
    const many = Array.from({ length: SIDEBAR_PROJECT_ISSUE_LIMIT + 3 }, (_, index) =>
      issue(`issue-${index}`, { updatedAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z` }),
    );
    const result = selectSidebarProjectIssues(many);

    expect(result.entries).toHaveLength(SIDEBAR_PROJECT_ISSUE_LIMIT);
    expect(result.hiddenCount).toBe(3);
  });

  it("reports no remainder when everything fits", () => {
    const result = selectSidebarProjectIssues([issue("a"), issue("b")], { limit: 5 });
    expect(result.entries).toHaveLength(2);
    expect(result.hiddenCount).toBe(0);
  });
});
