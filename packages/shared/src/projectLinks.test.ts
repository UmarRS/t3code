import { describe, expect, it } from "@effect/vitest";
import type { ProjectId, ProjectLink } from "@t3tools/contracts";

import {
  deriveProjectLinkViews,
  findProjectLinkTarget,
  projectsAreLinked,
  resolveProjectLinkTarget,
  type ProjectLinkProject,
} from "./projectLinks.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const projectId = (value: string) => value as ProjectId;

const link = (id: string, path: string, description: string): ProjectLink =>
  ({ id, path, description, createdAt: NOW }) as ProjectLink;

const frontend: ProjectLinkProject = {
  id: projectId("frontend"),
  title: "smartcanvass-fe",
  workspaceRoot: "/repos/smartcanvass-fe",
  links: [link("link-1", "/repos/smartcanvass-be", "backend for all smartcanvass APIs")],
};

const backend: ProjectLinkProject = {
  id: projectId("backend"),
  title: "smartcanvass-be",
  workspaceRoot: "/repos/smartcanvass-be",
};

describe("resolveProjectLinkTarget", () => {
  it("matches a registered project root", () => {
    expect(resolveProjectLinkTarget("/repos/smartcanvass-be/", [frontend, backend])).toBe(
      backend.id,
    );
  });

  it("returns null for a folder no project is rooted at", () => {
    expect(resolveProjectLinkTarget("/repos/design-tokens", [frontend, backend])).toBeNull();
  });

  it("can match macOS path casing without weakening POSIX matching by default", () => {
    const project = { ...backend, workspaceRoot: "/Users/test/Dev/backend" };

    expect(findProjectLinkTarget("/Users/test/dev/backend", [project])).toBeNull();
    expect(
      findProjectLinkTarget("/Users/test/dev/backend", [project], { caseInsensitive: true }),
    ).toBe(project);
  });
});

describe("deriveProjectLinkViews", () => {
  it("resolves an owned link to its target project", () => {
    const views = deriveProjectLinkViews({ project: frontend, projects: [frontend, backend] });

    expect(views).toHaveLength(1);
    expect(views[0]?.mirrored).toBe(false);
    expect(views[0]?.ownerProjectId).toBe(frontend.id);
    expect(views[0]?.path).toBe("/repos/smartcanvass-be");
    expect(views[0]?.description).toBe("backend for all smartcanvass APIs");
    expect(views[0]?.targetProjectId).toBe(backend.id);
  });

  it("mirrors the link onto the linked project", () => {
    const views = deriveProjectLinkViews({ project: backend, projects: [frontend, backend] });

    expect(views).toHaveLength(1);
    expect(views[0]?.mirrored).toBe(true);
    expect(views[0]?.ownerProjectId).toBe(frontend.id);
    expect(views[0]?.path).toBe("/repos/smartcanvass-fe");
    expect(views[0]?.targetProjectId).toBe(frontend.id);
    expect(views[0]?.description).toContain("smartcanvass-fe");
    expect(views[0]?.description).toContain("backend for all smartcanvass APIs");
  });

  it("keeps a context-only link with no target project", () => {
    const contextOnly: ProjectLinkProject = {
      ...frontend,
      links: [link("link-2", "/repos/design-tokens", "shared design tokens")],
    };
    const views = deriveProjectLinkViews({ project: contextOnly, projects: [contextOnly] });

    expect(views[0]?.targetProjectId).toBeNull();
    expect(views[0]?.mirrored).toBe(false);
  });

  it("lists owned links before mirrors", () => {
    const owner: ProjectLinkProject = {
      ...backend,
      links: [link("link-3", "/repos/docs", "the docs site")],
    };
    const views = deriveProjectLinkViews({ project: owner, projects: [frontend, owner] });

    expect(views.map((view) => view.mirrored)).toEqual([false, true]);
  });

  it("drops the mirror once the stored edge is gone", () => {
    const unlinked: ProjectLinkProject = { ...frontend, links: [] };
    expect(deriveProjectLinkViews({ project: backend, projects: [unlinked, backend] })).toEqual([]);
  });
});

describe("projectsAreLinked", () => {
  it("sees a link from either direction", () => {
    expect(projectsAreLinked(frontend, backend)).toBe(true);
    expect(projectsAreLinked(backend, frontend)).toBe(true);
  });

  it("is false for unrelated projects", () => {
    expect(projectsAreLinked({ ...frontend, links: [] }, backend)).toBe(false);
  });
});
