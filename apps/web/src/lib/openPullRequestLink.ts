import type { LocalApi } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type MouseEvent, useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";

export class PullRequestLinkOpenError extends Schema.TaggedErrorClass<PullRequestLinkOpenError>()(
  "PullRequestLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): PullRequestLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new PullRequestLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open pull request link."
      : `Unable to open pull request link at ${this.targetOrigin}.`;
  }
}

export async function openPullRequestLink(
  shell: Pick<LocalApi["shell"], "openExternal">,
  targetUrl: string,
): Promise<void> {
  try {
    await shell.openExternal(targetUrl);
  } catch (cause) {
    throw PullRequestLinkOpenError.fromCause(targetUrl, cause);
  }
}

/**
 * Returns true when the click should be left to the browser's/OS's native
 * handling (e.g. cmd/ctrl+click to open in a new tab) rather than intercepted.
 */
export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey">,
): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * Returns a click handler that opens a pull request URL in the system browser.
 *
 * Stops event propagation so activating the link does not also trigger an
 * enclosing row or trigger (e.g. opening the branch dropdown), and surfaces a
 * toast when the local API is unavailable or the open fails. A real anchor
 * already knows how to handle cmd/ctrl+click and middle-click, so those are
 * left alone; a plain click is intercepted and routed through openExternal.
 */
export function useOpenPrLink() {
  return useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
    event.stopPropagation();

    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    if (openInBrowser && isAnchor) return;

    event.preventDefault();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void openPullRequestLink(api.shell, prUrl).catch((error) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);
}
