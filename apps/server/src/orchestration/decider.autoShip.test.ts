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
const ENABLED_AT = "1969-12-30T00:00:00.000Z";
const WORKTREE = "/tmp/worktrees/thread-1";

function makeReadModel(input: {
  readonly autoShipEnabledAt?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    issues: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/thread-1",
        worktreePath: input.worktreePath === undefined ? WORKTREE : input.worktreePath,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        autoShipEnabledAt: input.autoShipEnabledAt ?? null,
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

const setAutoShip = (enabled: boolean, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.auto-ship.set",
      commandId: CommandId.make(`cmd-auto-ship-${enabled ? "on" : "off"}`),
      threadId: ThreadId.make("thread-1"),
      enabled,
      createdAt: NOW,
    },
    readModel,
  });

it.layer(NodeServices.layer)("auto-ship decider", (it) => {
  it.effect("turning auto-ship on stamps enabledAt and updatedAt together", () =>
    Effect.gen(function* () {
      const event = yield* setAutoShip(true, makeReadModel({}));
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.auto-ship-set");
      if (events[0]?.type === "thread.auto-ship-set") {
        expect(events[0].payload.autoShipEnabledAt).toBe(events[0].payload.updatedAt);
      }
    }),
  );

  it.effect("re-enabling keeps the original enabledAt and does not churn updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* setAutoShip(true, makeReadModel({ autoShipEnabledAt: ENABLED_AT }));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.auto-ship-set") {
        expect(events[0].payload.autoShipEnabledAt).toBe(ENABLED_AT);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("turning auto-ship off clears enabledAt", () =>
    Effect.gen(function* () {
      const event = yield* setAutoShip(false, makeReadModel({ autoShipEnabledAt: ENABLED_AT }));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.auto-ship-set") {
        expect(events[0].payload.autoShipEnabledAt).toBeNull();
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("turning auto-ship off when it is already off preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* setAutoShip(false, makeReadModel({}));
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.auto-ship-set") {
        expect(events[0].payload.autoShipEnabledAt).toBeNull();
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("a thread with no worktree cannot be set to auto-ship", () =>
    Effect.gen(function* () {
      const failure = yield* setAutoShip(true, makeReadModel({ worktreePath: null })).pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("an archived thread cannot be set to auto-ship", () =>
    Effect.gen(function* () {
      const failure = yield* setAutoShip(true, makeReadModel({ archivedAt: NOW })).pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
