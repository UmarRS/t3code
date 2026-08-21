import { CommandId, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  IssueStartCoordinator,
  type IssueReviewStartInput,
  type IssueStartCoordinatorShape,
} from "../Services/IssueStartCoordinator.ts";
import { buildIssueStartPrompt } from "../issueStartPrompt.ts";
import { buildIssueReviewPrompt } from "../issueReviewPrompt.ts";

const isDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/**
 * Worktree preparation is the part of a start that fails for reasons that
 * pass on their own: an index lock held by a sibling start, a fetch that
 * times out, a directory git is still cleaning up. Parking the issue on the
 * first stumble sends a user to needs-attention for something a second
 * attempt would have fixed, so give it three attempts a few seconds apart —
 * long enough to outlast a lock, short enough that a genuinely broken
 * repository still gets flagged promptly.
 */
const WORKTREE_PREPARATION_ATTEMPTS = 3;
const WORKTREE_PREPARATION_FIRST_RETRY_DELAY = Duration.seconds(2);
const WORKTREE_PREPARATION_LATER_RETRY_DELAY = Duration.seconds(5);
const WORKTREE_PREPARATION_RETRY = Schedule.recurs(WORKTREE_PREPARATION_ATTEMPTS - 1).pipe(
  Schedule.addDelay(({ attempt }) =>
    Effect.succeed(
      attempt === 1
        ? WORKTREE_PREPARATION_FIRST_RETRY_DELAY
        : WORKTREE_PREPARATION_LATER_RETRY_DELAY,
    ),
  ),
);

const toDispatchError = (message: string) => (cause: unknown) =>
  isDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message,
        cause,
      });

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)),
      Effect.mapError(toDispatchError("Failed to generate a command identifier.")),
    );

  // Status refreshes are cosmetic: a failed refresh must never fail a start.
  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const startIssue: IssueStartCoordinatorShape["startIssue"] = Effect.fn("startIssue")(
    function* (command, options) {
      const issue = yield* projectionSnapshotQuery
        .getIssueDetailById(command.issueId)
        .pipe(Effect.mapError(toDispatchError("Failed to read the issue.")));
      if (Option.isNone(issue)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Issue '${command.issueId}' does not exist.`,
        });
      }
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(issue.value.projectId)
        .pipe(Effect.mapError(toDispatchError("Failed to read the issue's project.")));
      if (Option.isNone(project)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Project '${issue.value.projectId}' does not exist.`,
        });
      }
      // Every board, not just this one: a story may wait on work another
      // project tracked, and naming it is the whole point of the context line.
      const allIssues = yield* projectionSnapshotQuery
        .listIssues()
        .pipe(Effect.mapError(toDispatchError("Failed to read the backlog.")));
      const titleByIssueId = new Map(allIssues.map((entry) => [entry.id, entry.title]));

      const prompt = buildIssueStartPrompt({
        title: issue.value.title,
        description: issue.value.description,
        dependencyTitles: issue.value.dependsOn.flatMap((dependencyId) => {
          const title = titleByIssueId.get(dependencyId);
          return title === undefined ? [] : [title];
        }),
        ...(options?.parallelTitles !== undefined
          ? { parallelTitles: options.parallelTitles }
          : {}),
        ...(options?.autonomous !== undefined ? { autonomous: options.autonomous } : {}),
      });

      const previousStatus = issue.value.status;
      // Decide the start first: the dependency gate, the needs-attention flag,
      // and the already-started check all live in the decider, so a blocked
      // issue is rejected before any git work happens.
      yield* orchestrationEngine
        .dispatch(command)
        .pipe(Effect.mapError(toDispatchError("Failed to start work on the issue.")));

      const bootstrap = Effect.gen(function* () {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("issue-start-thread-create"),
          threadId: command.threadId,
          projectId: issue.value.projectId,
          title: issue.value.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: command.createdAt,
        });

        // Every issue gets its own worktree: siblings are started in parallel and
        // would otherwise trample each other in one working tree.
        //
        // Nothing in here dispatches: the git steps are the retryable part of a
        // start, and re-running a command the engine already accepted — the
        // `thread.create` above most of all — is not something a retry may do.
        const prepareWorktree = Effect.gen(function* () {
          // The base must be a real branch name, never the literal "HEAD": it is
          // recorded as the branch's merge base and later becomes `--base` on the
          // pull request, where "HEAD" names no branch on the remote.
          const baseBranch =
            command.baseBranch ??
            (yield* gitWorkflow.localStatus({ cwd: project.value.workspaceRoot }).pipe(
              Effect.map((status) => status.refName),
              Effect.orElseSucceed(() => null),
            )) ??
            "HEAD";
          const startFromOrigin =
            command.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: project.value.workspaceRoot,
              remoteName: "origin",
            }));
          let worktreeBaseRef = baseBranch;
          if (startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: project.value.workspaceRoot,
              remoteName: "origin",
            });
            const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: project.value.workspaceRoot,
              refName: baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }

          // A retry after a failed or abandoned attempt finds this issue's branch
          // already in the repository, sometimes with a live worktree. Reuse what
          // exists instead of failing `git worktree add` on the collision — the
          // branch may even carry pushed work from the earlier attempt. This is
          // also what makes the attempts below re-entrant: attempt two picks up
          // whatever attempt one managed to create before it failed.
          const issueBranch = command.branch ?? `issue/${command.issueId}`;
          const existingBranch = yield* gitWorkflow
            .listRefs({
              cwd: project.value.workspaceRoot,
              query: issueBranch,
              refKind: "local",
              refresh: true,
            })
            .pipe(
              Effect.map(
                (result) =>
                  result.refs.find((ref) => !ref.isRemote && ref.name === issueBranch) ?? null,
              ),
              Effect.orElseSucceed(() => null),
            );
          return existingBranch?.worktreePath != null
            ? { worktree: { path: existingBranch.worktreePath, refName: issueBranch } }
            : existingBranch !== null
              ? // The branch survived without a worktree: check it out as-is.
                yield* gitWorkflow.createWorktree({
                  cwd: project.value.workspaceRoot,
                  refName: issueBranch,
                  baseRefName: baseBranch,
                  path: null,
                })
              : yield* gitWorkflow.createWorktree({
                  cwd: project.value.workspaceRoot,
                  refName: worktreeBaseRef,
                  // Always name the branch: without one, git would try to check out the
                  // base ref itself, which fails the moment two issues fork from it.
                  newRefName: issueBranch,
                  baseRefName: baseBranch,
                  path: null,
                });
        });

        const worktree = yield* prepareWorktree.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("issue worktree preparation attempt failed", {
              issueId: command.issueId,
              threadId: command.threadId,
              detail: error.message,
            }),
          ),
          Effect.retry(WORKTREE_PREPARATION_RETRY),
          Effect.mapError(
            toDispatchError(
              `Failed to prepare the issue's worktree after ${WORKTREE_PREPARATION_ATTEMPTS} attempts.`,
            ),
          ),
        );

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("issue-start-thread-meta-update"),
          threadId: command.threadId,
          branch: worktree.worktree.refName,
          worktreePath: worktree.worktree.path,
        });
        yield* refreshGitStatus(worktree.worktree.path);

        // Best effort: a project whose setup script fails still gets its thread.
        yield* projectSetupScriptRunner
          .runForThread({
            threadId: command.threadId,
            projectId: issue.value.projectId,
            projectCwd: project.value.workspaceRoot,
            worktreePath: worktree.worktree.path,
          })
          .pipe(Effect.ignoreCause({ log: true }));

        return yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* serverCommandId("issue-start-turn"),
          threadId: command.threadId,
          message: {
            messageId: command.messageId,
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: command.modelSelection,
          titleSeed: issue.value.title,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.createdAt,
        });
      });

      return yield* bootstrap.pipe(
        Effect.mapError(toDispatchError("Failed to prepare the issue's worktree.")),
        Effect.tapError((error) =>
          // Compensate: the issue is already `in_progress` with a thread it will
          // never get. Delete the half-built thread and rewind the issue so it is
          // startable again.
          Effect.all([
            serverCommandId("issue-start-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
            serverCommandId("issue-start-failed").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "issue.start.failed",
                  commandId,
                  issueId: command.issueId,
                  previousStatus,
                  detail: error.message,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
          ]).pipe(Effect.asVoid),
        ),
      );
    },
  );

  const startIssueReview: IssueStartCoordinatorShape["startIssueReview"] = Effect.fn(
    "startIssueReview",
  )(function* (input: IssueReviewStartInput) {
    const issue = yield* projectionSnapshotQuery
      .getIssueDetailById(input.issueId)
      .pipe(Effect.mapError(toDispatchError("Failed to read the issue under review.")));
    if (Option.isNone(issue)) {
      return yield* new OrchestrationDispatchCommandError({
        message: `Issue '${input.issueId}' does not exist.`,
      });
    }

    const prompt = buildIssueReviewPrompt({
      title: issue.value.title,
      description: issue.value.description,
      baseBranch: input.baseBranch,
      pullRequestUrl: issue.value.pullRequestUrl,
    });

    // The reviewer runs in the worker's worktree — reviewing a branch means
    // being able to build, test, fix, and merge it, which a fresh checkout of
    // main cannot do.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: yield* serverCommandId("issue-review-thread-create"),
        threadId: input.threadId,
        projectId: issue.value.projectId,
        title: `Review: ${issue.value.title}`,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(toDispatchError("Failed to create the reviewer thread.")));

    return yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("issue-review-turn"),
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: input.modelSelection,
        titleSeed: `Review: ${issue.value.title}`,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.mapError(toDispatchError("Failed to start the review turn.")),
        Effect.tapError((error) =>
          Effect.logWarning("issue review turn failed to start", {
            issueId: input.issueId,
            threadId: input.threadId,
            detail: error.message,
            cause: Cause.pretty(Cause.fail(error)),
          }),
        ),
      );
  });

  return {
    startIssue,
    startIssueReview,
  } satisfies IssueStartCoordinatorShape;
});

export const IssueStartCoordinatorLive = Layer.effect(IssueStartCoordinator, make);
