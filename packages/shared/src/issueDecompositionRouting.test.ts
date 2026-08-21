import { describe, expect, it } from "@effect/vitest";
import type { IssueDecompositionEntry, ProjectId } from "@t3tools/contracts";

import {
  decompositionEntryProjectKey,
  groupDecompositionEntriesByProject,
  type DecompositionRoutingProject,
} from "./issueDecompositionRouting.ts";

const projectId = (value: string) => value as ProjectId;

const entry = (
  key: string,
  overrides: Partial<IssueDecompositionEntry> = {},
): IssueDecompositionEntry =>
  ({ key, title: key, description: "", ...overrides }) as IssueDecompositionEntry;

const backend: DecompositionRoutingProject = {
  id: projectId("backend"),
  title: "smartcanvass-be",
  workspaceRoot: "/repos/smartcanvass-be",
};

const frontend: DecompositionRoutingProject = {
  id: projectId("frontend"),
  title: "smartcanvass-fe",
  workspaceRoot: "/repos/smartcanvass-fe",
};

describe("decompositionEntryProjectKey", () => {
  it("treats an omitted project as the requesting one", () => {
    expect(decompositionEntryProjectKey(entry("a"), backend.workspaceRoot)).toBeNull();
  });

  it("treats the requesting project's own root as omitted", () => {
    expect(
      decompositionEntryProjectKey(
        entry("a", { project: "/repos/smartcanvass-be/" }),
        backend.workspaceRoot,
      ),
    ).toBeNull();
  });

  it("normalizes another project's root", () => {
    expect(
      decompositionEntryProjectKey(
        entry("a", { project: "/repos/smartcanvass-fe/" }),
        backend.workspaceRoot,
      ),
    ).toBe("/repos/smartcanvass-fe");
  });
});

describe("groupDecompositionEntriesByProject", () => {
  it("keeps a single-project block on the requesting board", () => {
    const groups = groupDecompositionEntriesByProject({
      entries: [entry("schema"), entry("api")],
      currentProject: backend,
      linkedProjects: [frontend],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projectId).toBe(backend.id);
    expect(groups[0]?.entries.map((item) => item.key)).toEqual(["schema", "api"]);
  });

  it("routes a story to the linked project it names", () => {
    const groups = groupDecompositionEntriesByProject({
      entries: [entry("api"), entry("ui", { project: "/repos/smartcanvass-fe" })],
      currentProject: backend,
      linkedProjects: [frontend],
    });
    expect(groups.map((group) => group.projectId)).toEqual([backend.id, frontend.id]);
    expect(groups[1]?.entries.map((item) => item.key)).toEqual(["ui"]);
    expect(groups[1]?.title).toBe("smartcanvass-fe");
  });

  it("puts the requesting project first even when every story routes away", () => {
    const groups = groupDecompositionEntriesByProject({
      entries: [entry("ui", { project: "/repos/smartcanvass-fe" })],
      currentProject: backend,
      linkedProjects: [frontend],
    });
    expect(groups[0]?.projectId).toBe(backend.id);
    expect(groups[0]?.entries).toEqual([]);
  });

  it("falls back to the requesting board for an unroutable path, and reports it", () => {
    const groups = groupDecompositionEntriesByProject({
      entries: [entry("tokens", { project: "/repos/design-tokens" })],
      currentProject: backend,
      linkedProjects: [frontend],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries.map((item) => item.key)).toEqual(["tokens"]);
    expect(groups[0]?.unroutablePaths).toEqual(["/repos/design-tokens"]);
  });

  it("does not split the requesting board when a story names its own root", () => {
    const groups = groupDecompositionEntriesByProject({
      entries: [entry("api"), entry("worker", { project: "/repos/smartcanvass-be" })],
      currentProject: backend,
      linkedProjects: [frontend, backend],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries.map((item) => item.key)).toEqual(["api", "worker"]);
  });
});
