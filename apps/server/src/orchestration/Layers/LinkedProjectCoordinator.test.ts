import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  IssueId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationIssue,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProjectLinkView } from "@t3tools/shared/projectLinks";

import {
  IssueStartCoordinator,
  type IssueStartCommand,
} from "../Services/IssueStartCoordinator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { LinkedProjectCoordinator } from "../Services/LinkedProjectCoordinator.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { LinkedProjectCoordinatorLive } from "./LinkedProjectCoordinator.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const UI_PROJECT = ProjectId.make("project-ui");
const API_PROJECT = ProjectId.make("project-api");
const UI_ROOT = "/repos/orgalign";
const API_ROOT = "/repos/orgalign-ui";
const PARENT_THREAD = ThreadId.make("thread-parent");

const parentThread: OrchestrationThread = {
  id: PARENT_THREAD,
  projectId: UI_PROJECT,
  title: "Saved views",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus-5",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const linkView = (input: {
  readonly path: string;
  readonly targetProjectId: ProjectId | null;
}): ProjectLinkView => ({
  link: { id: "link-1", path: input.path, description: "the API", createdAt: NOW },
  ownerProjectId: UI_PROJECT,
  path: input.path,
  description: "the API",
  targetProjectId: input.targetProjectId,
  mirrored: false,
});

const projectShell = (id: ProjectId, workspaceRoot: string, title: string) => ({
  id,
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

/**
 * An issue on the parent's board that the parent thread is working. Present
 * only in the scenarios that exercise delegation from an autonomous worker.
 */
const workerIssue = (input: {
  readonly threadId: ThreadId;
  readonly delegatedFromThreadId?: ThreadId | undefined;
}): OrchestrationIssue => ({
  id: IssueId.make("issue-parent"),
  projectId: UI_PROJECT,
  title: "Saved views",
  status: "in_progress",
  priority: null,
  modelSelection: null,
  dependsOn: [],
  threadId: input.threadId,
  pullRequestUrl: null,
  needsAttentionAt: null,
  needsAttentionReason: null,
  reviewVerdict: null,
  reviewerThreadId: null,
  reviewedAt: null,
  delegatedFromThreadId: input.delegatedFromThreadId ?? null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

/** Records every command the coordinator dispatches, so a test can assert on them. */
const makeLayer = (input: {
  readonly links: ReadonlyArray<ProjectLinkView>;
  readonly companion?: ThreadId | undefined;
  readonly dispatched: Array<Record<string, unknown>>;
  /** Non-null makes the parent project a live autonomous run. */
  readonly parentAutonomousStartedAt?: string | undefined;
  /** The parent project's backlog, for detecting an autonomous worker. */
  readonly parentIssues?: ReadonlyArray<OrchestrationIssue> | undefined;
  /** The model the target project prefers for its own work, if it has one. */
  readonly targetDefaultModelSelection?: ModelSelection | undefined;
  readonly startedIssues?: Array<IssueStartCommand> | undefined;
  readonly startIssueFails?: boolean | undefined;
}) =>
  LinkedProjectCoordinatorLive.pipe(
    Layer.provide(
      Layer.succeed(IssueStartCoordinator, {
        startIssue: (command: IssueStartCommand) =>
          input.startIssueFails === true
            ? Effect.fail(
                new OrchestrationDispatchCommandError({ message: "the worktree is wedged" }),
              )
            : Effect.sync(() => {
                input.startedIssues?.push(command);
                return { sequence: 1 };
              }),
        startIssueReview: () => Effect.die("unused"),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getProjectLinksById: () => Effect.succeed(input.links),
        getProjectShellById: (projectId: ProjectId) =>
          Effect.succeed(
            projectId === API_PROJECT
              ? Option.some({
                  ...projectShell(API_PROJECT, API_ROOT, "orgalign-ui"),
                  defaultModelSelection: input.targetDefaultModelSelection ?? null,
                })
              : Option.some({
                  ...projectShell(UI_PROJECT, UI_ROOT, "orgalign"),
                  autonomousStartedAt: input.parentAutonomousStartedAt ?? null,
                }),
          ),
        listIssuesByProjectId: () => Effect.succeed(input.parentIssues ?? []),
        // Any thread that is not the parent reads back as its companion: the
        // real create dispatch projects the row before the coordinator reads
        // it, which a pure stub cannot reproduce.
        getThreadDetailById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some(
              threadId === PARENT_THREAD
                ? parentThread
                : {
                    ...parentThread,
                    id: threadId,
                    projectId: API_PROJECT,
                    parentThreadId: PARENT_THREAD,
                  },
            ),
          ),
        getCompanionThreadId: () =>
          Effect.succeed(input.companion ? Option.some(input.companion) : Option.none()),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
        listScheduledProjects: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.die("unused"),
        getIssueSummaryById: () => Effect.die("unused"),
        getIssueDetailById: () => Effect.die("unused"),
        getIssueByReviewerThreadId: () => Effect.die("unused"),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: { readonly type: string }) =>
          Effect.sync(() => {
            input.dispatched.push(command as never);
            return { sequence: input.dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
        getCommandReadModelSequence: Effect.succeed(0),
      } as never),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("LinkedProjectCoordinator", () => {
  it.effect("reports a registered link as routable and a plain folder as not", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [
            linkView({ path: API_ROOT, targetProjectId: API_PROJECT }),
            linkView({ path: "/repos/notes", targetProjectId: null }),
          ],
          dispatched,
        }),
      );

      const links = yield* coordinator.listLinksForThread(PARENT_THREAD);
      expect(links).toHaveLength(2);
      expect(links[0]).toMatchObject({ path: API_ROOT, title: "orgalign-ui", routable: true });
      // A context-only folder has no project to take a title from.
      expect(links[1]).toMatchObject({
        path: "/repos/notes",
        title: "/repos/notes",
        routable: false,
      });
    }),
  );

  it.effect("resolves a routable target by workspace root and refuses the rest", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [
            linkView({ path: API_ROOT, targetProjectId: API_PROJECT }),
            linkView({ path: "/repos/notes", targetProjectId: null }),
          ],
          dispatched,
        }),
      );

      const hit = yield* coordinator.resolveTarget({
        parentThreadId: PARENT_THREAD,
        path: API_ROOT,
      });
      expect(Option.isSome(hit)).toBe(true);

      // Context-only and unknown paths are both "cannot take work".
      for (const path of ["/repos/notes", UI_ROOT, "/repos/nope"]) {
        const miss = yield* coordinator.resolveTarget({ parentThreadId: PARENT_THREAD, path });
        expect(Option.isNone(miss)).toBe(true);
      }
    }),
  );

  it.live("creates a companion carrying the parent's full model selection", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [linkView({ path: API_ROOT, targetProjectId: API_PROJECT })],
          dispatched,
        }),
      );

      // The turn never settles here (the event stream is empty), so the wait
      // times out and reports the companion as still working.
      const result = yield* coordinator.delegate({
        parentThreadId: PARENT_THREAD,
        targetProjectId: API_PROJECT,
        task: "add GET/POST /saved-views",
        timeoutMillis: 1,
      });
      expect(result.status).toBe("timed-out");

      const create = dispatched.find((command) => command.type === "thread.create");
      expect(create).toBeDefined();
      expect(create?.parentThreadId).toBe(PARENT_THREAD);
      expect(create?.projectId).toBe(API_PROJECT);
      // Instance and options must survive: the live session model is a bare
      // provider string and would silently drop both.
      expect(create?.modelSelection).toEqual(parentThread.modelSelection);
      expect(create?.runtimeMode).toBe("full-access");

      // The task is a real user message so a failover can replay it.
      const turn = dispatched.find((command) => command.type === "thread.turn.start");
      expect((turn?.message as { text: string } | undefined)?.text).toBe(
        "add GET/POST /saved-views",
      );
      expect((turn?.message as { role: string } | undefined)?.role).toBe("user");
    }),
  );

  it.live("reuses the parent's existing companion instead of opening a second", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const existing = ThreadId.make("thread-companion-existing");
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [linkView({ path: API_ROOT, targetProjectId: API_PROJECT })],
          companion: existing,
          dispatched,
        }),
      );

      const result = yield* coordinator.delegate({
        parentThreadId: PARENT_THREAD,
        targetProjectId: API_PROJECT,
        task: "second task",
        timeoutMillis: 1,
      });

      expect(result.companionThreadId).toBe(existing);
      expect(dispatched.some((command) => command.type === "thread.create")).toBe(false);
      // The turn still goes to the existing companion.
      expect(dispatched.some((command) => command.type === "thread.turn.start")).toBe(true);
    }),
  );

  it.effect("files an autonomous worker's task on the target board and returns at once", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const startedIssues: Array<IssueStartCommand> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [linkView({ path: API_ROOT, targetProjectId: API_PROJECT })],
          dispatched,
          parentAutonomousStartedAt: NOW,
          parentIssues: [workerIssue({ threadId: PARENT_THREAD })],
          targetDefaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          startedIssues,
        }),
      );

      // No timeout is passed and none is needed: the call must not wait for the
      // delegated work, which is what makes this usable from an agent's turn.
      const result = yield* coordinator.delegate({
        parentThreadId: PARENT_THREAD,
        targetProjectId: API_PROJECT,
        task: "Add GET/POST /saved-views\n\nMatch the shape the UI already sends.",
      });

      expect(result.status).toBe("queued");
      expect(result.issueId).toBeDefined();
      expect(result.targetWorkspaceRoot).toBe(API_ROOT);

      // The task landed on the target project's board, tagged with the thread
      // that delegated it — the mark the run reactor reads to carry it through
      // pull request, review and merge without a run of its own.
      const created = dispatched.find((command) => command.type === "issue.create");
      expect(created).toMatchObject({
        projectId: API_PROJECT,
        title: "Add GET/POST /saved-views",
        description: "Add GET/POST /saved-views\n\nMatch the shape the UI already sends.",
        delegatedFromThreadId: PARENT_THREAD,
      });

      // Started immediately, on the target project's own default model, in the
      // modes autonomous work forces.
      expect(startedIssues).toHaveLength(1);
      expect(startedIssues[0]?.issueId).toBe(created?.issueId);
      expect(startedIssues[0]?.threadId).toBe(result.companionThreadId);
      expect(startedIssues[0]?.modelSelection.model).toBe("gpt-5.6");
      expect(startedIssues[0]?.runtimeMode).toBe("full-access");
      expect(startedIssues[0]?.startFromOrigin).toBe(true);

      // No companion thread anywhere: an untracked agent in the other
      // repository is exactly what this path exists to avoid.
      expect(dispatched.some((command) => command.type === "thread.create")).toBe(false);
      const activity = dispatched.find((command) => command.type === "thread.activity.append");
      expect(activity).toBeDefined();
      expect(
        (activity?.activity as { payload: { status: string } } | undefined)?.payload.status,
      ).toBe("queued");
    }),
  );

  it.effect("flags the issue it filed when the delegated work cannot be started", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [linkView({ path: API_ROOT, targetProjectId: API_PROJECT })],
          dispatched,
          parentAutonomousStartedAt: NOW,
          parentIssues: [workerIssue({ threadId: PARENT_THREAD })],
          startIssueFails: true,
        }),
      );

      const result = yield* coordinator.delegate({
        parentThreadId: PARENT_THREAD,
        targetProjectId: API_PROJECT,
        task: "Add GET/POST /saved-views",
      });

      expect(result.status).toBe("failed");
      // A filed issue nobody is working has to say so on its own board.
      const flagged = dispatched.find((command) => command.type === "issue.attention.flag");
      expect(flagged?.issueId).toBe(result.issueId);
      expect(String(flagged?.reason)).toContain("the worktree is wedged");
    }),
  );

  it.live("still opens a companion for a thread that is not doing an issue", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const startedIssues: Array<IssueStartCommand> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({
          links: [linkView({ path: API_ROOT, targetProjectId: API_PROJECT })],
          dispatched,
          // A live run on the project is not enough on its own: this thread is
          // somebody talking to an agent, not a worker on an issue.
          parentAutonomousStartedAt: NOW,
          parentIssues: [workerIssue({ threadId: ThreadId.make("thread-other-worker") })],
          startedIssues,
        }),
      );

      const result = yield* coordinator.delegate({
        parentThreadId: PARENT_THREAD,
        targetProjectId: API_PROJECT,
        task: "add GET/POST /saved-views",
        timeoutMillis: 1,
      });

      expect(result.status).toBe("timed-out");
      expect(startedIssues).toEqual([]);
      expect(dispatched.some((command) => command.type === "issue.create")).toBe(false);
      expect(dispatched.some((command) => command.type === "thread.create")).toBe(true);
    }),
  );

  it.effect("refuses a project that is not a routable link of the parent", () =>
    Effect.gen(function* () {
      const dispatched: Array<Record<string, unknown>> = [];
      const coordinator = yield* Effect.provide(
        LinkedProjectCoordinator,
        makeLayer({ links: [linkView({ path: API_ROOT, targetProjectId: null })], dispatched }),
      );

      const error = yield* coordinator
        .delegate({
          parentThreadId: PARENT_THREAD,
          targetProjectId: API_PROJECT,
          task: "nope",
          timeoutMillis: 1,
        })
        .pipe(Effect.flip);
      expect(String((error as { message?: string }).message)).toContain("not a routable");
      expect(dispatched).toHaveLength(0);
    }),
  );
});
