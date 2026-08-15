import { describe, expect, it, vi } from "vite-plus/test";

import {
  openPullRequestLink,
  PullRequestLinkOpenError,
  shouldOpenPullRequestExternally,
} from "./openPullRequestLink";

describe("openPullRequestLink", () => {
  it("opens the requested pull request URL", async () => {
    const openExternal = vi.fn(async () => undefined);
    const targetUrl = "https://github.com/pingdotgg/t3code/pull/123";

    await openPullRequestLink({ openExternal }, targetUrl);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(targetUrl);
  });

  it("reports bridge failures with a safe target origin", async () => {
    const cause = new Error("desktop shell unavailable");
    const targetUrl = "https://github.com/pingdotgg/t3code/pull/123?token=secret";
    const openExternal = vi.fn(async () => Promise.reject(cause));

    const result = openPullRequestLink({ openExternal }, targetUrl);

    await expect(result).rejects.toEqual(
      new PullRequestLinkOpenError({
        targetOrigin: "https://github.com",
        cause,
      }),
    );
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret"));
  });
});

describe("shouldOpenPullRequestExternally", () => {
  it("uses the browser for command-click and control-click", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("keeps an unmodified click in the pull request view", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
