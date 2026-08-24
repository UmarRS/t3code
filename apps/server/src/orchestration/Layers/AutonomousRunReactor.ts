import {
  activeAutonomousIssues,
  CommandId,
  evaluateAutonomousRun,
  isSessionParkedForResume,
  IssueId,
  MessageId,
  reachableAutonomousProjectIds,
  type OrchestrationEvent,
  type OrchestrationIssue,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { IssueStartCoordinator } from "../Services/IssueStartCoordinator.ts";
import {
  AutonomousRunReactor,
  type AutonomousRunReactorShape,
} from "../Services/AutonomousRunReactor.ts";
import { ReviewComplexityClassifier } from "../Services/ReviewComplexityClassifier.ts";
import {
  resolveReviewerModelSelection,
  resolveTieredReviewerModelSelection,
} from "../reviewerModelSelection.ts";

/**
 * The autonomous run loop.
 *
 * Two queues, deliberately shaped differently. **Evaluation** is a fan-out: a
 * tick reads a project's backlog and starts every startable issue at once,
 * because independent issues have no reason to wait for each other.
 * **Merging** is a funnel: reviewers run one at a time, so each one rebases
 * onto a main that already contains the siblings that landed before it.
 *
 * Everything the loop decides is derived from projected state rather than from
 * memory, so a restart resumes instead of double-starting: an issue that
 * already has a thread is not startable, an issue that already has a reviewer
 * thread is not re-queued, and a flagged issue is excluded from both. The
 * in-memory sets below are optimisations against double work inside one
 * process, never the source of truth.
 */

// Autonomous mode forces the permission mode for everything it spawns: a run
// with no human in it cannot answer an approval prompt, so a worker or reviewer
// left in an interactive mode would simply hang. The user opted into this by
// turning autonomous mode on.
const AUTONOMOUS_RUNTIME_MODE = "full-access" as const;
const AUTONOMOUS_INTERACTION_MODE = "default" as const;

/** How many issues one tick will start at once. Bounded so a 50-issue backlog does not fork 50 provider processes in the same instant. */
const MAX_PARALLEL_STARTS = 4;

/** The branch autonomous work is measured against, reviewed against and merged into. */
const AUTONOMOUS_BASE_BRANCH = "main";

/** External merges do not emit orchestration events, so active runs reconcile their one in-flight review periodically. */
const EXTERNAL_MERGE_RECONCILE_INTERVAL = Duration.minutes(1);

type EvaluateItem = { readonly projectId: ProjectId };
type MergeItem = { readonly issueId: IssueId };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const issueStartCoordinator = yield* IssueStartCoordinator;
  const gitWorkflow = yield* GitWorkflowService;
  const providerRegistry = yield* ProviderRegistry;
  const receipts = yield* RuntimeReceiptBus;
  const reviewComplexityClassifier = yield* ReviewComplexityClassifier;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`autonomous:${tag}:${uuid}`)));

  /** Issues whose pull request is being opened right now, so a second turn-end for the same thread does not open a second PR. */
  const pullRequestsInFlight = new Set<string>();
  /** Issues already handed to the merge queue in this process. */
  const queuedForMerge = new Set<string>();
  /** Reviews the merge queue is waiting on, completed when their verdict lands. */
  const pendingReviews = new Map<string, Deferred.Deferred<void>>();

  const flagNeedsAttention = Effect.fn("flagNeedsAttention")(function* (
    issueId: IssueId,
    reason: string,
  ) {
    yield* orchestrationEngine
      .dispatch({
        type: "issue.attention.flag",
        commandId: yield* serverCommandId("attention-flag"),
        issueId,
        reason: reason.slice(0, 2_000),
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* receipts.publish({
      type: "autonomous.issue.flagged",
      issueId,
      reason,
      createdAt: yield* nowIso,
    });
  });

  const projectRunIsLive = Effect.fn("projectRunIsLive")(function* (projectId: ProjectId) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(projectId);
    return Option.isSome(project) && project.value.autonomousStartedAt != null;
  });

  /**
   * Whether this loop owns the issue's pull request, review and merge.
   *
   * A live run on the issue's project is the usual reason. The other is an
   * issue delegated in from an autonomous worker in another project: the
   * project it landed on may have no run of its own and no human watching it
   * either, and the delegated change is only reviewed and merged if this loop
   * carries it — which is the whole point of routing that work through a board
   * instead of letting a companion write to the repository untracked.
   */
  const issueIsAutonomouslyWorked = Effect.fn("issueIsAutonomouslyWorked")(function* (
    issue: OrchestrationIssue,
  ) {
    if (issue.delegatedFromThreadId != null) return true;
    return yield* projectRunIsLive(issue.projectId);
  });

  /** True for an issue this loop must carry even though its project has no run. */
  const isDelegatedIssue = (issue: OrchestrationIssue) => issue.delegatedFromThreadId != null;

  // ---------------------------------------------------------------- evaluate

  const startIssueForRun = Effect.fn("startIssueForRun")(function* (
    issue: OrchestrationIssue,
    parallelTitles: ReadonlyArray<string>,
  ) {
    const modelSelection =
      issue.modelSelection ?? (yield* resolveWorkerModelSelection(issue.projectId));
    if (modelSelection === null) {
      yield* flagNeedsAttention(issue.id, "No provider is configured to do this work.");
      return;
    }
    const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
    const messageId = MessageId.make(yield* crypto.randomUUIDv4);
    const createdAt = yield* nowIso;
    const started = yield* issueStartCoordinator
      .startIssue(
        {
          type: "issue.start",
          commandId: yield* serverCommandId(`issue-start:${issue.id}`),
          issueId: issue.id,
          threadId,
          messageId,
          modelSelection,
          runtimeMode: AUTONOMOUS_RUNTIME_MODE,
          interactionMode: AUTONOMOUS_INTERACTION_MODE,
          startFromOrigin: true,
          createdAt,
        },
        { parallelTitles, autonomous: true },
      )
      .pipe(
        Effect.as(true),
        // A rejected start is normal (a raced tick, a dependency that moved).
        // A start that fails after the gate is a real problem and parks the
        // issue so the run does not spin on it.
        Effect.catch((error) =>
          flagNeedsAttention(issue.id, `Could not start work: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (!started) return;
    yield* receipts.publish({
      type: "autonomous.issue.started",
      projectId: issue.projectId,
      issueId: issue.id,
      threadId,
      createdAt,
    });
  });

  /**
   * The model autonomous workers use: the project's default when it has one, so
   * a run honours the choice the user already made for that project. Falls back
   * to the reviewer's model, and null when nothing is configured at all.
   */
  const resolveWorkerModelSelection = Effect.fn("resolveWorkerModelSelection")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(projectId);
    const defaultSelection = Option.isSome(project) ? project.value.defaultModelSelection : null;
    if (defaultSelection !== null) return defaultSelection;
    return resolveReviewerModelSelection(yield* providerRegistry.getProviders);
  });

  /**
   * A user may merge the linked pull request on GitHub while the reviewer is
   * waiting for checks. GitHub does not send that action through Atlas, so
   * reconcile it into the same durable verdict the reviewer would have
   * emitted. Restrict this to claimed reviews: an issue whose reviewer has not
   * started yet remains owned by the merge queue.
   */
  const reconcileExternallyMergedIssue = Effect.fn("reconcileExternallyMergedIssue")(function* (
    issue: OrchestrationIssue,
  ) {
    const reviewerThreadId = issue.reviewerThreadId;
    if (
      issue.status !== "in_review" ||
      issue.reviewVerdict === "merged" ||
      reviewerThreadId === null ||
      reviewerThreadId === undefined ||
      issue.threadId === null ||
      issue.pullRequestUrl === null
    ) {
      return false;
    }

    const workerThread = yield* projectionSnapshotQuery.getThreadShellById(issue.threadId);
    if (Option.isNone(workerThread) || workerThread.value.worktreePath === null) {
      return false;
    }

    const resolved = yield* gitWorkflow
      .resolvePullRequest({
        cwd: workerThread.value.worktreePath,
        reference: issue.pullRequestUrl,
      })
      .pipe(
        Effect.map((result) => Option.some(result.pullRequest)),
        Effect.catchCause((cause) =>
          Effect.logDebug("autonomous external merge reconciliation skipped", {
            issueId: issue.id,
            pullRequestUrl: issue.pullRequestUrl,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
      );
    if (Option.isNone(resolved) || resolved.value.state !== "merged") {
      return false;
    }

    yield* orchestrationEngine.dispatch({
      type: "issue.review.record",
      commandId: yield* serverCommandId(`external-merge:${issue.id}`),
      issueId: issue.id,
      reviewerThreadId,
      verdict: "merged",
      notes: "The linked pull request was merged outside Atlas while its review was active.",
    });
    return true;
  });

  /** Why a blocked issue is never going to start, in the words a human reads on the card. */
  const describeStall = Effect.fn("describeStall")(function* (
    issue: OrchestrationIssue,
    blocker: OrchestrationIssue,
  ) {
    if (blocker.projectId === issue.projectId) {
      return `Blocked by '${blocker.title}', which is not going to finish on its own.`;
    }
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(blocker.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const board = Option.isSome(project) ? project.value.title : "another project";
    return `Blocked by '${blocker.title}' on the ${board} board, which nothing is working. Start a run there, or drop the dependency.`;
  });

  const evaluateProject = Effect.fn("evaluateProject")(function* (projectId: ProjectId) {
    const runIsLive = yield* projectRunIsLive(projectId);

    // The whole environment, not one board: a dependency may name an issue
    // another project tracks, and a run that cannot see it would start work
    // whose groundwork is missing.
    let issues = yield* projectionSnapshotQuery.listIssues();
    const boardIssues = () => issues.filter((issue) => issue.projectId === projectId);
    // Without a live run, the only issues this loop may touch are the ones
    // another project delegated in. Nothing here starts them — the linked
    // project coordinator did that synchronously — and nothing here may
    // "complete" a run that does not exist; what is left is carrying them
    // through review. A project with neither is not this loop's business.
    const owned = runIsLive ? boardIssues() : boardIssues().filter(isDelegatedIssue);
    if (!runIsLive && owned.length === 0) return;

    const reconciledMerge = yield* Effect.forEach(owned, reconcileExternallyMergedIssue, {
      concurrency: 1,
    }).pipe(Effect.map((results) => results.some(Boolean)));
    if (reconciledMerge) {
      issues = yield* projectionSnapshotQuery.listIssues();
    }

    if (runIsLive) {
      // A worker can finish while the run is paused. Its session event is
      // deliberately ignored then, so resuming must derive the missed handoff
      // from durable thread state just like startup derives the backlog.
      for (const issue of boardIssues()) {
        if (
          issue.status !== "in_progress" ||
          issue.threadId === null ||
          issue.needsAttentionAt !== null ||
          issue.pullRequestUrl !== null
        ) {
          continue;
        }
        yield* retryFinishedWorker(issue);
      }
      issues = yield* projectionSnapshotQuery.listIssues();

      // Only the boards this board's plan reaches need a liveness read:
      // whether a board nobody is running holds a blocker is what separates a
      // run that is waiting from one that is stuck. The same set is what the
      // run switch starts, so the two cannot disagree about which boards a
      // plan spans.
      const advancing = new Set<ProjectId>();
      for (const candidate of reachableAutonomousProjectIds(issues, projectId)) {
        if (yield* projectRunIsLive(candidate)) advancing.add(candidate);
      }
      const evaluation = evaluateAutonomousRun({
        projectId,
        issues,
        isProjectAdvancing: (candidate) => advancing.has(candidate),
      });

      // Nothing to start, nothing moving, and nothing this board is waiting on
      // another board to finish: whatever is left is done, canceled, or
      // flagged, none of which the run can advance. Turn itself off so the UI
      // can show a finished run — but first flag the work that is stuck behind
      // a blocker nobody is working, so a board that stops short of its plan
      // says why instead of going quiet.
      if (evaluation.complete) {
        for (const stalled of evaluation.stalled) {
          yield* flagNeedsAttention(
            stalled.issue.id,
            yield* describeStall(stalled.issue, stalled.blocker),
          );
        }
        yield* orchestrationEngine
          .dispatch({
            type: "project.autonomous.disable",
            commandId: yield* serverCommandId(`run-complete:${projectId}`),
            projectId,
            reason: "completed",
          })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* receipts.publish({
          type: "autonomous.run.completed",
          projectId,
          createdAt: yield* nowIso,
        });
        return;
      }

      // A board with nothing of its own to do, waiting on a story another board
      // is still working, stays live and does nothing this tick. The blocker
      // landing re-evaluates it.
      const { startable, active } = evaluation;

      // Every issue about to run, plus everything already running, is context
      // for every worker: each one needs to know which neighbours it must not
      // touch.
      const cohortTitles = [...startable, ...active].map((issue) => ({
        id: issue.id,
        title: issue.title,
      }));
      yield* Effect.forEach(
        startable,
        (issue) =>
          startIssueForRun(
            issue,
            cohortTitles.filter((entry) => entry.id !== issue.id).map((entry) => entry.title),
          ),
        { concurrency: MAX_PARALLEL_STARTS, discard: true },
      );
    }

    // Issues whose worker is done and whose pull request is open, but that no
    // reviewer has claimed. Derived from state, so a restart re-queues them.
    for (const issue of runIsLive ? boardIssues() : boardIssues().filter(isDelegatedIssue)) {
      const readyForReview =
        issue.status === "in_review" &&
        issue.needsAttentionAt == null &&
        issue.reviewVerdict == null &&
        !queuedForMerge.has(issue.id);
      if (!readyForReview) continue;
      queuedForMerge.add(issue.id);
      yield* mergeQueue.enqueue({ issueId: issue.id });
    }
  });

  // ------------------------------------------------------------ worker turns

  /**
   * A worker thread's turn ended. Under a live run that means: commit, push,
   * open the pull request, and hand the issue to the merge queue. A session
   * that ended in error, or a pull request that cannot be opened, parks the
   * issue instead — the run continues with its siblings either way.
   */
  const handleWorkerTurnEnd = Effect.fn("handleWorkerTurnEnd")(function* (
    threadId: ThreadId,
    sessionStatus: string,
  ) {
    const issueOption = yield* findIssueByWorkerThread(threadId);
    if (Option.isNone(issueOption)) return;
    const issue = issueOption.value;
    if (issue.status !== "in_progress" || issue.needsAttentionAt != null) return;
    if (!(yield* issueIsAutonomouslyWorked(issue))) return;

    if (sessionStatus === "error") {
      yield* flagNeedsAttention(
        issue.id,
        "The worker session ended in an error before the work could be reviewed.",
      );
      return;
    }

    if (pullRequestsInFlight.has(issue.id)) return;
    pullRequestsInFlight.add(issue.id);
    yield* openPullRequestForIssue(issue, threadId).pipe(
      Effect.ensuring(Effect.sync(() => pullRequestsInFlight.delete(issue.id))),
    );
  });

  const findIssueByWorkerThread = Effect.fn("findIssueByWorkerThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(thread)) return Option.none<OrchestrationIssue>();
    // Session events are global, so this runs for every thread in the app. A
    // live run means any of the project's issues may be the one; without a run
    // the scan still has to happen — an issue delegated in from another project
    // is worked with no run of its own — but only delegated issues can match.
    const runIsLive = yield* projectRunIsLive(thread.value.projectId);
    const issues = yield* projectionSnapshotQuery.listIssuesByProjectId(thread.value.projectId);
    const match = issues.find(
      (issue) => issue.threadId === threadId && (runIsLive || isDelegatedIssue(issue)),
    );
    return match === undefined ? Option.none<OrchestrationIssue>() : Option.some(match);
  });

  const openPullRequestForIssue = Effect.fn("openPullRequestForIssue")(function* (
    issue: OrchestrationIssue,
    threadId: ThreadId,
  ) {
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    const cwd = Option.isSome(thread) ? thread.value.worktreePath : null;
    if (cwd === null) {
      yield* flagNeedsAttention(
        issue.id,
        "The worker thread has no worktree, so no pull request could be opened.",
      );
      return;
    }

    // The worker may have pushed or even merged this branch itself. Recover
    // that provider state before looking at the local commit range: a stale
    // local base is precisely what makes an already-merged branch look new.
    // Full invalidation also bumps the provider PR-lookup epoch; invalidating
    // only ahead/behind status would leave the slower branch-PR cache intact.
    yield* gitWorkflow.invalidateStatus(cwd);
    const existingPullRequest = yield* gitWorkflow.remoteStatus({ cwd }).pipe(
      Effect.map((status) => status?.pr ?? null),
      Effect.orElseSucceed(() => null),
    );
    if (existingPullRequest !== null) {
      yield* orchestrationEngine
        .dispatch({
          type: "issue.pull-request.link",
          commandId: yield* serverCommandId(`existing-pr-link:${issue.id}`),
          threadId,
          pullRequestUrl: existingPullRequest.url,
        })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* receipts.publish({
        type: "autonomous.pull-request.opened",
        issueId: issue.id,
        threadId,
        pullRequestUrl: existingPullRequest.url,
        createdAt: yield* nowIso,
      });
      if (existingPullRequest.state === "merged") {
        yield* orchestrationEngine
          .dispatch({
            type: "issue.status.set",
            commandId: yield* serverCommandId(`existing-pr-merged:${issue.id}`),
            issueId: issue.id,
            status: "done",
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return;
    }

    // A worker can finish with nothing to ship and still have done its job: it
    // may have routed every piece of the work to a linked project's board, or
    // found the work already done. Asking a provider to open a pull request
    // for an empty range fails, and parking the issue for that would call a
    // finished issue broken — so ask git first.
    //
    // Failing the check falls through to the normal path. A probe that cannot
    // answer must never be the reason real work is stranded.
    const shippable = yield* gitWorkflow
      .hasShippableWork({ cwd, baseBranch: AUTONOMOUS_BASE_BRANCH })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("autonomous shippable-work check failed", {
            issueId: issue.id,
            cwd,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(true)),
        ),
      );
    if (!shippable) {
      yield* completeIssueWithoutChanges(issue, threadId);
      return;
    }

    // The same server-side action the PR button runs; calling it here keeps one
    // implementation of commit/push/PR rather than a second one for robots.
    const actionId = `autonomous-pr:${issue.id}`;
    const result = yield* gitWorkflow
      .runStackedAction({ actionId, cwd, action: "commit_push_pr" })
      .pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );

    if (!result.ok) {
      yield* flagNeedsAttention(issue.id, `Could not open a pull request: ${result.message}`);
      return;
    }

    const pullRequestUrl = result.value.pr.url ?? null;
    if (result.value.pr.status === "skipped_not_requested" || pullRequestUrl === null) {
      yield* flagNeedsAttention(
        issue.id,
        "The commit/push/PR run finished without producing a pull request.",
      );
      return;
    }

    yield* orchestrationEngine
      .dispatch({
        type: "issue.pull-request.link",
        commandId: yield* serverCommandId(`pr-link:${issue.id}`),
        threadId,
        pullRequestUrl,
      })
      .pipe(Effect.ignoreCause({ log: true }));

    yield* receipts.publish({
      type: "autonomous.pull-request.opened",
      issueId: issue.id,
      threadId,
      pullRequestUrl,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Finish an issue whose worker left nothing behind to ship. There is no
   * branch to review and no pull request to merge, so `done` is the honest
   * end state — the run's completion check counts it, and the review step is
   * skipped for the good reason that there is nothing to review.
   */
  const completeIssueWithoutChanges = Effect.fn("completeIssueWithoutChanges")(function* (
    issue: OrchestrationIssue,
    threadId: ThreadId,
  ) {
    const delegated = yield* workerDelegatedWorkToLinkedProjects(threadId);
    const reason = delegated
      ? "The worker finished without local changes; its work was delegated to linked projects."
      : "The worker finished without local changes; there was nothing to ship.";
    yield* orchestrationEngine
      .dispatch({
        type: "issue.status.set",
        commandId: yield* serverCommandId(`no-changes:${issue.id}`),
        issueId: issue.id,
        status: "done",
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* receipts.publish({
      type: "autonomous.issue.completed-without-changes",
      issueId: issue.id,
      threadId,
      reason,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Whether this worker handed work to another project's board. The mark that
   * says so lives on the issues it filed, in projects this one knows nothing
   * about, and no query asks across projects — so this reads the shell
   * snapshot, which is the same thing the restart sweep already reads. It runs
   * once per empty-handed worker, which is rare, and only to word a sentence.
   */
  const workerDelegatedWorkToLinkedProjects = Effect.fn("workerDelegatedWorkToLinkedProjects")(
    function* (threadId: ThreadId) {
      const snapshot = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => null));
      if (snapshot === null) return false;
      return snapshot.issues.some((issue) => issue.delegatedFromThreadId === threadId);
    },
  );

  /**
   * A PR failure happens after the worker has already committed and pushed. A
   * user clearing that flag should retry only the idempotent PR workflow, not
   * discard the worker thread and ask an agent to implement the issue again.
   *
   * This intentionally works while the autonomous run is off: runs with only
   * flagged work finish themselves, but "Retry pull request" must still do
   * what it says. A successful explicit retry proceeds directly to review.
   */
  const retryPullRequestAfterAttentionClear = Effect.fn("retryPullRequestAfterAttentionClear")(
    function* (issueId: IssueId) {
      const issueOption = yield* projectionSnapshotQuery.getIssueSummaryById(issueId);
      if (Option.isNone(issueOption)) return;
      const issue = issueOption.value;
      if (
        issue.status !== "in_progress" ||
        issue.threadId === null ||
        issue.pullRequestUrl !== null
      ) {
        return;
      }

      const threadOption = yield* projectionSnapshotQuery.getThreadShellById(issue.threadId);
      if (Option.isNone(threadOption)) return;
      const thread = threadOption.value;
      const workerFinished =
        thread.latestTurn?.state === "completed" ||
        (thread.latestTurn === null && thread.session?.status === "idle");
      if (!workerFinished || thread.hasPendingUserInput || thread.hasPendingApprovals) return;

      if (pullRequestsInFlight.has(issue.id)) return;
      pullRequestsInFlight.add(issue.id);
      yield* openPullRequestForIssue(issue, issue.threadId).pipe(
        Effect.ensuring(Effect.sync(() => pullRequestsInFlight.delete(issue.id))),
      );

      const refreshed = yield* projectionSnapshotQuery.getIssueSummaryById(issue.id);
      if (
        Option.isSome(refreshed) &&
        refreshed.value.status === "in_review" &&
        refreshed.value.needsAttentionAt === null &&
        refreshed.value.reviewVerdict === null &&
        !queuedForMerge.has(issue.id)
      ) {
        queuedForMerge.add(issue.id);
        yield* mergeQueue.enqueue({ issueId: issue.id });
      }
    },
  );

  /** Resume the PR handoff for a worker whose terminal event happened while paused. */
  const retryFinishedWorker = Effect.fn("retryFinishedWorker")(function* (
    issue: OrchestrationIssue,
  ) {
    if (issue.threadId === null) return;
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(issue.threadId);
    if (Option.isNone(threadOption)) return;
    const thread = threadOption.value;
    const workerFinished =
      thread.latestTurn?.state === "completed" ||
      (thread.latestTurn === null && thread.session?.status === "idle");
    if (!workerFinished || thread.hasPendingUserInput || thread.hasPendingApprovals) return;
    if (pullRequestsInFlight.has(issue.id)) return;
    pullRequestsInFlight.add(issue.id);
    yield* openPullRequestForIssue(issue, issue.threadId).pipe(
      Effect.ensuring(Effect.sync(() => pullRequestsInFlight.delete(issue.id))),
    );
  });

  // --------------------------------------------------------------- reviewing

  const processMergeItem = Effect.fn("processMergeItem")(function* (item: MergeItem) {
    const issueOption = yield* projectionSnapshotQuery.getIssueSummaryById(item.issueId);
    if (Option.isNone(issueOption)) return;
    const issue = issueOption.value;
    // Re-check against current state: the item may have been queued before a
    // user canceled the issue, flagged it, or stopped the run.
    if (issue.status !== "in_review" || issue.needsAttentionAt != null) return;
    if (issue.reviewVerdict != null) return;
    // An explicit PR retry owns the review handoff even if the project run was
    // paused after the original failure.
    if (!(yield* issueIsAutonomouslyWorked(issue)) && issue.pullRequestUrl === null) return;

    const workerThread =
      issue.threadId === null
        ? Option.none()
        : yield* projectionSnapshotQuery.getThreadShellById(issue.threadId);
    if (Option.isNone(workerThread) || workerThread.value.worktreePath === null) {
      yield* flagNeedsAttention(
        issue.id,
        "The issue has no worktree to review, so it cannot be merged automatically.",
      );
      return;
    }

    // Size the review with a cheap classifier pass, then pick the reviewer's
    // model for that tier. Classification never fails — every failure mode is
    // the safe `complex` tier — so the only way not to review is still the
    // no-provider null below, exactly as before the tiers existed.
    const issueDetail = yield* projectionSnapshotQuery
      .getIssueDetailById(issue.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const complexityTier = yield* reviewComplexityClassifier.classify({
      issueTitle: issue.title,
      issueDescription: Option.isSome(issueDetail) ? issueDetail.value.description : "",
      worktreePath: workerThread.value.worktreePath,
      baseBranch: AUTONOMOUS_BASE_BRANCH,
    });
    const modelSelection = resolveTieredReviewerModelSelection(
      yield* providerRegistry.getProviders,
      complexityTier,
    );
    if (modelSelection === null) {
      yield* flagNeedsAttention(issue.id, "No Claude provider is available to review this issue.");
      return;
    }

    const reviewerThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
    const messageId = MessageId.make(yield* crypto.randomUUIDv4);
    const createdAt = yield* nowIso;

    // Claim the issue before the reviewer runs: this is what lets
    // turn-completion ingestion recognise the reviewer thread, and what stops a
    // second review after a restart.
    yield* orchestrationEngine
      .dispatch({
        type: "issue.review.start",
        commandId: yield* serverCommandId(`review-start:${issue.id}`),
        issueId: issue.id,
        reviewerThreadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));

    const completion = yield* Deferred.make<void>();
    pendingReviews.set(issue.id, completion);

    const started = yield* issueStartCoordinator
      .startIssueReview({
        issueId: issue.id,
        threadId: reviewerThreadId,
        messageId,
        modelSelection,
        runtimeMode: AUTONOMOUS_RUNTIME_MODE,
        interactionMode: AUTONOMOUS_INTERACTION_MODE,
        worktreePath: workerThread.value.worktreePath,
        branch: workerThread.value.branch,
        baseBranch: AUTONOMOUS_BASE_BRANCH,
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          flagNeedsAttention(issue.id, `Could not start the review: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      );

    if (!started) {
      pendingReviews.delete(issue.id);
      return;
    }

    yield* receipts.publish({
      type: "autonomous.review.started",
      issueId: issue.id,
      reviewerThreadId,
      complexityTier,
      modelSelection,
      createdAt,
    });

    // This is the serialization point: the queue holds here until the reviewer
    // reports a verdict, so the next issue rebases onto a main that already
    // contains this one.
    yield* Deferred.await(completion).pipe(
      Effect.ensuring(Effect.sync(() => pendingReviews.delete(issue.id))),
    );
  });

  const completePendingReview = (issueId: IssueId) =>
    Effect.suspend(() => {
      const pending = pendingReviews.get(issueId);
      return pending === undefined
        ? Effect.void
        : Deferred.succeed(pending, undefined).pipe(Effect.asVoid);
    });

  /**
   * A reviewer thread whose session died without reporting a verdict would
   * otherwise hold the merge queue forever. Record the failure as the verdict
   * so the queue advances and the issue is parked for a human.
   */
  const handleReviewerTurnEnd = Effect.fn("handleReviewerTurnEnd")(function* (
    threadId: ThreadId,
    sessionStatus: string,
  ) {
    if (sessionStatus !== "error") return;
    const issueOption = yield* projectionSnapshotQuery.getIssueByReviewerThreadId(threadId);
    if (Option.isNone(issueOption)) return;
    const issue = issueOption.value;
    if (issue.reviewVerdict != null) return;
    yield* orchestrationEngine
      .dispatch({
        type: "issue.review.record",
        commandId: yield* serverCommandId(`review-session-error:${issue.id}`),
        issueId: issue.id,
        reviewerThreadId: threadId,
        verdict: "needs_attention",
        notes: "The reviewer session ended in an error before it reported a verdict.",
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  // ------------------------------------------------------------------ queues

  const evaluateQueue = yield* makeDrainableWorker((item: EvaluateItem) =>
    evaluateProject(item.projectId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("autonomous run failed to evaluate a project", {
          projectId: item.projectId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const mergeQueue = yield* makeDrainableWorker((item: MergeItem) =>
    processMergeItem(item).pipe(
      Effect.ensuring(Effect.sync(() => queuedForMerge.delete(item.issueId))),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("autonomous run failed to review an issue", {
          issueId: item.issueId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  /**
   * The boards an event should re-evaluate.
   *
   * Usually one: the board the issue is on. An issue that moved is also worth
   * re-evaluating everywhere something *waits* on it, which since dependencies
   * may cross boards means other projects' runs — a story finishing here is
   * exactly what releases the story waiting for it over there, and nothing
   * else would wake that run before its next sweep.
   */
  const projectsForEvent = Effect.fn("projectsForEvent")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "project.autonomous-enabled":
        return [event.payload.projectId];
      case "issue.created":
        return [event.payload.projectId];
      case "issue.updated":
      case "issue.status-set":
      case "issue.deleted":
      case "issue.started":
      case "issue.start-failed":
      case "issue.attention-flagged":
      case "issue.attention-cleared":
      case "issue.review-recorded":
      case "issue.pull-request-linked": {
        const issueId = event.payload.issueId;
        const issues = yield* projectionSnapshotQuery
          .listIssues()
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<OrchestrationIssue>));
        const projectIds = new Set<ProjectId>();
        for (const issue of issues) {
          if (issue.id === issueId || issue.dependsOn.includes(issueId)) {
            projectIds.add(issue.projectId);
          }
        }
        return [...projectIds];
      }
      default:
        return [] as ReadonlyArray<ProjectId>;
    }
  });

  const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
    // A recorded verdict releases the merge queue before anything else, so the
    // next review starts even if the re-evaluation below fails.
    if (event.type === "issue.review-recorded") {
      yield* completePendingReview(event.payload.issueId);
    }
    if (event.type === "thread.session-set") {
      const status = event.payload.session.status;
      // A session parked on a provider limit has not finished its turn — the
      // server restarts it when the limit lifts. Treating that as a turn end
      // would park the issue for a human over a wait the run recovers from on
      // its own, which is the whole point of the park.
      if (isSessionParkedForResume(event.payload.session)) {
        return;
      }
      // Only a session that has left "running" marks the end of a turn.
      if (status !== "starting" && status !== "running") {
        yield* handleWorkerTurnEnd(event.payload.threadId, status);
        yield* handleReviewerTurnEnd(event.payload.threadId, status);
      }
      return;
    }
    if (event.type === "issue.attention-cleared") {
      yield* retryPullRequestAfterAttentionClear(event.payload.issueId);
    }
    for (const projectId of yield* projectsForEvent(event)) {
      yield* evaluateQueue.enqueue({ projectId });
    }
  });

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("autonomous run reactor failed to process an event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  /**
   * Anything the hot stream may have carried before the subscription went
   * live is re-derived from projected state: every project with an active run
   * gets one evaluation tick, and so does every project holding an unfinished
   * issue that was delegated in — that work has no run to be resumed by, and
   * dropping it on a restart would strand a delegated pull request forever.
   * The same sweep is what resumes runs across a server restart.
   */
  const sweepActiveRuns = Effect.fn("sweepActiveRuns")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const projectIds = new Set<ProjectId>();
    for (const project of snapshot.projects) {
      if (project.autonomousStartedAt == null) continue;
      projectIds.add(project.id);
    }
    for (const issue of activeAutonomousIssues(snapshot.issues)) {
      if (!isDelegatedIssue(issue)) continue;
      projectIds.add(issue.projectId);
    }
    for (const projectId of projectIds) {
      yield* evaluateQueue.enqueue({ projectId });
    }
  });

  const start: AutonomousRunReactorShape["start"] = Effect.fn("start")(function* () {
    // The subscription must be live when `start` returns (the domain stream is
    // hot), but reactors start before the activation boundary, so awaiting a
    // parked fiber's subscription would deadlock startup. Split the two: an
    // eager fiber only buffers events — not a side effect, and the command
    // gate is still closed pre-activation — while the consumer that acts on
    // them stays parked like every other orchestration root.
    const subscribed = yield* Deferred.make<void>();
    const buffered = yield* Queue.unbounded<OrchestrationEvent>();
    yield* Effect.forkScoped(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          Stream.onStart(Deferred.succeed(subscribed, undefined)),
        ),
        (event) => Queue.offer(buffered, event).pipe(Effect.asVoid),
      ),
    );
    yield* forkParked(
      sweepActiveRuns().pipe(
        Effect.andThen(
          Queue.take(buffered).pipe(Effect.flatMap(processEventSafely), Effect.forever),
        ),
      ),
    );
    yield* forkParked(
      Effect.sleep(EXTERNAL_MERGE_RECONCILE_INTERVAL).pipe(
        Effect.andThen(sweepActiveRuns()),
        Effect.repeat(Schedule.spaced(EXTERNAL_MERGE_RECONCILE_INTERVAL)),
        Effect.asVoid,
      ),
    );
    yield* Deferred.await(subscribed);
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* evaluateQueue.drain;
      yield* mergeQueue.drain;
    }),
  } satisfies AutonomousRunReactorShape;
});

export const AutonomousRunReactorLive = Layer.effect(AutonomousRunReactor, make);
