import type { GitRunStackedActionResult, ThreadId } from "@t3tools/contracts";

/**
 * `git.runStackedAction` is keyed by working directory, so the server cannot
 * attribute a pull request to a thread on its own. After an action that opened
 * (or reused) a pull request, the client tells the issue aggregate which thread
 * it belonged to; the server resolves the linked issue and moves it to review.
 *
 * Only threads that actually back an issue dispatch — the server rejects the
 * rest, and every push would otherwise raise that error.
 */
export function resolveIssuePullRequestLink(input: {
  readonly result: Pick<GitRunStackedActionResult, "pr">;
  readonly threadId: ThreadId | null;
  readonly threadHasIssue: boolean;
}): { readonly threadId: ThreadId; readonly pullRequestUrl?: string } | null {
  if (input.threadId === null || !input.threadHasIssue) {
    return null;
  }
  if (input.result.pr.status === "skipped_not_requested") {
    return null;
  }
  const pullRequestUrl = input.result.pr.url;
  return {
    threadId: input.threadId,
    ...(pullRequestUrl !== undefined && pullRequestUrl.length > 0 ? { pullRequestUrl } : {}),
  };
}
