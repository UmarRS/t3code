import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const UI_PROJECT = ProjectId.make("project-ui");
const API_PROJECT = ProjectId.make("project-api");
const PARENT_THREAD = ThreadId.make("thread-parent");
const COMPANION_THREAD = ThreadId.make("thread-companion");

const invariantDetail = (error: { readonly _tag: string }): string => {
  expect(error._tag).toBe("OrchestrationCommandInvariantError");
  return (error as unknown as { readonly detail: string }).detail;
};

const thread = (
  id: ThreadId,
  projectId: ProjectId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
  ...overrides,
});

const readModel = (threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [UI_PROJECT, API_PROJECT].map((id) => ({
    id,
    title: id,
    workspaceRoot: `/repos/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  })),
  threads,
  issues: [],
  updatedAt: NOW,
});

const createCompanion = (input: {
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly parentThreadId?: ThreadId;
  readonly originLinkId?: string;
}) =>
  ({
    type: "thread.create",
    commandId: CommandId.make("cmd-create-companion"),
    threadId: input.threadId ?? COMPANION_THREAD,
    projectId: input.projectId ?? API_PROJECT,
    title: "Companion",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.originLinkId !== undefined ? { originLinkId: input.originLinkId } : {}),
    createdAt: NOW,
  }) satisfies Parameters<typeof decideOrchestrationCommand>[0]["command"];

it.layer(NodeServices.layer)("companion thread decider", (it) => {
  it.effect("carries the companion relation onto the created event", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: createCompanion({ parentThreadId: PARENT_THREAD, originLinkId: "link-1" }),
        readModel: readModel([thread(PARENT_THREAD, UI_PROJECT)]),
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event.type).toBe("thread.created");
      expect((event.payload as { parentThreadId: string }).parentThreadId).toBe(PARENT_THREAD);
      expect((event.payload as { originLinkId: string }).originLinkId).toBe("link-1");
    }),
  );

  it.effect("leaves an ordinary thread with no parent", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: createCompanion({ threadId: ThreadId.make("thread-plain") }),
        readModel: readModel([]),
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect((event.payload as { parentThreadId: string | null }).parentThreadId).toBeNull();
      expect((event.payload as { originLinkId: string | null }).originLinkId).toBeNull();
    }),
  );

  it.effect("rejects a parent that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCompanion({ parentThreadId: PARENT_THREAD }),
        readModel: readModel([]),
      }).pipe(Effect.flip);
      expect(invariantDetail(error)).toContain(PARENT_THREAD);
    }),
  );

  // One level deep: a companion that could delegate onward would fan out
  // without bound and produce a timeline no one can follow.
  it.effect("refuses to nest a companion under another companion", () =>
    Effect.gen(function* () {
      const existingCompanion = thread(ThreadId.make("thread-mid"), API_PROJECT, {
        parentThreadId: PARENT_THREAD,
      });
      const error = yield* decideOrchestrationCommand({
        command: createCompanion({
          projectId: UI_PROJECT,
          parentThreadId: existingCompanion.id,
        }),
        readModel: readModel([thread(PARENT_THREAD, UI_PROJECT), existingCompanion]),
      }).pipe(Effect.flip);
      expect(invariantDetail(error)).toContain("cannot own companions");
    }),
  );

  it.effect("refuses a companion in the parent's own project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCompanion({ projectId: UI_PROJECT, parentThreadId: PARENT_THREAD }),
        readModel: readModel([thread(PARENT_THREAD, UI_PROJECT)]),
      }).pipe(Effect.flip);
      expect(invariantDetail(error)).toContain("different project");
    }),
  );
});
