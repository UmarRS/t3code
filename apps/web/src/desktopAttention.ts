import type { DesktopAttentionAlert, DesktopAttentionState } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "./types";
import { hasUnseenCompletion } from "./components/Sidebar.logic";

/**
 * Why a thread is waiting on the user, in the same priority order the sidebar
 * resolves its row status: act-now beats answer-now beats read-me.
 */
export type ThreadAttentionKind = "approval" | "input" | "completed";

/** Which thread was in which attention state at the last publish. */
export type ThreadAttentionSnapshot = ReadonlyMap<string, ThreadAttentionKind>;

export const EMPTY_ATTENTION_SNAPSHOT: ThreadAttentionSnapshot = new Map();

/**
 * Beyond this many simultaneous transitions the user gets one rollup banner
 * instead of a stack. Autonomous mode finishes issues in bursts, and a column
 * of notifications is read as noise and dismissed wholesale.
 */
export const MAX_INDIVIDUAL_ALERTS = 3;

const ATTENTION_TITLES: Record<ThreadAttentionKind, string> = {
  approval: "Approval needed",
  input: "Agent has a question",
  completed: "Turn complete",
};

type AttentionThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "environmentId"
  | "title"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestTurn"
  | "session"
>;

export function resolveThreadAttentionKind(
  thread: AttentionThread,
  lastVisitedAt: string | undefined,
): ThreadAttentionKind | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  // A thread still mid-turn is not waiting on anyone, however stale its last
  // completed turn looks.
  if (thread.session?.status === "running" || thread.session?.status === "starting") return null;
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) return "completed";
  return null;
}

export function buildAttentionSnapshot(input: {
  readonly threads: readonly AttentionThread[];
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string | undefined>>;
}): ThreadAttentionSnapshot {
  const snapshot = new Map<string, ThreadAttentionKind>();
  for (const thread of input.threads) {
    const threadKey = scopedThreadKey({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    const kind = resolveThreadAttentionKind(thread, input.lastVisitedAtByThreadKey[threadKey]);
    if (kind === null) continue;
    snapshot.set(threadKey, kind);
  }
  return snapshot;
}

function toAlert(thread: AttentionThread, kind: ThreadAttentionKind): DesktopAttentionAlert {
  return {
    title: ATTENTION_TITLES[kind],
    body: thread.title,
    target: { environmentId: thread.environmentId, threadId: thread.id },
  };
}

function toRollupAlert(alerts: readonly DesktopAttentionAlert[]): DesktopAttentionAlert {
  return {
    title: `${alerts.length} threads need you`,
    body: alerts
      .slice(0, MAX_INDIVIDUAL_ALERTS)
      .map((alert) => alert.body)
      .join(" · "),
    target: null,
  };
}

export interface AttentionPublication {
  readonly state: DesktopAttentionState;
  readonly snapshot: ThreadAttentionSnapshot;
}

/**
 * Projects the current threads into a dock badge plus the notifications owed
 * since `previous`.
 *
 * `previous` is null when there is no trustworthy baseline — first publish, or
 * the last one ran without any threads loaded. Both cases seed silently:
 * reconnecting to an environment refills every thread at once, and treating
 * that as a hundred new transitions would bury the user in banners for work
 * they already knew about.
 */
export function resolveAttentionPublication(input: {
  readonly previous: ThreadAttentionSnapshot | null;
  readonly threads: readonly AttentionThread[];
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string | undefined>>;
  /** The thread the user is already looking at, when the window has focus. */
  readonly suppressedThreadKey: string | null;
}): AttentionPublication {
  const snapshot = buildAttentionSnapshot(input);
  const alerts: DesktopAttentionAlert[] = [];

  if (input.previous !== null) {
    for (const thread of input.threads) {
      const threadKey = scopedThreadKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      const kind = snapshot.get(threadKey);
      if (kind === undefined) continue;
      if (input.previous.get(threadKey) === kind) continue;
      if (threadKey === input.suppressedThreadKey) continue;
      alerts.push(toAlert(thread, kind));
    }
  }

  return {
    snapshot,
    state: {
      badgeCount: snapshot.size,
      alerts: alerts.length > MAX_INDIVIDUAL_ALERTS ? [toRollupAlert(alerts)] : alerts,
    },
  };
}

/** Republishing an unchanged badge with nothing to announce is pure IPC noise. */
export function shouldPublishAttention(input: {
  readonly previousBadgeCount: number | null;
  readonly state: DesktopAttentionState;
}): boolean {
  return input.state.alerts.length > 0 || input.state.badgeCount !== input.previousBadgeCount;
}
