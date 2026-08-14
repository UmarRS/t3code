import { ThreadId, type GitRunStackedActionResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIssuePullRequestLink } from "./issuePullRequestLink";

const threadId = ThreadId.make("thread-1");

function prStep(
  status: GitRunStackedActionResult["pr"]["status"],
  url?: string,
): Pick<GitRunStackedActionResult, "pr"> {
  return { pr: { status, ...(url === undefined ? {} : { url }) } };
}

describe("resolveIssuePullRequestLink", () => {
  it("links a newly created pull request with its url", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("created", "https://github.com/acme/app/pull/7"),
        threadId,
        threadHasIssue: true,
      }),
    ).toEqual({ threadId, pullRequestUrl: "https://github.com/acme/app/pull/7" });
  });

  it("links a pull request that was already open", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("opened_existing", "https://github.com/acme/app/pull/7"),
        threadId,
        threadHasIssue: true,
      }),
    ).not.toBeNull();
  });

  it("still links when the action reported no url", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("created"),
        threadId,
        threadHasIssue: true,
      }),
    ).toEqual({ threadId });
  });

  it("stays quiet for actions that did not touch a pull request", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("skipped_not_requested"),
        threadId,
        threadHasIssue: true,
      }),
    ).toBeNull();
  });

  it("stays quiet when the thread backs no issue", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("created", "https://github.com/acme/app/pull/7"),
        threadId,
        threadHasIssue: false,
      }),
    ).toBeNull();
  });

  it("stays quiet without a thread", () => {
    expect(
      resolveIssuePullRequestLink({
        result: prStep("created"),
        threadId: null,
        threadHasIssue: true,
      }),
    ).toBeNull();
  });
});
