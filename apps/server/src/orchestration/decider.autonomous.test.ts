import {
  CommandId,
  IssueId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationIssue,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const REVIEWER_THREAD_ID = ThreadId.make("reviewer-1");

const invariantDetail = (error: { readonly _tag: string }): string => {
  expect(error._tag).toBe("OrchestrationCommandInvariantError");
  return (error as unknown as { readonly detail: string }).detail;
};

const project = (overrides: Partial<OrchestrationProject> = {}): OrchestrationProject => ({
  id: PROJECT_ID,
  title: "Acme",
  workspaceRoot: "/repos/acme",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

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
  needsAttentionAt: null,
  needsAttentionReason: null,
  reviewVerdict: null,
  reviewerThreadId: null,
  reviewedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

function makeReadModel(input: {
  readonly projects?: ReadonlyArray<OrchestrationProject>;
  readonly issues?: ReadonlyArray<OrchestrationIssue>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: input.projects ?? [project()],
    issues: input.issues ?? [],
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

const decide = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  readModel: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("autonomous mode decider", (it) => {
  describe("project.autonomous.enable / disable", () => {
    it.effect("starts a run", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.enable",
            commandId: CommandId.make("cmd-enable"),
            projectId: PROJECT_ID,
            createdAt: NOW,
          },
          makeReadModel({}),
        );
        expect(events[0]?.type).toBe("project.autonomous-enabled");
        if (events[0]?.type === "project.autonomous-enabled") {
          expect(events[0].payload.autonomousStartedAt).not.toBe("");
          expect(events[0].aggregateKind).toBe("project");
        }
      }),
    );

    it.effect("keeps the original start time when a live run is re-enabled", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.enable",
            commandId: CommandId.make("cmd-enable"),
            projectId: PROJECT_ID,
            createdAt: NOW,
          },
          makeReadModel({ projects: [project({ autonomousStartedAt: NOW })] }),
        );
        if (events[0]?.type === "project.autonomous-enabled") {
          expect(events[0].payload.autonomousStartedAt).toBe(NOW);
          expect(events[0].payload.updatedAt).toBe(NOW);
        }
      }),
    );

    it.effect("records a user stop as disabled", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.disable",
            commandId: CommandId.make("cmd-disable"),
            projectId: PROJECT_ID,
            reason: "user",
          },
          makeReadModel({ projects: [project({ autonomousStartedAt: NOW })] }),
        );
        if (events[0]?.type === "project.autonomous-disabled") {
          expect(events[0].payload.reason).toBe("disabled");
        }
      }),
    );

    // The signal the UI reads to render a finished run rather than a stopped one.
    it.effect("records the server auto-stop as completed", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.disable",
            commandId: CommandId.make("cmd-disable"),
            projectId: PROJECT_ID,
            reason: "completed",
          },
          makeReadModel({ projects: [project({ autonomousStartedAt: NOW })] }),
        );
        if (events[0]?.type === "project.autonomous-disabled") {
          expect(events[0].payload.reason).toBe("completed");
        }
      }),
    );

    it.effect("rejects enabling a deleted project", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "project.autonomous.enable",
              commandId: CommandId.make("cmd-enable"),
              projectId: PROJECT_ID,
              createdAt: NOW,
            },
            makeReadModel({ projects: [project({ deletedAt: NOW })] }),
          ),
        );
        expect(invariantDetail(error)).toContain("deleted");
      }),
    );
  });

  describe("project.autonomous.schedule.set", () => {
    const morning = {
      id: "morning",
      time: "09:00",
      daysOfWeek: [1, 2, 3, 4, 5],
      enabled: true,
    } as const;

    it.effect("replaces the schedule wholesale", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.schedule.set",
            commandId: CommandId.make("cmd-schedule"),
            projectId: PROJECT_ID,
            schedule: [morning],
          },
          makeReadModel({
            projects: [
              project({
                autonomousSchedule: [
                  { id: "evening", time: "18:00", daysOfWeek: [], enabled: true },
                ],
              }),
            ],
          }),
        );
        expect(events[0]?.type).toBe("project.autonomous-schedule-set");
        if (events[0]?.type === "project.autonomous-schedule-set") {
          expect(events[0].payload.schedule).toEqual([morning]);
          expect(events[0].aggregateKind).toBe("project");
        }
      }),
    );

    it.effect("clears the schedule with an empty list", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "project.autonomous.schedule.set",
            commandId: CommandId.make("cmd-schedule"),
            projectId: PROJECT_ID,
            schedule: [],
          },
          makeReadModel({ projects: [project({ autonomousSchedule: [morning] })] }),
        );
        if (events[0]?.type === "project.autonomous-schedule-set") {
          expect(events[0].payload.schedule).toEqual([]);
        }
      }),
    );

    it.effect("rejects two entries sharing an id", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "project.autonomous.schedule.set",
              commandId: CommandId.make("cmd-schedule"),
              projectId: PROJECT_ID,
              schedule: [morning, { ...morning, time: "18:00" }],
            },
            makeReadModel({}),
          ),
        );
        expect(invariantDetail(error)).toContain("more than once");
      }),
    );

    it.effect("rejects scheduling a deleted project", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "project.autonomous.schedule.set",
              commandId: CommandId.make("cmd-schedule"),
              projectId: PROJECT_ID,
              schedule: [morning],
            },
            makeReadModel({ projects: [project({ deletedAt: NOW })] }),
          ),
        );
        expect(invariantDetail(error)).toContain("deleted");
      }),
    );
  });

  describe("needs attention", () => {
    it.effect("flags an issue with its reason", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.attention.flag",
            commandId: CommandId.make("cmd-flag"),
            issueId: IssueId.make("issue-a"),
            reason: "Push was rejected.",
          },
          makeReadModel({ issues: [issue("issue-a", { status: "in_progress" })] }),
        );
        if (events[0]?.type === "issue.attention-flagged") {
          expect(events[0].payload.reason).toBe("Push was rejected.");
          // The flag does not change the status: it sits beside it.
          expect(events[0].payload).not.toHaveProperty("status");
        }
      }),
    );

    it.effect("keeps the first failure when re-flagged", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.attention.flag",
            commandId: CommandId.make("cmd-flag"),
            issueId: IssueId.make("issue-a"),
            reason: "Second failure.",
          },
          makeReadModel({
            issues: [
              issue("issue-a", {
                needsAttentionAt: NOW,
                needsAttentionReason: "First failure.",
              }),
            ],
          }),
        );
        if (events[0]?.type === "issue.attention-flagged") {
          expect(events[0].payload.reason).toBe("First failure.");
          expect(events[0].payload.needsAttentionAt).toBe(NOW);
        }
      }),
    );

    it.effect("clears the flag so the issue can run again", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.attention.clear",
            commandId: CommandId.make("cmd-clear"),
            issueId: IssueId.make("issue-a"),
          },
          makeReadModel({ issues: [issue("issue-a", { needsAttentionAt: NOW })] }),
        );
        expect(events[0]?.type).toBe("issue.attention-cleared");
      }),
    );

    it.effect("projects a redundant clear as a no-op", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.attention.clear",
            commandId: CommandId.make("cmd-clear"),
            issueId: IssueId.make("issue-a"),
          },
          makeReadModel({ issues: [issue("issue-a")] }),
        );
        if (events[0]?.type === "issue.attention-cleared") {
          expect(events[0].payload.updatedAt).toBe(NOW);
        }
      }),
    );

    it.effect("refuses to start a flagged issue", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.start",
              commandId: CommandId.make("cmd-start"),
              issueId: IssueId.make("issue-a"),
              threadId: ThreadId.make("thread-new"),
              messageId: MessageId.make("message-new"),
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: NOW,
            },
            makeReadModel({ issues: [issue("issue-a", { needsAttentionAt: NOW })] }),
          ),
        );
        expect(invariantDetail(error)).toContain("needs attention");
      }),
    );
  });

  describe("issue.review.start / record", () => {
    it.effect("claims the issue for a reviewer thread", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.review.start",
            commandId: CommandId.make("cmd-review-start"),
            issueId: IssueId.make("issue-a"),
            reviewerThreadId: REVIEWER_THREAD_ID,
          },
          makeReadModel({ issues: [issue("issue-a", { status: "in_review" })] }),
        );
        if (events[0]?.type === "issue.review-started") {
          expect(events[0].payload.reviewerThreadId).toBe(REVIEWER_THREAD_ID);
        }
      }),
    );

    it.effect("a merged verdict finishes the issue", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.review.record",
            commandId: CommandId.make("cmd-review"),
            issueId: IssueId.make("issue-a"),
            reviewerThreadId: REVIEWER_THREAD_ID,
            verdict: "merged",
            notes: "Ran the tests, fixed a typo, merged.",
          },
          makeReadModel({
            issues: [
              issue("issue-a", {
                status: "in_review",
                pullRequestUrl: "https://example.test/pr/1",
              }),
            ],
          }),
        );
        expect(events).toHaveLength(1);
        if (events[0]?.type === "issue.review-recorded") {
          expect(events[0].payload.status).toBe("done");
          expect(events[0].payload.notes).toContain("fixed a typo");
          // The record stands alone: the URL is copied onto the event.
          expect(events[0].payload.pullRequestUrl).toBe("https://example.test/pr/1");
        }
      }),
    );

    // Unmerged work must not silently look finished, and must not be picked up
    // again by the run — so the verdict also parks it.
    it.effect("a needs_attention verdict records notes and flags the issue", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.review.record",
            commandId: CommandId.make("cmd-review"),
            issueId: IssueId.make("issue-a"),
            reviewerThreadId: REVIEWER_THREAD_ID,
            verdict: "needs_attention",
            notes: "The migration drops a column.",
          },
          makeReadModel({ issues: [issue("issue-a", { status: "in_review" })] }),
        );
        expect(events.map((event) => event.type)).toEqual([
          "issue.review-recorded",
          "issue.attention-flagged",
        ]);
        if (events[0]?.type === "issue.review-recorded") {
          expect(events[0].payload.status).toBeUndefined();
        }
      }),
    );

    it.effect("a later merged verdict replaces provisional review attention", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          {
            type: "issue.review.record",
            commandId: CommandId.make("cmd-review-final"),
            issueId: IssueId.make("issue-a"),
            reviewerThreadId: REVIEWER_THREAD_ID,
            verdict: "merged",
            notes: "The final reviewer turn merged the pull request.",
          },
          makeReadModel({
            issues: [
              issue("issue-a", {
                status: "in_review",
                reviewVerdict: "needs_attention",
                needsAttentionAt: NOW,
                needsAttentionReason: "The interim turn did not include a review verdict.",
              }),
            ],
          }),
        );

        expect(events.map((event) => event.type)).toEqual([
          "issue.review-recorded",
          "issue.attention-cleared",
        ]);
        if (events[0]?.type === "issue.review-recorded") {
          expect(events[0].payload.verdict).toBe("merged");
          expect(events[0].payload.status).toBe("done");
        }
      }),
    );

    it.effect("rejects recording a review for an unknown issue", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decide(
            {
              type: "issue.review.record",
              commandId: CommandId.make("cmd-review"),
              issueId: IssueId.make("missing"),
              reviewerThreadId: REVIEWER_THREAD_ID,
              verdict: "merged",
              notes: "n/a",
            },
            makeReadModel({}),
          ),
        );
        expect(invariantDetail(error)).toContain("does not exist");
      }),
    );
  });
});
