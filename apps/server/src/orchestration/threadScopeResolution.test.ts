import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { resolveThreadAgentCwd, resolveThreadContextDirectories } from "./threadScopeResolution.ts";

const projectId = ProjectId.make("project-1");
const projects = [{ id: projectId, workspaceRoot: "/repos/acme" }];

const makeThread = (overrides?: {
  readonly worktreePath?: string | null;
  readonly focusPath?: string | null;
  readonly linkedPaths?: ReadonlyArray<string>;
}) => ({
  id: ThreadId.make("thread-1"),
  projectId,
  worktreePath: overrides?.worktreePath ?? null,
  focusPath: overrides?.focusPath ?? null,
  linkedPaths: overrides?.linkedPaths ?? [],
});

describe("resolveThreadAgentCwd", () => {
  it("runs at the workspace root when the thread is unscoped", () => {
    expect(resolveThreadAgentCwd({ thread: makeThread(), projects })).toBe("/repos/acme");
  });

  it("runs inside the focus folder", () => {
    expect(resolveThreadAgentCwd({ thread: makeThread({ focusPath: "apps/web" }), projects })).toBe(
      "/repos/acme/apps/web",
    );
  });

  it("stays inside the worktree for a worktree thread", () => {
    expect(
      resolveThreadAgentCwd({
        thread: makeThread({ worktreePath: "/repos/acme-wt/feature", focusPath: "apps/web" }),
        projects,
      }),
    ).toBe("/repos/acme-wt/feature/apps/web");
  });

  it("ignores a focus path that would escape the workspace", () => {
    expect(
      resolveThreadAgentCwd({ thread: makeThread({ focusPath: "../../etc" }), projects }),
    ).toBe("/repos/acme");
  });

  it("returns nothing when the project is unknown", () => {
    expect(resolveThreadAgentCwd({ thread: makeThread(), projects: [] })).toBeUndefined();
  });
});

describe("resolveThreadContextDirectories", () => {
  it("is empty without links", () => {
    expect(resolveThreadContextDirectories({ thread: makeThread(), projects })).toEqual([]);
  });

  it("resolves links against the workspace root, not the focus folder", () => {
    expect(
      resolveThreadContextDirectories({
        thread: makeThread({ focusPath: "apps/web", linkedPaths: ["apps/server"] }),
        projects,
      }),
    ).toEqual(["/repos/acme/apps/server"]);
  });

  it("resolves links inside the worktree for a worktree thread", () => {
    expect(
      resolveThreadContextDirectories({
        thread: makeThread({
          worktreePath: "/repos/acme-wt/feature",
          focusPath: "apps/web",
          linkedPaths: ["apps/server"],
        }),
        projects,
      }),
    ).toEqual(["/repos/acme-wt/feature/apps/server"]);
  });

  it("drops a link that duplicates the focus folder", () => {
    expect(
      resolveThreadContextDirectories({
        thread: makeThread({ focusPath: "apps/web", linkedPaths: ["apps/web"] }),
        projects,
      }),
    ).toEqual([]);
  });
});

describe("git scope", () => {
  // Scope must not follow git around: checkpoints and diffs stay whole-repo,
  // which is what makes restore and review still work on a scoped thread.
  it("leaves the workspace cwd at the repository root", () => {
    const thread = makeThread({ focusPath: "apps/web" });
    expect(resolveThreadWorkspaceCwd({ thread, projects })).toBe("/repos/acme");
    expect(resolveThreadAgentCwd({ thread, projects })).toBe("/repos/acme/apps/web");
  });
});
