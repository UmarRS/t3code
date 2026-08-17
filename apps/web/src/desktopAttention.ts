import type {
  DesktopAttentionAlert,
  DesktopAttentionState,
  EnvironmentId,
  IssueId,
  ProjectId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "./types";
import { hasUnseenCompletion } from "./components/Sidebar.logic";
import {
  resolveAutonomousRunState,
  type AutonomousProjectView,
} from "./components/issues/autonomousRun.logic";

/**
 * Why a thread is waiting on the user, in the same priority order the sidebar
 * resolves its row status: act-now beats answer-now beats read-me.
 */
export type ThreadAttentionKind = "approval" | "input" | "completed";

/**
 * Everything the badge and the notifications are built from. Threads and
 * flagged issues are *standing* attention — they hold the badge up until the
 * user deals with them. A finished autonomous run is an *announcement*: it is
 * only in the snapshot so the diff can fire it exactly once, and it never
 * counts towards the badge.
 */
export type AttentionKind = ThreadAttentionKind | "issue-attention" | "run-complete";

/** Which of the three sources an entry came from. */
export type AttentionDomain = "thread" | "issue" | "run";

/** Which item was in which attention state at the last publish. */
export type ThreadAttentionSnapshot = ReadonlyMap<string, AttentionKind>;

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

const ISSUE_ATTENTION_TITLE = "Issue needs you";
const RUN_COMPLETE_TITLE = "Autonomous run finished";

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

/** The issue fields the flag transition needs, and nothing else. */
export interface AttentionIssue {
  readonly id: IssueId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly needsAttentionAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

/** The project fields the run-finished transition needs. */
export interface AttentionProject extends AutonomousProjectView {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

/**
 * Board keys share the environment-scoped `env:id` shape with thread keys, so
 * they are prefixed to keep an issue id that happens to equal a thread id from
 * colliding with it.
 */
export function attentionProjectKey(ref: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string {
  return `${ref.environmentId}:${ref.projectId}`;
}

function issueAttentionKey(issue: AttentionIssue): string {
  return `issue:${issue.environmentId}:${issue.id}`;
}

/**
 * The finish timestamp is part of the key so the *next* run's completion is a
 * new entry rather than a repeat of the last one. Starting a new run drops the
 * old key, and a key merely disappearing never notifies.
 */
function runCompleteKey(project: AttentionProject, finishedAt: string | null): string {
  return `run:${project.environmentId}:${project.id}:${finishedAt ?? "unknown"}`;
}

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

/** One thing waiting on the user, resolved into everything the diff needs. */
export interface AttentionEntry {
  readonly key: string;
  readonly kind: AttentionKind;
  readonly domain: AttentionDomain;
  /** Standing entries hold the badge up; announcements only ever notify. */
  readonly standing: boolean;
  /** The key that silences this entry while the user is looking at it. */
  readonly suppressionKey: string;
  readonly alert: DesktopAttentionAlert;
}

export interface AttentionInput {
  readonly threads: readonly AttentionThread[];
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string | undefined>>;
  readonly issues?: readonly AttentionIssue[];
  readonly projects?: readonly AttentionProject[];
}

export function collectAttentionEntries(input: AttentionInput): readonly AttentionEntry[] {
  const entries: AttentionEntry[] = [];

  for (const thread of input.threads) {
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const kind = resolveThreadAttentionKind(thread, input.lastVisitedAtByThreadKey[key]);
    if (kind === null) continue;
    entries.push({
      key,
      kind,
      domain: "thread",
      standing: true,
      suppressionKey: key,
      alert: {
        title: ATTENTION_TITLES[kind],
        body: thread.title,
        target: { environmentId: thread.environmentId, threadId: thread.id },
      },
    });
  }

  for (const issue of input.issues ?? []) {
    if (issue.needsAttentionAt == null) continue;
    if (issue.deletedAt != null) continue;
    entries.push({
      key: issueAttentionKey(issue),
      kind: "issue-attention",
      domain: "issue",
      standing: true,
      suppressionKey: attentionProjectKey(issue),
      alert: {
        title: ISSUE_ATTENTION_TITLE,
        body: issue.title,
        target: {
          environmentId: issue.environmentId,
          projectId: issue.projectId,
          view: "review",
        },
      },
    });
  }

  for (const project of input.projects ?? []) {
    const runState = resolveAutonomousRunState(project);
    if (runState.kind !== "finished") continue;
    entries.push({
      key: runCompleteKey(project, runState.finishedAt),
      kind: "run-complete",
      domain: "run",
      // An announcement, not a chore: the run finishing leaves nothing waiting.
      standing: false,
      suppressionKey: attentionProjectKey({
        environmentId: project.environmentId,
        projectId: project.id,
      }),
      alert: {
        title: RUN_COMPLETE_TITLE,
        body: project.title,
        target: {
          environmentId: project.environmentId,
          projectId: project.id,
          view: "board",
        },
      },
    });
  }

  return entries;
}

export function buildAttentionSnapshot(input: AttentionInput): ThreadAttentionSnapshot {
  const snapshot = new Map<string, AttentionKind>();
  for (const entry of collectAttentionEntries(input)) {
    snapshot.set(entry.key, entry.kind);
  }
  return snapshot;
}

/** The rollup that stands in for a burst of transitions. */
function toRollupAlert(entries: readonly AttentionEntry[]): DesktopAttentionAlert {
  const noun = entries.every((entry) => entry.domain === "thread") ? "threads" : "items";
  return {
    title: `${entries.length} ${noun} need you`,
    body: entries
      .slice(0, MAX_INDIVIDUAL_ALERTS)
      .map((entry) => entry.alert.body)
      .join(" · "),
    target: null,
  };
}

/** Collapses a burst into one banner, and leaves a handful of alerts alone. */
export function rollupAttentionAlerts(
  entries: readonly AttentionEntry[],
): readonly DesktopAttentionAlert[] {
  if (entries.length > MAX_INDIVIDUAL_ALERTS) {
    return [toRollupAlert(entries)];
  }
  return entries.map((entry) => entry.alert);
}

export interface AttentionPublication {
  readonly state: DesktopAttentionState;
  readonly snapshot: ThreadAttentionSnapshot;
  /** The transitions behind `state.alerts`, un-rolled-up and tagged by domain,
   *  so a browser client can sink only the ones it cares about. */
  readonly alerts: readonly AttentionEntry[];
}

/**
 * Projects the current threads, issues and runs into a dock badge plus the
 * notifications owed since `previous`.
 *
 * `previous` is null when there is no trustworthy baseline — first publish, or
 * the last one ran without any threads loaded. Both cases seed silently:
 * reconnecting to an environment refills every thread at once, and treating
 * that as a hundred new transitions would bury the user in banners for work
 * they already knew about.
 */
export function resolveAttentionPublication(
  input: AttentionInput & {
    readonly previous: ThreadAttentionSnapshot | null;
    /** The thread the user is already looking at, when the window has focus. */
    readonly suppressedThreadKey: string | null;
    /** The board the user is already looking at, when the window has focus. */
    readonly suppressedProjectKey?: string | null;
  },
): AttentionPublication {
  const entries = collectAttentionEntries(input);
  const snapshot = new Map<string, AttentionKind>();
  const alerts: AttentionEntry[] = [];
  let badgeCount = 0;
  const previous = input.previous;
  const suppressedProjectKey = input.suppressedProjectKey ?? null;

  for (const entry of entries) {
    if (snapshot.has(entry.key)) continue;
    snapshot.set(entry.key, entry.kind);
    if (entry.standing) badgeCount += 1;
    if (previous === null) continue;
    if (previous.get(entry.key) === entry.kind) continue;
    const suppressed =
      entry.domain === "thread"
        ? entry.suppressionKey === input.suppressedThreadKey
        : entry.suppressionKey === suppressedProjectKey;
    if (suppressed) continue;
    alerts.push(entry);
  }

  return {
    snapshot,
    alerts,
    state: { badgeCount, alerts: rollupAttentionAlerts(alerts) },
  };
}

/**
 * What to hand back as `previous` next time.
 *
 * No threads means no data — a dropped or reconnecting environment, not a quiet
 * one — so the whole baseline is forgotten and the refill seeds silently. The
 * board half needs its own guard for the same reason: issues and projects ride
 * the same shell snapshot, and a client with threads but no projects loaded yet
 * would otherwise replay every flagged issue as news. Carrying the previous
 * board entries forward keeps the refill quiet without also blinding the thread
 * half, which is loaded and trustworthy.
 */
export function retainAttentionSnapshot(input: {
  readonly previous: ThreadAttentionSnapshot | null;
  readonly snapshot: ThreadAttentionSnapshot;
  readonly threadsLoaded: boolean;
  readonly boardLoaded: boolean;
}): ThreadAttentionSnapshot | null {
  if (!input.threadsLoaded) return null;
  if (input.boardLoaded || input.previous === null) return input.snapshot;

  const retained = new Map(input.snapshot);
  for (const [key, kind] of input.previous) {
    if (kind !== "issue-attention" && kind !== "run-complete") continue;
    retained.set(key, kind);
  }
  return retained;
}

/** Republishing an unchanged badge with nothing to announce is pure IPC noise. */
export function shouldPublishAttention(input: {
  readonly previousBadgeCount: number | null;
  readonly state: DesktopAttentionState;
}): boolean {
  return input.state.alerts.length > 0 || input.state.badgeCount !== input.previousBadgeCount;
}
