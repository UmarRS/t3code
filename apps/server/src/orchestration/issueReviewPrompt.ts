import { ISSUE_REVIEW_PROMPT_INSTRUCTIONS } from "@t3tools/contracts";

/**
 * The prompt that seeds a reviewer thread. Built on the server so every review
 * in a run asks for the same thing, and kept pure so its shape is a test.
 *
 * The reviewer is not a rubber stamp and not a gatekeeper: it is expected to
 * fix what it finds and land the branch. Only fundamentally broken work comes
 * back unmerged, which is why the instructions lead with the fix-then-merge
 * policy rather than a checklist.
 */

export interface IssueReviewPromptInput {
  readonly title: string;
  readonly description: string;
  readonly baseBranch: string;
  readonly pullRequestUrl: string | null;
}

const DESCRIPTION_BUDGET = 20_000;

export function buildIssueReviewPrompt(input: IssueReviewPromptInput): string {
  const description = input.description.trim();
  const truncated =
    description.length > DESCRIPTION_BUDGET
      ? `${description.slice(0, DESCRIPTION_BUDGET)}\n\n[description truncated]`
      : description;

  const sections = [
    `# Review: ${input.title.trim()}`,
    [
      "You are reviewing the work in this worktree before it lands. You have full write access here.",
      `The pull request is ${input.pullRequestUrl ?? "not linked — find the branch's open PR yourself"}.`,
      `The base branch is \`${input.baseBranch}\`.`,
    ].join(" "),
  ];

  if (truncated.length > 0) {
    sections.push(["## What this issue asked for", truncated].join("\n\n"));
  }

  sections.push(
    [
      "## Do this, in order",
      "",
      `1. Read the branch's diff against \`${input.baseBranch}\` and judge it against the issue above.`,
      "2. Run the tests that cover the changed code. Targeted runs only — do not run the whole suite.",
      "3. Fix what you find, directly in this worktree, and commit and push the fixes.",
      `4. Rebase onto the latest \`${input.baseBranch}\`, resolving any conflicts. Siblings from the same batch may have landed since this branch started, so expect real conflicts and resolve them on their merits.`,
      "5. Merge the pull request.",
      "",
      "Nothing above overrides step 5: if the issue text asks for human approval before merging, you are it.",
    ].join("\n"),
  );

  sections.push(ISSUE_REVIEW_PROMPT_INSTRUCTIONS.trim());

  return sections.join("\n\n");
}
