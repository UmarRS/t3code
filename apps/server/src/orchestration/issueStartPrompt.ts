import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

/**
 * The prompt that seeds the first turn of a thread started from an issue. Built
 * on the server so every surface that presses "Start" sends the same thing, and
 * kept pure so its shape is a test rather than a screenshot.
 */

export interface IssueStartPromptInput {
  readonly title: string;
  readonly description: string;
  /** Titles of the issues this one depends on, in dependency order. */
  readonly dependencyTitles: ReadonlyArray<string>;
  /**
   * Titles of sibling issues being worked at the same time by other agents.
   * Autonomous mode starts every startable issue at once, so a worker that
   * wanders outside its issue will collide with a sibling at merge time —
   * naming the siblings is what keeps each agent in its lane.
   */
  readonly parallelTitles?: ReadonlyArray<string> | undefined;
  /**
   * True when the thread runs unattended: a question the worker asks will
   * never be answered, so the prompt tells it to decide and keep going.
   */
  readonly autonomous?: boolean | undefined;
}

// Leave headroom under the provider input cap for the framing text; a pasted
// novel of a description should be truncated, not rejected at send time.
const DESCRIPTION_BUDGET = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 2_000;

export function buildIssueStartPrompt(input: IssueStartPromptInput): string {
  const description = input.description.trim();
  const truncated =
    description.length > DESCRIPTION_BUDGET
      ? `${description.slice(0, DESCRIPTION_BUDGET)}\n\n[description truncated]`
      : description;

  const sections = [`# ${input.title.trim()}`];
  if (truncated.length > 0) {
    sections.push(truncated);
  }
  if (input.dependencyTitles.length > 0) {
    sections.push(
      [
        "## Context: work this depends on",
        "These issues are already done. Build on them rather than redoing them.",
        ...input.dependencyTitles.map((title) => `- ${title.trim()}`),
      ].join("\n"),
    );
  }
  const parallelTitles = input.parallelTitles ?? [];
  if (parallelTitles.length > 0) {
    sections.push(
      [
        "## Context: work happening in parallel",
        "These are being worked right now by other agents in their own worktrees — stay within this issue's scope, and avoid unrelated refactors that would collide with them.",
        ...parallelTitles.map((title) => `- ${title.trim()}`),
      ].join("\n"),
    );
  }
  if (input.autonomous === true) {
    sections.push(
      [
        "## Working agreement",
        "You are running unattended: no one is available to answer questions. Treat the description above as the source of truth, make reasonable decisions yourself where it is silent, and note those decisions in your final message. Finish the work and leave the tree committed-ready rather than stopping to ask.",
        "Atlas owns commit, push, pull-request, review, and merge orchestration for this issue. Do not create, close, or merge pull requests yourself. If work belongs in a linked repository, represent it through that linked project's issue workflow rather than changing or shipping it outside Atlas's lifecycle.",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}
