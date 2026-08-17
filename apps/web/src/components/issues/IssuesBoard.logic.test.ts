import {
  IssueId,
  ProjectId,
  ThreadId,
  type IssuePriority,
  type IssueStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueBoardColumns,
  buildIssueDecompositionPrompt,
  countDelegationTargetProjects,
  describeDelegationTargetProjects,
  describeDelegationTargets,
  describeIssueBlockers,
  indexDelegationTargetsByOriginThread,
  filterIssueDependencyCandidates,
  indexIssuesById,
  ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER,
  ISSUE_STATUS_COLUMNS,
  issuePriorityRank,
  resolveIssueBlockers,
  resolveIssueDelegationLinks,
  resolveIssueStartDisabledReason,
  type BoardIssue,
  type CrossProjectIssueView,
} from "./IssuesBoard.logic";

function issue(
  id: string,
  overrides: {
    title?: string;
    status?: IssueStatus;
    priority?: IssuePriority | null;
    dependsOn?: ReadonlyArray<string>;
    createdAt?: string;
  } = {},
): BoardIssue {
  return {
    id: IssueId.make(id),
    title: overrides.title ?? id,
    status: overrides.status ?? "backlog",
    priority: overrides.priority ?? null,
    dependsOn: (overrides.dependsOn ?? []).map((id) => IssueId.make(id)),
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("buildIssueBoardColumns", () => {
  it("returns every column in pipeline order, even when empty", () => {
    expect(buildIssueBoardColumns([]).map((column) => column.status)).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "canceled",
      "archived",
    ]);
  });

  it("mutes only the finished columns", () => {
    expect(
      ISSUE_STATUS_COLUMNS.filter((column) => column.muted).map((column) => column.status),
    ).toEqual(["done", "canceled", "archived"]);
  });

  it("groups issues into their status column", () => {
    const columns = buildIssueBoardColumns([
      issue("a", { status: "in_review" }),
      issue("b", { status: "backlog" }),
      issue("c", { status: "canceled" }),
      issue("d", { status: "archived" }),
    ]);
    expect(
      Object.fromEntries(
        columns.map((column) => [column.status, column.issues.map((entry) => entry.id)]),
      ),
    ).toEqual({
      backlog: ["b"],
      in_progress: [],
      in_review: ["a"],
      done: [],
      canceled: ["c"],
      archived: ["d"],
    });
  });

  it("orders a column by priority, then by age", () => {
    const columns = buildIssueBoardColumns([
      issue("old-low", { priority: "low", createdAt: "2026-01-01T00:00:00.000Z" }),
      issue("new-urgent", { priority: "urgent", createdAt: "2026-01-04T00:00:00.000Z" }),
      issue("unprioritized", { priority: null, createdAt: "2026-01-02T00:00:00.000Z" }),
      issue("old-high", { priority: "high", createdAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    expect(columns[0]?.issues.map((entry) => entry.id)).toEqual([
      "new-urgent",
      "old-high",
      "old-low",
      "unprioritized",
    ]);
  });

  it("ranks an absent priority last", () => {
    expect(issuePriorityRank("urgent")).toBeLessThan(issuePriorityRank("low"));
    expect(issuePriorityRank("low")).toBeLessThan(issuePriorityRank(null));
  });
});

describe("resolveIssueBlockers", () => {
  const dependency = issue("dep", { title: "Ship the schema" });

  it("blocks on a dependency that is not done", () => {
    const target = issue("target", { dependsOn: ["dep"] });
    const blockers = resolveIssueBlockers(target, indexIssuesById([dependency, target]));
    expect(blockers.map((entry) => entry.id)).toEqual(["dep"]);
  });

  it("clears once the dependency is done", () => {
    const done = issue("dep", { status: "done" });
    const target = issue("target", { dependsOn: ["dep"] });
    expect(resolveIssueBlockers(target, indexIssuesById([done, target]))).toEqual([]);
  });

  it("stays clear once the done dependency is archived", () => {
    const archived = issue("dep", { status: "archived" });
    const target = issue("target", { dependsOn: ["dep"] });
    expect(resolveIssueBlockers(target, indexIssuesById([archived, target]))).toEqual([]);
  });

  it("still blocks on a canceled dependency", () => {
    const canceled = issue("dep", { status: "canceled" });
    const target = issue("target", { dependsOn: ["dep"] });
    expect(resolveIssueBlockers(target, indexIssuesById([canceled, target]))).toHaveLength(1);
  });

  it("ignores a dependency that no longer exists", () => {
    const target = issue("target", { dependsOn: ["gone"] });
    expect(resolveIssueBlockers(target, indexIssuesById([target]))).toEqual([]);
  });

  it("names the blockers and summarizes a long list", () => {
    expect(describeIssueBlockers([issue("a", { title: "One" })])).toBe("One");
    expect(
      describeIssueBlockers([
        issue("a", { title: "One" }),
        issue("b", { title: "Two" }),
        issue("c", { title: "Three" }),
        issue("d", { title: "Four" }),
      ]),
    ).toBe("One, Two, Three and 1 more");
  });
});

describe("resolveIssueStartDisabledReason", () => {
  it("allows a startable issue", () => {
    expect(
      resolveIssueStartDisabledReason({
        issue: { status: "backlog", threadId: null },
        blockers: [],
      }),
    ).toBeNull();
  });

  it("explains which issues block the start", () => {
    expect(
      resolveIssueStartDisabledReason({
        issue: { status: "backlog", threadId: null },
        blockers: [issue("a", { title: "Ship the schema" })],
      }),
    ).toBe("Blocked by Ship the schema.");
  });

  it("refuses an issue that already has a thread", () => {
    expect(
      resolveIssueStartDisabledReason({
        issue: { status: "backlog", threadId: "thread-1" },
        blockers: [],
      }),
    ).toMatch(/already has a thread/);
  });
});

describe("filterIssueDependencyCandidates", () => {
  it("excludes the issue itself", () => {
    const issues = [issue("a"), issue("b")];
    expect(
      filterIssueDependencyCandidates({
        issues,
        issueId: IssueId.make("a"),
        selected: [],
      }).map((entry) => entry.id),
    ).toEqual(["b"]);
  });

  it("excludes candidates that would close a cycle", () => {
    // b already depends on a, so a depending on b would cycle.
    const issues = [issue("a"), issue("b", { dependsOn: ["a"] }), issue("c")];
    expect(
      filterIssueDependencyCandidates({
        issues,
        issueId: IssueId.make("a"),
        selected: [],
      }).map((entry) => entry.id),
    ).toEqual(["c"]);
  });

  it("excludes candidates that would close a longer cycle", () => {
    // c -> b -> a already exists, so a depending on c would close the loop.
    const issues = [
      issue("a"),
      issue("b", { dependsOn: ["a"] }),
      issue("c", { dependsOn: ["b"] }),
      issue("d"),
    ];
    expect(
      filterIssueDependencyCandidates({
        issues,
        issueId: IssueId.make("a"),
        selected: [],
      }).map((entry) => entry.id),
    ).toEqual(["d"]);
  });

  it("keeps already-selected dependencies offered so they can be removed", () => {
    const issues = [issue("a", { dependsOn: ["b"] }), issue("b")];
    expect(
      filterIssueDependencyCandidates({
        issues,
        issueId: IssueId.make("a"),
        selected: [IssueId.make("b")],
      }).map((entry) => entry.id),
    ).toEqual(["b"]);
  });

  it("offers everything to an issue that does not exist yet", () => {
    const issues = [issue("a"), issue("b", { dependsOn: ["a"] })];
    expect(
      filterIssueDependencyCandidates({
        issues,
        issueId: IssueId.make("fresh"),
        selected: [],
      }).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
  });
});

describe("buildIssueDecompositionPrompt", () => {
  it("leaves a slot for the feature and appends the block instructions", () => {
    const prompt = buildIssueDecompositionPrompt({
      projectTitle: "Atlas",
      availableModels: [{ instanceId: "codex", model: "gpt-5.6" }],
    });
    expect(prompt).toContain("Atlas");
    expect(prompt).toContain(ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER);
    expect(prompt.indexOf(ISSUE_DECOMPOSITION_PROMPT_PLACEHOLDER)).toBeLessThan(
      prompt.indexOf("t3-issues"),
    );
    expect(prompt).toContain("codex: gpt-5.6");
  });
});

describe("resolveIssueDelegationLinks", () => {
  const linked = (
    id: string,
    overrides: Partial<CrossProjectIssueView> = {},
  ): CrossProjectIssueView => ({
    id: IssueId.make(id),
    projectId: ProjectId.make("project-a"),
    threadId: null,
    ...overrides,
  });

  const projectTitleById = new Map([
    [ProjectId.make("project-a"), "Web"],
    [ProjectId.make("project-b"), "API"],
  ]);

  const resolve = (
    issue: CrossProjectIssueView,
    environmentIssues: ReadonlyArray<CrossProjectIssueView>,
    projectIdByThreadId: ReadonlyMap<ThreadId, ProjectId> = new Map(),
  ) =>
    resolveIssueDelegationLinks({
      issue,
      targetsByOriginThread: indexDelegationTargetsByOriginThread({
        environmentIssues,
        projectTitleById,
      }),
      projectIdByThreadId,
      projectTitleById,
    });

  it("names the project an incoming delegation came from", () => {
    const issue = linked("filed-here", {
      projectId: ProjectId.make("project-b"),
      delegatedFromThreadId: ThreadId.make("thread-1"),
    });
    const links = resolve(
      issue,
      [issue],
      new Map([[ThreadId.make("thread-1"), ProjectId.make("project-a")]]),
    );
    expect(links.origin).toEqual({
      threadId: "thread-1",
      projectId: "project-a",
      projectTitle: "Web",
    });
    expect(links.targets).toEqual([]);
  });

  it("keeps the incoming link when the origin thread is outside the snapshot", () => {
    const issue = linked("filed-here", { delegatedFromThreadId: ThreadId.make("thread-gone") });
    const links = resolve(issue, [issue]);
    expect(links.origin).toEqual({
      threadId: "thread-gone",
      projectId: null,
      projectTitle: null,
    });
  });

  it("finds the issues this one's worker filed on other boards", () => {
    const issue = linked("sender", { threadId: ThreadId.make("thread-1") });
    const target = linked("receiver", {
      projectId: ProjectId.make("project-b"),
      delegatedFromThreadId: ThreadId.make("thread-1"),
    });
    const links = resolve(issue, [
      issue,
      target,
      linked("unrelated", { projectId: ProjectId.make("project-b") }),
    ]);
    expect(links.targets).toEqual([
      { issueId: target.id, projectId: "project-b", projectTitle: "API" },
    ]);
    expect(links.origin).toBeNull();
  });

  it("groups several delegations from the same thread", () => {
    const issue = linked("sender", { threadId: ThreadId.make("thread-1") });
    const first = linked("one", {
      projectId: ProjectId.make("project-b"),
      delegatedFromThreadId: ThreadId.make("thread-1"),
    });
    const second = linked("two", {
      projectId: ProjectId.make("project-b"),
      delegatedFromThreadId: ThreadId.make("thread-1"),
    });
    expect(resolve(issue, [issue, first, second]).targets).toHaveLength(2);
  });

  it("ignores delegations that stayed on the same board", () => {
    const issue = linked("sender", { threadId: ThreadId.make("thread-1") });
    const sameBoard = linked("same", { delegatedFromThreadId: ThreadId.make("thread-1") });
    expect(resolve(issue, [issue, sameBoard]).targets).toEqual([]);
  });

  it("reports no links for an ordinary issue", () => {
    const issue = linked("plain", { threadId: ThreadId.make("thread-1") });
    expect(resolve(issue, [issue])).toEqual({ origin: null, targets: [] });
  });

  it("counts the boards the targets span", () => {
    expect(
      countDelegationTargetProjects([
        { issueId: IssueId.make("a"), projectId: ProjectId.make("project-b"), projectTitle: "API" },
        { issueId: IssueId.make("b"), projectId: ProjectId.make("project-b"), projectTitle: "API" },
        {
          issueId: IssueId.make("c"),
          projectId: ProjectId.make("project-c"),
          projectTitle: "Docs",
        },
      ]),
    ).toBe(2);
  });

  it("labels one board by name and several by count", () => {
    const target = (project: string, title: string | null) => ({
      issueId: IssueId.make(`issue-${project}`),
      projectId: ProjectId.make(project),
      projectTitle: title,
    });
    expect(describeDelegationTargets([target("project-b", "API")])).toBe("To API");
    expect(
      describeDelegationTargets([target("project-b", "API"), target("project-c", "Docs")]),
    ).toBe("To 2 projects");
    expect(describeDelegationTargets([target("project-b", null)])).toBe("To another project");
  });

  it("names each destination board once for the tooltip", () => {
    const target = (id: string, project: string, title: string | null) => ({
      issueId: IssueId.make(id),
      projectId: ProjectId.make(project),
      projectTitle: title,
    });
    expect(
      describeDelegationTargetProjects([
        target("a", "project-b", "API"),
        target("b", "project-b", "API"),
        target("c", "project-c", "Docs"),
      ]),
    ).toBe("API, Docs");
  });

  it("keeps the tooltip and the count in step when two boards share a title", () => {
    const target = (id: string, project: string, title: string | null) => ({
      issueId: IssueId.make(id),
      projectId: ProjectId.make(project),
      projectTitle: title,
    });
    const sameTitle = [target("a", "project-b", "API"), target("b", "project-c", "API")];
    expect(countDelegationTargetProjects(sameTitle)).toBe(2);
    expect(describeDelegationTargetProjects(sameTitle)).toBe("API, API");
    expect(describeDelegationTargets(sameTitle)).toBe("To 2 projects");
  });
});
