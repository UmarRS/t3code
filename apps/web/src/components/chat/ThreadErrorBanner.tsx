import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, ClockIcon, PlayIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ThreadErrorBannerMode } from "./threadLimitPark";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  mode,
  onDismiss,
  onResumeNow,
  onStopWaiting,
}: {
  mode: ThreadErrorBannerMode | null;
  onDismiss?: () => void;
  /** Skip the wait and restart the interrupted turn now. Parked threads only. */
  onResumeNow?: () => void;
  /** Give up on the automatic restart, leaving the thread stopped. */
  onStopWaiting?: () => void;
}) {
  if (mode === null) return null;

  if (mode.kind === "parked") {
    const wait =
      mode.relativeLabel === null
        ? `Resuming at ${mode.resumeAtLabel}.`
        : `Resuming at ${mode.resumeAtLabel} (${mode.relativeLabel}).`;
    return (
      <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
        <Alert variant="warning" controlAlignment="first-line">
          <ClockIcon />
          <AlertDescription>
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>
                {`Paused until the model's limit resets. ${wait}`}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {mode.message}
              </TooltipPopup>
            </Tooltip>
          </AlertDescription>
          <AlertAction>
            <div className="flex items-center gap-1">
              {onResumeNow && (
                <Button variant="ghost" size="xs" onClick={onResumeNow}>
                  <PlayIcon />
                  Resume now
                </Button>
              )}
              {onStopWaiting && (
                <Button variant="ghost" size="xs" onClick={onStopWaiting}>
                  Stop waiting
                </Button>
              )}
            </div>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>
              {mode.message}
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {mode.message}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        <AlertAction>
          <div className="flex items-center gap-1">
            {onResumeNow && (
              <Button variant="ghost" size="xs" onClick={onResumeNow}>
                <PlayIcon />
                Retry
              </Button>
            )}
            {onDismiss && (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </div>
        </AlertAction>
      </Alert>
    </div>
  );
});
