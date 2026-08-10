import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeReadModel(scope?: {
  readonly focusPath?: string | null;
  readonly linkedPaths?: ReadonlyArray<string>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Acme",
        workspaceRoot: "/repos/acme",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ...(scope?.focusPath !== undefined ? { focusPath: scope.focusPath } : {}),
        ...(scope?.linkedPaths !== undefined ? { linkedPaths: scope.linkedPaths } : {}),
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
      },
    ],
    updatedAt: NOW,
  };
}

const metaUpdate = (
  scope: { readonly focusPath?: string | null; readonly linkedPaths?: ReadonlyArray<string> },
  readModel: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-scope"),
      threadId: THREAD_ID,
      ...scope,
    },
    readModel,
  });

it.layer(NodeServices.layer)("thread scope decider", (it) => {
  it.effect("creates an unscoped thread when no scope is given", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create"),
          threadId: ThreadId.make("thread-2"),
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.focusPath).toBeNull();
        expect(events[0].payload.linkedPaths).toEqual([]);
      }
    }),
  );

  it.effect("creates a scoped thread, dropping a link that repeats the focus", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-scoped"),
          threadId: ThreadId.make("thread-3"),
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          focusPath: "apps/web",
          linkedPaths: ["apps/server", "apps/web"],
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.focusPath).toBe("apps/web");
        expect(events[0].payload.linkedPaths).toEqual(["apps/server"]);
      }
    }),
  );

  it.effect("leaves scope untouched when the update does not mention it", () =>
    Effect.gen(function* () {
      const event = yield* metaUpdate(
        {},
        makeReadModel({ focusPath: "apps/web", linkedPaths: ["apps/server"] }),
      );
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.focusPath).toBeUndefined();
        expect(events[0].payload.linkedPaths).toBeUndefined();
      }
    }),
  );

  it.effect("clears the focus with an explicit null", () =>
    Effect.gen(function* () {
      const event = yield* metaUpdate(
        { focusPath: null },
        makeReadModel({ focusPath: "apps/web", linkedPaths: ["apps/server"] }),
      );
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.focusPath).toBeNull();
        expect(events[0].payload.linkedPaths).toEqual(["apps/server"]);
      }
    }),
  );

  // Promoting a linked folder to focus must not leave it in both places.
  it.effect("drops the new focus from the existing links", () =>
    Effect.gen(function* () {
      const event = yield* metaUpdate(
        { focusPath: "apps/server" },
        makeReadModel({ focusPath: "apps/web", linkedPaths: ["apps/server", "packages/shared"] }),
      );
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.focusPath).toBe("apps/server");
        expect(events[0].payload.linkedPaths).toEqual(["packages/shared"]);
      }
    }),
  );

  it.effect("replaces the link list wholesale", () =>
    Effect.gen(function* () {
      const event = yield* metaUpdate(
        { linkedPaths: ["packages/contracts"] },
        makeReadModel({ focusPath: "apps/web", linkedPaths: ["apps/server"] }),
      );
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.linkedPaths).toEqual(["packages/contracts"]);
      }
    }),
  );
});
