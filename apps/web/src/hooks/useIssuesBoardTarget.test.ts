import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIssuesBoardProjectRef } from "./useIssuesBoardTarget";

const ENV = EnvironmentId.make("environment-1");
const ACTIVE_REF = scopeProjectRef(ENV, ProjectId.make("project-active"));
const LAST_VISITED_REF = scopeProjectRef(ENV, ProjectId.make("project-last-visited"));
const DELETED_REF = scopeProjectRef(ENV, ProjectId.make("project-deleted"));
const DEFAULT_REF = scopeProjectRef(ENV, ProjectId.make("project-default"));

const PROJECTS = [
  { environmentId: ENV, id: ProjectId.make("project-active") },
  { environmentId: ENV, id: ProjectId.make("project-last-visited") },
  { environmentId: ENV, id: ProjectId.make("project-default") },
];

describe("resolveIssuesBoardProjectRef", () => {
  it("prefers the active thread's project over everything else", () => {
    expect(
      resolveIssuesBoardProjectRef({
        activeProjectRef: ACTIVE_REF,
        lastBoardRef: LAST_VISITED_REF,
        projects: PROJECTS,
        defaultProjectRef: DEFAULT_REF,
      }),
    ).toEqual(ACTIVE_REF);
  });

  it("falls back to the last visited board when there is no active thread", () => {
    expect(
      resolveIssuesBoardProjectRef({
        activeProjectRef: null,
        lastBoardRef: LAST_VISITED_REF,
        projects: PROJECTS,
        defaultProjectRef: DEFAULT_REF,
      }),
    ).toEqual(LAST_VISITED_REF);
  });

  it("skips a last-visited board whose project no longer exists", () => {
    expect(
      resolveIssuesBoardProjectRef({
        activeProjectRef: null,
        lastBoardRef: DELETED_REF,
        projects: PROJECTS,
        defaultProjectRef: DEFAULT_REF,
      }),
    ).toEqual(DEFAULT_REF);
  });

  it("falls back to the default project ref when nothing else is available", () => {
    expect(
      resolveIssuesBoardProjectRef({
        activeProjectRef: null,
        lastBoardRef: null,
        projects: PROJECTS,
        defaultProjectRef: DEFAULT_REF,
      }),
    ).toEqual(DEFAULT_REF);
  });

  it("returns null when nothing resolves", () => {
    expect(
      resolveIssuesBoardProjectRef({
        activeProjectRef: null,
        lastBoardRef: null,
        projects: [],
        defaultProjectRef: null,
      }),
    ).toBeNull();
  });
});
