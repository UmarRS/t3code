/**
 * IssueStartCoordinator - opening the thread that does an issue's work.
 *
 * Starting an issue is a composite: gate on dependencies, cut an isolated
 * worktree, create the thread, seed its first turn from the issue text, and
 * rewind the issue if any of that fails. Both entry points need it — the
 * client's `issue.start` dispatch and the autonomous reactor working a backlog
 * — so it lives in one service rather than once per caller.
 *
 * @module IssueStartCoordinator
 */
import type {
  IssueId,
  MessageId,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type IssueStartCommand = Extract<OrchestrationCommand, { type: "issue.start" }>;

export interface IssueStartOptions {
  /**
   * Titles of sibling issues being worked at the same time, appended to the
   * seed prompt so parallel agents stay in their lanes. Absent for a manual
   * start, where nothing else was launched alongside it.
   */
  readonly parallelTitles?: ReadonlyArray<string> | undefined;
  /**
   * True when nobody is watching the thread: the seed prompt tells the worker
   * to decide for itself instead of stopping to ask questions no one will
   * answer.
   */
  readonly autonomous?: boolean | undefined;
}

export interface IssueReviewStartInput {
  readonly issueId: IssueId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The worker's worktree. The reviewer works in the same tree, not a new one. */
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly baseBranch: string;
  readonly createdAt: string;
}

export interface IssueReviewResumeInput {
  readonly issueId: IssueId;
  /** The reviewer thread a previous attempt already opened. */
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Which attempt this is, counting the one the provider killed. */
  readonly attempt: number;
  /** How many attempts the review gets in total. */
  readonly attempts: number;
  /** The provider error the previous attempt died on. */
  readonly detail: string;
  readonly createdAt: string;
}

export interface IssueStartCoordinatorShape {
  /**
   * Gate, create the worktree and thread, and seed the first turn. Rejections
   * from the decider (blocked dependency, already started, needs attention)
   * surface as the dispatch error; a failure after the issue was already
   * marked in progress rewinds it via `issue.start.failed`.
   */
  readonly startIssue: (
    command: IssueStartCommand,
    options?: IssueStartOptions,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;

  /**
   * Open a reviewer thread inside an issue's existing worktree and seed it
   * with the review prompt. Does not touch the issue's status: the verdict the
   * reviewer reports is what moves it.
   */
  readonly startIssueReview: (
    input: IssueReviewStartInput,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;

  /**
   * Ask an existing reviewer thread to finish a review its provider killed
   * mid-turn. Deliberately not a new review: the thread, its worktree, its
   * branch and its pull request are all still the ones under review, and the
   * only thing that was lost is the turn.
   */
  readonly resumeIssueReview: (
    input: IssueReviewResumeInput,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class IssueStartCoordinator extends Context.Service<
  IssueStartCoordinator,
  IssueStartCoordinatorShape
>()("t3/orchestration/Services/IssueStartCoordinator") {}
