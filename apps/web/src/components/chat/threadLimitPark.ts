/**
 * Reading a thread's "waiting for a provider limit to lift" state for the chat
 * error banner.
 *
 * A parked session is not the same failure the banner normally shows: the turn
 * did fail, but the server already knows when it will pick the work back up, so
 * the banner has to say when — and offer both ways out (go now, or stop
 * waiting) rather than only a dismiss.
 */
import type { OrchestrationSession } from "@t3tools/contracts";

/** How the error banner should present a thread's current failure. */
export type ThreadErrorBannerMode =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "parked";
      readonly message: string;
      /** Already formatted for display, e.g. "12:10 AM" or "tomorrow at 12:10 AM". */
      readonly resumeAtLabel: string;
      /** Null once the instant has passed and the ticker simply has not fired yet. */
      readonly relativeLabel: string | null;
    };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Wall-clock label for the resume instant, in the reader's own timezone. The
 * day is only named when it is not today, because a limit that lifts in the
 * small hours reads as a lie without it.
 */
export function formatResumeAtLabel(resumeAt: string, nowMs: number): string {
  const at = new Date(resumeAt);
  if (Number.isNaN(at.getTime())) {
    return resumeAt;
  }
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const now = new Date(nowMs);
  if (isSameLocalDay(at, now)) {
    return time;
  }
  const tomorrow = new Date(nowMs + 24 * HOUR_MS);
  if (isSameLocalDay(at, tomorrow)) {
    return `tomorrow at ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
}

/**
 * Coarse "in 2h 20m" for the wait. Deliberately whole minutes: the banner is
 * rendered from thread state rather than a timer, so a seconds-precise label
 * would just be stale.
 */
export function formatResumeCountdown(resumeAt: string, nowMs: number): string | null {
  const atMs = new Date(resumeAt).getTime();
  if (Number.isNaN(atMs)) {
    return null;
  }
  const remainingMs = atMs - nowMs;
  if (remainingMs <= 0) {
    return null;
  }
  const minutes = Math.max(1, Math.round(remainingMs / MINUTE_MS));
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
}

/**
 * What the banner should show, given the thread's error text and session. A
 * parked session wins over the plain error even though both are present — the
 * error is why it parked, and saying only that hides the recovery.
 */
export function resolveThreadErrorBannerMode(input: {
  readonly error: string | null;
  readonly session: Pick<OrchestrationSession, "resumeAt"> | null | undefined;
  readonly nowMs: number;
}): ThreadErrorBannerMode | null {
  const resumeAt = input.session?.resumeAt ?? null;
  if (resumeAt !== null) {
    return {
      kind: "parked",
      message: input.error ?? "The provider ran out of capacity.",
      resumeAtLabel: formatResumeAtLabel(resumeAt, input.nowMs),
      relativeLabel: formatResumeCountdown(resumeAt, input.nowMs),
    };
  }
  return input.error === null ? null : { kind: "error", message: input.error };
}
