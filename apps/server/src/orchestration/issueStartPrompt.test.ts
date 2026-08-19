import { describe, expect, it } from "@effect/vitest";

import { buildIssueStartPrompt } from "./issueStartPrompt.ts";

describe("buildIssueStartPrompt", () => {
  it("keeps autonomous workers out of the pull-request lifecycle", () => {
    const prompt = buildIssueStartPrompt({
      title: "Ship the fix",
      description: "Implement it.",
      dependencyTitles: [],
      autonomous: true,
    });

    expect(prompt).toContain("Atlas owns commit, push, pull-request, review, and merge");
    expect(prompt).toContain("Do not create, close, or merge pull requests yourself");
    expect(prompt).toContain("linked project's issue workflow");
  });
});
