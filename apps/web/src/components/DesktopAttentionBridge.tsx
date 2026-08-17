import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isDesktopAttentionThreadTarget,
  type DesktopAttentionTarget,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  attentionProjectKey,
  resolveAttentionPublication,
  retainAttentionSnapshot,
  rollupAttentionAlerts,
  shouldPublishAttention,
  type AttentionEntry,
  type ThreadAttentionSnapshot,
} from "../desktopAttention";
import { useProjects, useThreadShells } from "../state/entities";
import { useAllEnvironmentIssues } from "../state/issues";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { stackedThreadToast, toastManager } from "./ui/toast";

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return focused;
}

interface BoardRouteRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type NavigateFn = ReturnType<typeof useNavigate>;

/** Opens whatever an alert points at: a thread, or a board on the right tab. */
function navigateToAttentionTarget(navigate: NavigateFn, target: DesktopAttentionTarget): void {
  if (isDesktopAttentionThreadTarget(target)) {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: target.environmentId, threadId: target.threadId },
    });
    return;
  }
  void navigate({
    to:
      target.view === "review"
        ? "/issues/$environmentId/$projectId/review"
        : "/issues/$environmentId/$projectId",
    params: { environmentId: target.environmentId, projectId: target.projectId },
  });
}

function attentionTargetActionLabel(target: DesktopAttentionTarget): string {
  if (isDesktopAttentionThreadTarget(target)) return "Open thread";
  return target.view === "review" ? "Open review" : "Open board";
}

/** The issues board the user is on, if any. Only that route carries a project id. */
function resolveBoardRouteRef(
  params: Partial<Record<"environmentId" | "projectId", string | undefined>>,
): BoardRouteRef | null {
  if (!params.environmentId || !params.projectId) {
    return null;
  }
  return {
    environmentId: params.environmentId as EnvironmentId,
    projectId: params.projectId as ProjectId,
  };
}

/**
 * Mirrors the in-app "needs you" state onto the dock badge and macOS
 * notifications, and routes a notification click back to its thread or board.
 *
 * In a browser the same transitions still have to reach the user, so the issue
 * and run-finished ones surface as in-app toasts instead. The desktop path
 * never toasts: the native notification is the notification.
 */
export function DesktopAttentionBridge() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const issues = useAllEnvironmentIssues();
  const projects = useProjects();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const activeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeBoardRef = useParams({
    strict: false,
    select: (params) => resolveBoardRouteRef(params),
  });
  const isWindowFocused = useWindowFocused();

  // Whatever the user is watching right now needs no banner, but neither
  // focusing the window nor switching pages is itself news — held in refs so
  // they stay out of the publish effect's dependencies.
  const suppressedThreadKeyRef = useRef<string | null>(null);
  const suppressedProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    suppressedThreadKeyRef.current =
      isWindowFocused && activeThreadRef !== null ? scopedThreadKey(activeThreadRef) : null;
    suppressedProjectKeyRef.current =
      isWindowFocused && activeBoardRef !== null ? attentionProjectKey(activeBoardRef) : null;
  }, [activeBoardRef, activeThreadRef, isWindowFocused]);

  // Navigation is only ever read from a callback, so it must not re-run the
  // publish effect when the router re-creates it.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const previousSnapshotRef = useRef<ThreadAttentionSnapshot | null>(null);
  const previousBadgeCountRef = useRef<number | null>(null);

  useEffect(() => {
    const attention = window.desktopBridge?.attention;

    const publication = resolveAttentionPublication({
      previous: previousSnapshotRef.current,
      threads,
      issues,
      projects,
      lastVisitedAtByThreadKey,
      suppressedThreadKey: suppressedThreadKeyRef.current,
      suppressedProjectKey: suppressedProjectKeyRef.current,
    });

    previousSnapshotRef.current = retainAttentionSnapshot({
      previous: previousSnapshotRef.current,
      snapshot: publication.snapshot,
      // No threads and no projects means no data — a dropped or reconnecting
      // environment rather than a quiet one. A loaded project list is proof the
      // shell snapshot arrived, so an empty thread list next to it is real and
      // the thread baseline can be trusted (which is what lets a user whose
      // only work is autonomous ever hear about anything).
      threadsLoaded: threads.length > 0 || projects.length > 0,
      // Issues and projects ride the same shell snapshot: with no projects
      // there is no board data to trust, and nothing to alert about either.
      boardLoaded: projects.length > 0,
    });

    if (attention) {
      if (
        !shouldPublishAttention({
          previousBadgeCount: previousBadgeCountRef.current,
          state: publication.state,
        })
      ) {
        return;
      }
      previousBadgeCountRef.current = publication.state.badgeCount;
      void attention.publish(publication.state);
      return;
    }

    // Browser fallback. Thread transitions already have in-app indicators
    // everywhere; the board ones have nowhere else to land.
    const boardEntries: readonly AttentionEntry[] = publication.alerts.filter(
      (entry) => entry.domain !== "thread",
    );
    for (const alert of rollupAttentionAlerts(boardEntries)) {
      const target = alert.target;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: alert.title,
          description: alert.body,
          ...(target === null
            ? {}
            : {
                actionProps: {
                  children: attentionTargetActionLabel(target),
                  onClick: () => {
                    navigateToAttentionTarget(navigateRef.current, target);
                  },
                },
                actionVariant: "outline" as const,
              }),
        }),
      );
    }
  }, [issues, lastVisitedAtByThreadKey, projects, threads]);

  useEffect(() => {
    const attention = window.desktopBridge?.attention;
    if (!attention) return;

    return attention.onActivate((target) => {
      navigateToAttentionTarget(navigate, target);
    });
  }, [navigate]);

  return null;
}
