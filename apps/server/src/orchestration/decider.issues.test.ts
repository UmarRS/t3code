import {
  CommandId,
  IssueId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueStatus,
  type OrchestrationIssue,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const THREAD_ID = ThreadId.make("thread-1");

const issue = (id: string, overrides: Partial<OrchestrationIssue> = {}): OrchestrationIssue => ({
  id: IssueId.make(id),
  projectId: PROJECT_ID,
  title: `Issue ${id}`,
  status: "backlog",
  priority: null,
  modelSelection: null,
  dependsOn: [],
  threadId: null,
  pullRequestUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

function makeReadModel(issues: ReadonlyArray<OrchestrationIssue>): OrchestrationReadModel {
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
      {
        id: OTHER_PROJECT_ID,
        title: "Other",
        workspaceRoot: "/repos/other",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    issues,
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

/** Narrow the decider's error union to the invariant failure a test asserts on. */
const invariantDetail = (error: { readonly _tag: string }): string => {
  expect(error._tag).toBe("OrchestrationCommandInvariantError");
  return (error as unknown as { readonly detail: string }).detail;
};

const decide = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  readModel: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const startCommand = (issueId: string) =>
  ({
    type: "issue.start",
    commandId: CommandId.make(`cmd-start-${issueId}`),
    issueId: IssueId.make(issueId),
    threadId: ThreadId.make("thread-new"),
    messageId: MessageId.make("message-new"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("issue decider", (it) => {
  describe("issue.create", () => {
    it.effect("creates a backlog issue with no dependencies", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.create",
            commandId: CommandId.make("cmd-create"),
            issueId: IssueId.make("issue-1"),
            projectId: PROJECT_ID,
            title: "Ship the thing",
            description: "# Body",
            createdAt: NOW,
          },
          makeReadModel([]),
        );
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("issue.created");
        if (events[0]?.type === "issue.created") {
          expect(events[0].payload.status).toBe("backlog");
          expect(events[0].payload.priority).toBeNull();
          expect(events[0].payload.dependsOn).toEqual([]);
          expect(events[0].aggregateKind).toBe("issue");
        }
      }),
    );

    it.effect("rejects a dependency from another project", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.create",
              commandId: CommandId.make("cmd-create"),
              issueId: IssueId.make("issue-2"),
              projectId: PROJECT_ID,
              title: "Ship the thing",
              dependsOn: [IssueId.make("issue-foreign")],
              createdAt: NOW,
            },
            makeReadModel([issue("issue-foreign", { projectId: OTHER_PROJECT_ID })]),
          ),
        );
        expect(invariantDetail(error)).toContain("is not an issue in project");
      }),
    );

    it.effect("rejects self-dependency", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.create",
              commandId: CommandId.make("cmd-create"),
              issueId: IssueId.make("issue-1"),
              projectId: PROJECT_ID,
              title: "Ship the thing",
              dependsOn: [IssueId.make("issue-1")],
              createdAt: NOW,
            },
            makeReadModel([]),
          ),
        );
        expect(invariantDetail(error)).toContain("cannot depend on itself");
      }),
    );
  });

  describe("issue.update", () => {
    it.effect("rejects a dependency edit that would close a cycle", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.update",
              commandId: CommandId.make("cmd-update"),
              issueId: IssueId.make("issue-a"),
              dependsOn: [IssueId.make("issue-b")],
            },
            makeReadModel([
              issue("issue-a"),
              issue("issue-b", { dependsOn: [IssueId.make("issue-a")] }),
            ]),
          ),
        );
        expect(invariantDetail(error)).toContain("cycle");
      }),
    );

    it.effect("allows breaking a cycle by replacing the dependency list", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.update",
            commandId: CommandId.make("cmd-update"),
            issueId: IssueId.make("issue-b"),
            dependsOn: [],
          },
          makeReadModel([
            issue("issue-a", { dependsOn: [IssueId.make("issue-b")] }),
            issue("issue-b", { dependsOn: [IssueId.make("issue-a")] }),
          ]),
        );
        expect(events[0]?.type).toBe("issue.updated");
      }),
    );

    it.effect("unlinks a thread but refuses to link one", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel([issue("issue-a", { threadId: THREAD_ID })]);
        const events = yield* decide(
          {
            type: "issue.update",
            commandId: CommandId.make("cmd-unlink"),
            issueId: IssueId.make("issue-a"),
            threadId: null,
          },
          readModel,
        );
        if (events[0]?.type === "issue.updated") {
          expect(events[0].payload.threadId).toBeNull();
        }

        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.update",
              commandId: CommandId.make("cmd-link"),
              issueId: IssueId.make("issue-a"),
              threadId: THREAD_ID,
            },
            readModel,
          ),
        );
        expect(invariantDetail(error)).toContain("issue.start");
      }),
    );
  });

  describe("issue.status.set", () => {
    // Reverse states are the point: a "done" issue that turned out to be
    // unfinished has to be able to go back.
    it.effect("moves done back to backlog", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.status.set",
            commandId: CommandId.make("cmd-status"),
            issueId: IssueId.make("issue-a"),
            status: "backlog",
          },
          makeReadModel([issue("issue-a", { status: "done" })]),
        );
        if (events[0]?.type === "issue.status-set") {
          expect(events[0].payload.status).toBe("backlog");
          expect(events[0].payload.updatedAt).not.toBe(NOW);
        }
      }),
    );

    it.effect("projects a repeated status as a no-op", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.status.set",
            commandId: CommandId.make("cmd-status"),
            issueId: IssueId.make("issue-a"),
            status: "done",
          },
          makeReadModel([issue("issue-a", { status: "done" })]),
        );
        if (events[0]?.type === "issue.status-set") {
          expect(events[0].payload.updatedAt).toBe(NOW);
        }
      }),
    );
  });

  describe("issue.delete", () => {
    it.effect("removes the deleted issue from its dependents", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.delete",
            commandId: CommandId.make("cmd-delete"),
            issueId: IssueId.make("issue-a"),
          },
          makeReadModel([
            issue("issue-a"),
            issue("issue-b", { dependsOn: [IssueId.make("issue-a")] }),
            issue("issue-c"),
          ]),
        );
        expect(events.map((event) => event.type)).toEqual(["issue.deleted", "issue.updated"]);
        if (events[1]?.type === "issue.updated") {
          expect(events[1].payload.issueId).toBe(IssueId.make("issue-b"));
          expect(events[1].payload.dependsOn).toEqual([]);
        }
      }),
    );
  });

  describe("issue.start", () => {
    it.effect("starts an issue whose dependencies are all done", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          startCommand("issue-b"),
          makeReadModel([
            issue("issue-a", { status: "done" }),
            issue("issue-b", { dependsOn: [IssueId.make("issue-a")] }),
          ]),
        );
        expect(events[0]?.type).toBe("issue.started");
        if (events[0]?.type === "issue.started") {
          expect(events[0].payload.status).toBe("in_progress");
          expect(events[0].payload.threadId).toBe(ThreadId.make("thread-new"));
        }
      }),
    );

    for (const blockingStatus of ["backlog", "in_progress", "in_review", "canceled"] as const) {
      it.effect(`rejects a start blocked by a ${blockingStatus} dependency`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            decide(
              startCommand("issue-b"),
              makeReadModel([
                issue("issue-a", { status: blockingStatus satisfies IssueStatus }),
                issue("issue-b", { dependsOn: [IssueId.make("issue-a")] }),
              ]),
            ),
          );
          expect(invariantDetail(error)).toContain("blocked by unfinished");
          expect(invariantDetail(error)).toContain("issue-a");
        }),
      );
    }

    it.effect("rejects starting an issue that already has a thread", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            startCommand("issue-a"),
            makeReadModel([issue("issue-a", { threadId: THREAD_ID })]),
          ),
        );
        expect(invariantDetail(error)).toContain("already linked");
      }),
    );

    // A deleted blocker is how a user clears a dependency they no longer want.
    it.effect("ignores a dependency whose issue no longer exists", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          startCommand("issue-b"),
          makeReadModel([issue("issue-b", { dependsOn: [IssueId.make("issue-gone")] })]),
        );
        expect(events[0]?.type).toBe("issue.started");
      }),
    );
  });

  describe("issue.pull-request.link", () => {
    it.effect("moves the linked issue to review", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.pull-request.link",
            commandId: CommandId.make("cmd-pr"),
            threadId: THREAD_ID,
            pullRequestUrl: "https://example.test/pr/1",
          },
          makeReadModel([issue("issue-a", { threadId: THREAD_ID, status: "in_progress" })]),
        );
        expect(events[0]?.type).toBe("issue.pull-request-linked");
        if (events[0]?.type === "issue.pull-request-linked") {
          expect(events[0].payload.status).toBe("in_review");
          expect(events[0].payload.pullRequestUrl).toBe("https://example.test/pr/1");
        }
      }),
    );

    it.effect("records the url without dragging a done issue backwards", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.pull-request.link",
            commandId: CommandId.make("cmd-pr"),
            threadId: THREAD_ID,
          },
          makeReadModel([issue("issue-a", { threadId: THREAD_ID, status: "done" })]),
        );
        if (events[0]?.type === "issue.pull-request-linked") {
          expect(events[0].payload.status).toBeUndefined();
        }
      }),
    );

    it.effect("rejects a thread with no linked issue", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.pull-request.link",
              commandId: CommandId.make("cmd-pr"),
              threadId: THREAD_ID,
            },
            makeReadModel([issue("issue-a")]),
          ),
        );
        expect(invariantDetail(error)).toContain("not linked to an issue");
      }),
    );
  });

  describe("project.delete", () => {
    it.effect("sweeps the project backlog before deleting the project", () =>
      Effect.gen(function* () {
        const readModel = makeReadModel([issue("issue-a"), issue("issue-b")]);
        const events = yield* decide(
          {
            type: "project.delete",
            commandId: CommandId.make("cmd-project-delete"),
            projectId: PROJECT_ID,
            force: true,
          },
          {
            ...readModel,
            // Keep threads out of it so the assertion is about issues only.
            threads: [],
          },
        );
        expect(events.map((event) => event.type)).toEqual([
          "issue.deleted",
          "issue.deleted",
          "project.deleted",
        ]);
      }),
    );
  });
});
