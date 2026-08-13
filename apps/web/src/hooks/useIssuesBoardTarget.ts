import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { useHandleNewThread } from "./useHandleNewThread";

/**
 * Which project the "Issues" entry points open. The board is per project, and
 * the project the user is already working in is the one they mean; falling back
 * to the first ordered project keeps the entry usable from the landing screen.
 */
export function useIssuesBoardProjectRef(): ScopedProjectRef | null {
  const { activeDraftThread, activeThread, defaultProjectRef } = useHandleNewThread();
  const thread = activeThread ?? activeDraftThread;
  if (thread) {
    return scopeProjectRef(thread.environmentId, thread.projectId);
  }
  return defaultProjectRef;
}
