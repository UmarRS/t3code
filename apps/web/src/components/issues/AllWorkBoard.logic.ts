import type { EnvironmentId, IssueStatus, ThreadId } from "@t3tools/contracts";

import {
  buildIssueBoardColumns,
  type BoardIssue,
  type IssueBoardColumn,
} from "./IssuesBoard.logic";

/**
 * Derivations for the overall board: every project's issues in one pipeline.
 *
 * The columns are the project board's own, so a card does not change meaning
 * when the user drops from the overall board into the board that owns it.
 * Archived work is the one exception — it is where issues go to stop being
 * looked at, and the overall board exists to say what is going on now.
 */

/** An issue as the overall board reads it: its project board plus its home. */
export interface AllWorkIssue extends BoardIssue {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}

/** Cards a column renders before it offers the rest behind a click. */
export const ALL_WORK_COLUMN_INITIAL_COUNT = 12;
export const ALL_WORK_COLUMN_PAGE_COUNT = 25;

const HIDDEN_STATUS: IssueStatus = "archived";

export function buildAllWorkColumns<TIssue extends AllWorkIssue>(
  issues: ReadonlyArray<TIssue>,
): ReadonlyArray<IssueBoardColumn<TIssue>> {
  return buildIssueBoardColumns(issues).filter((column) => column.status !== HIDDEN_STATUS);
}

/**
 * The search box filters this board too, and it matches what a card shows:
 * the issue's own title and the project it belongs to. An issue whose project
 * is gone still matches on its title rather than dropping out of the board.
 */
export function allWorkIssueMatchesQuery(
  input: { readonly title: string; readonly projectTitle: string | null },
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [input.title, input.projectTitle]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

/** True when no column has anything left to show. */
export function allWorkColumnsAreEmpty(
  columns: ReadonlyArray<IssueBoardColumn<AllWorkIssue>>,
): boolean {
  return columns.every((column) => column.issues.length === 0);
}

/**
 * The "#23" a pull request URL ends with, for the card's reference line.
 * Provider-agnostic: GitHub, GitLab and Azure all put the number last.
 */
export function pullRequestNumberLabel(url: string | null | undefined): string | null {
  if (url == null) return null;
  const match = /\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  return match?.[1] === undefined ? null : `#${match[1]}`;
}

/**
 * What a card shows under its title: the branch the work lives on, with the
 * pull request number once one exists. Null for work that has not started —
 * there is no branch to name yet, and inventing one would read as a lie.
 */
export function allWorkIssueReference(input: {
  readonly branch: string | null | undefined;
  readonly pullRequestUrl: string | null | undefined;
}): string | null {
  if (!input.branch) return null;
  const pullRequest = pullRequestNumberLabel(input.pullRequestUrl);
  return pullRequest === null ? input.branch : `${input.branch} ${pullRequest}`;
}
