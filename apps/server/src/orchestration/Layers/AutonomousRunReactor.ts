import {
  activeAutonomousIssues,
  CommandId,
  isAutonomousRunComplete,
  IssueId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationIssue,
  type ProjectId,
  startableAutonomousIssues,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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

  const evaluateProject = Effect.fn("evaluateProject")(function* (projectId: ProjectId) {
    if (!(yield* projectRunIsLive(projectId))) return;

    const issues = yield* projectionSnapshotQuery.listIssuesByProjectId(projectId);
    const startable = startableAutonomousIssues(issues);
    const active = activeAutonomousIssues(issues);

    // Nothing to start and nothing moving: whatever is left is done, canceled,
    // or flagged, none of which the run can advance. Turn itself off so the UI
    // can show a finished run.
    if (isAutonomousRunComplete(issues)) {
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

    // Every issue about to run, plus everything already running, is context for
    // every worker: each one needs to know which neighbours it must not touch.
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

    // Issues whose worker is done and whose pull request is open, but that no
    // reviewer has claimed. Derived from state, so a restart re-queues them.
    for (const issue of issues) {
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
    if (!(yield* projectRunIsLive(issue.projectId))) return;

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
    // Session events are global. Ordinary threads should pay one narrow
    // project lookup, not a scan of every issue in their project, just to
    // discover that autonomous mode is not involved.
    if (!(yield* projectRunIsLive(thread.value.projectId))) {
      return Option.none<OrchestrationIssue>();
    }
    const issues = yield* projectionSnapshotQuery.listIssuesByProjectId(thread.value.projectId);
    const match = issues.find((issue) => issue.threadId === threadId);
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
   * A PR failure happens after the worker has already committed and pushed. A
   * user clearing that flag should retry only the idempotent PR workflow, not
   * discard the worker thread and ask an agent to implement the issue again.
   *
   * This intentionally works while the autonomous run is off: runs with only
   * flagged work finish themselves, but "Retry pull request" must still do
   * what it says. If the run is resumed, the linked PR proceeds to review.
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
    },
  );

  // --------------------------------------------------------------- reviewing

  const processMergeItem = Effect.fn("processMergeItem")(function* (item: MergeItem) {
    const issueOption = yield* projectionSnapshotQuery.getIssueSummaryById(item.issueId);
    if (Option.isNone(issueOption)) return;
    const issue = issueOption.value;
    // Re-check against current state: the item may have been queued before a
    // user canceled the issue, flagged it, or stopped the run.
    if (issue.status !== "in_review" || issue.needsAttentionAt != null) return;
    if (issue.reviewVerdict != null) return;
    if (!(yield* projectRunIsLive(issue.projectId))) return;

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
      baseBranch: "main",
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
        baseBranch: "main",
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

  /** The project an event should re-evaluate, if any. */
  const projectForEvent = Effect.fn("projectForEvent")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "project.autonomous-enabled":
        return Option.some(event.payload.projectId);
      case "issue.created":
        return Option.some(event.payload.projectId);
      case "issue.updated":
      case "issue.status-set":
      case "issue.deleted":
      case "issue.started":
      case "issue.start-failed":
      case "issue.attention-flagged":
      case "issue.attention-cleared":
      case "issue.review-recorded":
      case "issue.pull-request-linked": {
        const issue = yield* projectionSnapshotQuery
          .getIssueSummaryById(event.payload.issueId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationIssue>()));
        return Option.map(issue, (value) => value.projectId);
      }
      default:
        return Option.none<ProjectId>();
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
    const projectId = yield* projectForEvent(event);
    if (Option.isNone(projectId)) return;
    yield* evaluateQueue.enqueue({ projectId: projectId.value });
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
   * gets one evaluation tick. The same sweep is what resumes runs across a
   * server restart.
   */
  const sweepActiveRuns = Effect.fn("sweepActiveRuns")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    for (const project of snapshot.projects) {
      if (project.autonomousStartedAt == null) continue;
      yield* evaluateQueue.enqueue({ projectId: project.id });
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
