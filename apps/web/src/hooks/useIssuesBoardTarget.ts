import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { useLastBoardStore } from "../lastBoardStore";
import { useProjects } from "../state/entities";
import { useHandleNewThread } from "./useHandleNewThread";

/**
 * Pure resolution logic behind `useIssuesBoardProjectRef`, pulled out so the
 * fallback order is unit-testable without mounting the hook's React state.
 */
export function resolveIssuesBoardProjectRef(input: {
  activeProjectRef: ScopedProjectRef | null;
  lastBoardRef: ScopedProjectRef | null;
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id">>;
  defaultProjectRef: ScopedProjectRef | null;
}): ScopedProjectRef | null {
  if (input.activeProjectRef) {
    return input.activeProjectRef;
  }
  const lastBoardRef = input.lastBoardRef;
  if (
    lastBoardRef &&
    input.projects.some(
      (project) =>
        project.environmentId === lastBoardRef.environmentId &&
        project.id === lastBoardRef.projectId,
    )
  ) {
    return lastBoardRef;
  }
  return input.defaultProjectRef;
}

/**
 * Which project the "Issues" entry points open. Resolution order:
 * 1. The active (or draft) thread's project — the project the user is
 *    already working in is the one they mean.
 * 2. The last board the user visited, as long as that project still
 *    exists — a stale ref to a deleted project must not win.
 * 3. The first ordered project (`defaultProjectRef`), so the entry stays
 *    usable from the landing screen before any board has been visited.
 */
export function useIssuesBoardProjectRef(): ScopedProjectRef | null {
  const { activeDraftThread, activeThread, defaultProjectRef } = useHandleNewThread();
  const thread = activeThread ?? activeDraftThread;
  const activeProjectRef = thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  const lastBoardRef = useLastBoardStore((store) => store.lastBoardRef);
  const projects = useProjects();
  return resolveIssuesBoardProjectRef({
    activeProjectRef,
    lastBoardRef,
    projects,
    defaultProjectRef,
  });
}
