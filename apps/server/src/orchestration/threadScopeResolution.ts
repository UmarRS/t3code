// Pure path arithmetic on already-resolved absolute paths; no filesystem access.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  normalizeThreadScopeLinkedPaths,
  normalizeThreadScopePath,
  type ProjectId,
} from "@t3tools/contracts";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

type ScopeInput = {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly focusPath?: string | null | undefined;
    readonly linkedPaths?: ReadonlyArray<string> | undefined;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
};

/**
 * Where the provider process actually runs. This is the thread's workspace
 * root (its worktree, or the project root) narrowed by the thread's focus
 * path, so a thread focused on `apps/web` starts there: its searches, its
 * relative paths, and the agent memory files it discovers all narrow with it.
 *
 * Deliberately distinct from {@link resolveThreadWorkspaceCwd}, which stays
 * the workspace root — git, worktrees, checkpoints, and diffs operate on the
 * whole repository whether or not the thread is scoped.
 */
export function resolveThreadAgentCwd(input: ScopeInput): string | undefined {
  const workspaceCwd = resolveThreadWorkspaceCwd(input);
  if (workspaceCwd === undefined) {
    return undefined;
  }
  const focusPath = normalizeThreadScopePath(input.thread.focusPath);
  return focusPath === null ? workspaceCwd : NodePath.join(workspaceCwd, focusPath);
}

/**
 * Absolute directories outside the agent's cwd that the thread may still read
 * and edit: its linked paths, resolved against the same workspace root. A
 * frontend-focused thread linking `apps/server` gets exactly that directory,
 * not the run of the whole repository.
 */
export function resolveThreadContextDirectories(input: ScopeInput): ReadonlyArray<string> {
  const workspaceCwd = resolveThreadWorkspaceCwd(input);
  if (workspaceCwd === undefined) {
    return [];
  }
  return normalizeThreadScopeLinkedPaths(input.thread.linkedPaths, {
    focusPath: input.thread.focusPath,
  }).map((linkedPath) => NodePath.join(workspaceCwd, linkedPath));
}
