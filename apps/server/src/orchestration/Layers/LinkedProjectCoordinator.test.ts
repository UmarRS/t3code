import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProjectLinkView } from "@t3tools/shared/projectLinks";

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

/** Records every command the coordinator dispatches, so a test can assert on them. */
const makeLayer = (input: {
  readonly links: ReadonlyArray<ProjectLinkView>;
  readonly companion?: ThreadId | undefined;
  readonly dispatched: Array<Record<string, unknown>>;
}) =>
  LinkedProjectCoordinatorLive.pipe(
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getProjectLinksById: () => Effect.succeed(input.links),
        getProjectShellById: (projectId: ProjectId) =>
          Effect.succeed(
            projectId === API_PROJECT
              ? Option.some(projectShell(API_PROJECT, API_ROOT, "orgalign-ui"))
              : Option.none(),
          ),
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
        listIssuesByProjectId: () => Effect.die("unused"),
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
