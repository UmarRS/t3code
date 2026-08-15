import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  resolveAttentionPublication,
  shouldPublishAttention,
  type ThreadAttentionSnapshot,
} from "../desktopAttention";
import { useThreadShells } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";

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

/**
 * Mirrors the in-app "needs you" state onto the dock badge and macOS
 * notifications, and routes a notification click back to its thread.
 *
 * Renders nothing, and does nothing at all outside the desktop shell — a
 * browser client keeps only its in-app indicators.
 */
export function DesktopAttentionBridge() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const activeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const isWindowFocused = useWindowFocused();

  // A thread the user is watching right now needs no banner, but neither
  // focusing the window nor switching threads is itself news — held in a ref so
  // it stays out of the publish effect's dependencies.
  const suppressedThreadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    suppressedThreadKeyRef.current =
      isWindowFocused && activeThreadRef !== null ? scopedThreadKey(activeThreadRef) : null;
  }, [activeThreadRef, isWindowFocused]);

  const previousSnapshotRef = useRef<ThreadAttentionSnapshot | null>(null);
  const previousBadgeCountRef = useRef<number | null>(null);

  useEffect(() => {
    const attention = window.desktopBridge?.attention;
    if (!attention) return;

    const publication = resolveAttentionPublication({
      previous: previousSnapshotRef.current,
      threads,
      lastVisitedAtByThreadKey,
      suppressedThreadKey: suppressedThreadKeyRef.current,
    });

    // No threads means no data — a dropped or reconnecting environment, not a
    // quiet one. Forgetting the baseline keeps the refill from replaying every
    // outstanding item as news.
    previousSnapshotRef.current = threads.length === 0 ? null : publication.snapshot;

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
  }, [lastVisitedAtByThreadKey, threads]);

  useEffect(() => {
    const attention = window.desktopBridge?.attention;
    if (!attention) return;

    return attention.onActivate((target) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      });
    });
  }, [navigate]);

  return null;
}
