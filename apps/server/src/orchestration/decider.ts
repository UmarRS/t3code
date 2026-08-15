import {
  DEFAULT_ISSUE_STATUS,
  EventId,
  issueNeedsAttention,
  normalizeThreadScopeLinkedPaths,
  PROJECT_LINK_MAX_PER_PROJECT,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { projectsAreLinked } from "@t3tools/shared/projectLinks";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  findActiveIssueByThreadId,
  findProjectLinkOwner,
  listActiveIssuesByProjectId,
  listActiveProjects,
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireIssue,
  requireIssueAbsent,
  requireIssueDependenciesSatisfied,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireValidIssueDependencies,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      // A project's backlog goes with it. Issues never block the delete the way
      // threads do — a backlog is planning, not work in flight — so they are
      // swept regardless of `force`.
      const activeIssues = listActiveIssuesByProjectId(readModel, command.projectId);
      if (activeThreads.length > 0 || activeIssues.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeIssues.map(
              (issue): Extract<OrchestrationCommand, { type: "issue.delete" }> => ({
                type: "issue.delete",
                commandId: command.commandId,
                issueId: issue.id,
              }),
            ),
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "project.link.add": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (project.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is deleted and cannot be linked.`,
        });
      }

      const activeProjects = listActiveProjects(readModel);
      const links = project.links ?? [];
      if (links.length >= PROJECT_LINK_MAX_PER_PROJECT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' already has the maximum of ${PROJECT_LINK_MAX_PER_PROJECT} links.`,
        });
      }
      if (findProjectLinkOwner(activeProjects, command.linkId) !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project link '${command.linkId}' already exists.`,
        });
      }

      const normalizedPath = normalizeProjectPathForComparison(command.path);
      if (normalizedPath === normalizeProjectPathForComparison(project.workspaceRoot)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' cannot link its own workspace root.`,
        });
      }
      if (links.some((link) => normalizeProjectPathForComparison(link.path) === normalizedPath)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is already linked to '${command.path}'.`,
        });
      }
      // A pair of registered projects gets exactly one edge. Without this, the
      // link the user is adding would collide with the mirror they can already
      // see, and removing one would leave the other behind.
      const targetProject = activeProjects.find(
        (candidate) =>
          normalizeProjectPathForComparison(candidate.workspaceRoot) === normalizedPath,
      );
      if (targetProject !== undefined && projectsAreLinked(project, targetProject)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' and project '${targetProject.id}' are already linked.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.link-added",
        payload: {
          projectId: command.projectId,
          link: {
            id: command.linkId,
            path: command.path,
            description: command.description,
            createdAt: command.createdAt,
          },
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.link.remove": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeProjects = listActiveProjects(readModel);
      // Removing from the mirrored side is the same operation: resolve back to
      // whichever project stores the edge and delete it there, once.
      const owner = findProjectLinkOwner(activeProjects, command.linkId);
      const removableFromCommandProject =
        owner !== undefined &&
        (owner.id === project.id ||
          (owner.links ?? []).some(
            (link) =>
              link.id === command.linkId &&
              normalizeProjectPathForComparison(link.path) ===
                normalizeProjectPathForComparison(project.workspaceRoot),
          ));
      if (owner === undefined || !removableFromCommandProject) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project link '${command.linkId}' does not exist for project '${command.projectId}'.`,
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: owner.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.link-removed",
        payload: {
          projectId: owner.id,
          linkId: command.linkId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.parentThreadId != null) {
        const parent = yield* requireThread({
          readModel,
          command,
          threadId: command.parentThreadId,
        });
        // One level deep, as documented on ThreadCompanionFields: a companion
        // that could delegate onward would fan out without bound and produce a
        // timeline no one can follow.
        if (parent.parentThreadId != null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${command.parentThreadId}' is itself a companion and cannot own companions.`,
          });
        }
        if (parent.projectId === command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Companion thread '${command.threadId}' must run in a different project than its parent.`,
          });
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          focusPath: command.focusPath ?? null,
          linkedPaths: normalizeThreadScopeLinkedPaths(command.linkedPaths, {
            focusPath: command.focusPath,
          }),
          parentThreadId: command.parentThreadId ?? null,
          originLinkId: command.originLinkId ?? null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const deletedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
      // Deleting the thread frees the issue: leaving the link would leave an
      // issue that can never be started again, pointing at nothing.
      const linkedIssue = findActiveIssueByThreadId(readModel, command.threadId);
      if (!linkedIssue) {
        return deletedEvent;
      }
      return [
        deletedEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "issue",
            aggregateId: linkedIssue.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "issue.updated" as const,
          payload: {
            issueId: linkedIssue.id,
            threadId: null,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": it clears a pin the same way it
      // parks the thread. Without this, settling a pinned thread would only
      // stamp invisible state — the pin would hold the card in place until
      // a separate unpin.
      if (thread.pinnedAt == null) {
        return settledEvent;
      }
      return [
        settledEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      // Touching either half of the scope re-normalizes the linked list
      // against the focus that will be in effect, so a folder promoted to
      // focus never lingers as a redundant link.
      const effectiveFocusPath =
        command.focusPath !== undefined ? command.focusPath : thread.focusPath;
      const nextLinkedPaths =
        command.linkedPaths !== undefined
          ? normalizeThreadScopeLinkedPaths(command.linkedPaths, {
              focusPath: effectiveFocusPath,
            })
          : command.focusPath !== undefined
            ? normalizeThreadScopeLinkedPaths(thread.linkedPaths, {
                focusPath: effectiveFocusPath,
              })
            : undefined;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.focusPath !== undefined ? { focusPath: command.focusPath } : {}),
          ...(nextLinkedPaths !== undefined ? { linkedPaths: nextLinkedPaths } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "issue.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireIssueAbsent({
        readModel,
        command,
        issueId: command.issueId,
      });
      const dependsOn = command.dependsOn ?? [];
      yield* requireValidIssueDependencies({
        readModel,
        command,
        issueId: command.issueId,
        projectId: command.projectId,
        dependsOn,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "issue.created",
        payload: {
          issueId: command.issueId,
          projectId: command.projectId,
          title: command.title,
          description: command.description ?? "",
          status: DEFAULT_ISSUE_STATUS,
          priority: command.priority ?? null,
          modelSelection: command.modelSelection ?? null,
          dependsOn,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "issue.update": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      if (command.dependsOn !== undefined) {
        yield* requireValidIssueDependencies({
          readModel,
          command,
          issueId: issue.id,
          projectId: issue.projectId,
          dependsOn: command.dependsOn,
        });
      }
      // Linking a thread is the start flow's job; an update may only clear the
      // link, which is how a user frees an issue to be started again.
      if (command.threadId != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Issue '${issue.id}' can only be linked to a thread by 'issue.start'; pass threadId: null to unlink.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.updated",
        payload: {
          issueId: command.issueId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.priority !== undefined ? { priority: command.priority } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.dependsOn !== undefined ? { dependsOn: command.dependsOn } : {}),
          ...(command.threadId !== undefined ? { threadId: null } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "issue.status.set": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      // Every transition is legal in both directions, including done ->
      // backlog: status is a label the user owns, not a ratchet. Re-setting the
      // same status re-emits with the existing updatedAt so a double-click
      // projects as a no-op instead of churning ordering.
      const statusUnchanged = issue.status === command.status;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.status-set",
        payload: {
          issueId: command.issueId,
          status: command.status,
          updatedAt: statusUnchanged ? issue.updatedAt : occurredAt,
        },
      };
    }

    case "issue.delete": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      const occurredAt = yield* nowIso;
      const deletedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.deleted",
        payload: {
          issueId: command.issueId,
          deletedAt: occurredAt,
        },
      };
      // Dangling dependencies would leave other issues gated on something the
      // dashboard can no longer show, so the edge is removed with the issue.
      const dependents = listActiveIssuesByProjectId(readModel, issue.projectId).filter(
        (candidate) => candidate.id !== issue.id && candidate.dependsOn.includes(issue.id),
      );
      if (dependents.length === 0) {
        return deletedEvent;
      }
      const dependentEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const dependent of dependents) {
        dependentEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "issue",
            aggregateId: dependent.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "issue.updated",
          payload: {
            issueId: dependent.id,
            dependsOn: dependent.dependsOn.filter((entry) => entry !== issue.id),
            updatedAt: occurredAt,
          },
        });
      }
      return [deletedEvent, ...dependentEvents];
    }

    case "issue.start": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      yield* requireProject({
        readModel,
        command,
        projectId: issue.projectId,
      });
      // Starting twice would orphan the first worktree. Unlink first
      // (`issue.update` with threadId: null) to start over.
      if (issue.threadId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Issue '${issue.id}' is already linked to thread '${issue.threadId}'.`,
        });
      }
      // A flagged issue is parked for a human. Rejecting here is what stops an
      // autonomous run from re-picking work that already failed once, which is
      // what makes the loop terminate.
      if (issueNeedsAttention(issue)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Issue '${issue.id}' needs attention and cannot be started until the flag is cleared.`,
        });
      }
      yield* requireIssueDependenciesSatisfied({ readModel, command, issue });
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "issue.started",
        payload: {
          issueId: command.issueId,
          threadId: command.threadId,
          status: "in_progress",
          updatedAt: command.createdAt,
        },
      };
    }

    case "issue.start.failed": {
      yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.start-failed",
        payload: {
          issueId: command.issueId,
          status: command.previousStatus,
          detail: command.detail,
          updatedAt: occurredAt,
        },
      };
    }

    case "issue.pull-request.link": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const issue = findActiveIssueByThreadId(readModel, thread.id);
      if (!issue) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not linked to an issue.`,
        });
      }
      // A PR opening moves work into review, but never drags a finished or
      // abandoned issue backwards — the URL is still recorded so the dashboard
      // can link out.
      const advancesToReview = issue.status !== "done" && issue.status !== "canceled";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: issue.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.pull-request-linked",
        payload: {
          issueId: issue.id,
          threadId: thread.id,
          pullRequestUrl: command.pullRequestUrl ?? null,
          ...(advancesToReview ? { status: "in_review" as const } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "issue.attention.flag": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      // Re-flagging keeps the original timestamp and reason: the first failure
      // is the one worth showing, and a retry loop must not churn ordering.
      const alreadyFlagged = issue.needsAttentionAt != null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.attention-flagged",
        payload: {
          issueId: command.issueId,
          reason: alreadyFlagged ? (issue.needsAttentionReason ?? command.reason) : command.reason,
          needsAttentionAt: alreadyFlagged ? issue.needsAttentionAt : occurredAt,
          updatedAt: alreadyFlagged ? issue.updatedAt : occurredAt,
        },
      };
    }

    case "issue.attention.clear": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      // Idempotent by re-emission (see thread.settle): clearing an unflagged
      // issue lands on the same state without churning updatedAt.
      const alreadyClear = issue.needsAttentionAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.attention-cleared",
        payload: {
          issueId: command.issueId,
          updatedAt: alreadyClear ? issue.updatedAt : occurredAt,
        },
      };
    }

    case "issue.review.start": {
      yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.review-started",
        payload: {
          issueId: command.issueId,
          reviewerThreadId: command.reviewerThreadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "issue.review.record": {
      const issue = yield* requireIssue({
        readModel,
        command,
        issueId: command.issueId,
      });
      const occurredAt = yield* nowIso;
      const reviewEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "issue",
          aggregateId: command.issueId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "issue.review-recorded",
        payload: {
          issueId: command.issueId,
          reviewerThreadId: command.reviewerThreadId,
          verdict: command.verdict,
          notes: command.notes,
          pullRequestUrl: issue.pullRequestUrl,
          // A merge is the end of the line for the issue. A parked verdict
          // leaves the status alone so the reviewer's own work stays visible
          // where it stopped, and the flag below is what takes it out of play.
          ...(command.verdict === "merged" ? { status: "done" as const } : {}),
          reviewedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      if (command.verdict === "merged") {
        return reviewEvent;
      }
      return [
        reviewEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "issue",
            aggregateId: command.issueId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "issue.attention-flagged" as const,
          payload: {
            issueId: command.issueId,
            reason: `Reviewer left this unmerged. See the review notes on issue '${command.issueId}'.`,
            needsAttentionAt: issue.needsAttentionAt ?? occurredAt,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "project.autonomous.enable": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (project.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is deleted and cannot run autonomously.`,
        });
      }
      // Re-enabling a live run keeps the original start time so the UI's "since"
      // does not jump when a raced client double-enables.
      const alreadyRunning = project.autonomousStartedAt != null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.autonomous-enabled",
        payload: {
          projectId: command.projectId,
          autonomousStartedAt: alreadyRunning ? project.autonomousStartedAt : occurredAt,
          updatedAt: alreadyRunning ? project.updatedAt : occurredAt,
        },
      };
    }

    case "project.autonomous.disable": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      // Idempotent by re-emission. The reason still lands so a run that
      // finishes after a user already stopped it does not relabel itself.
      const alreadyStopped = project.autonomousStartedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.autonomous-disabled",
        payload: {
          projectId: command.projectId,
          reason: command.reason === "completed" ? "completed" : "disabled",
          autonomousFinishedAt: alreadyStopped
            ? (project.autonomousFinishedAt ?? occurredAt)
            : occurredAt,
          updatedAt: alreadyStopped ? project.updatedAt : occurredAt,
        },
      };
    }

    case "project.autonomous.schedule.set": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (project.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is deleted and cannot hold a schedule.`,
        });
      }
      const duplicateId = command.schedule.find(
        (entry, index) => command.schedule.findIndex((other) => other.id === entry.id) !== index,
      );
      if (duplicateId !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Schedule entry id '${duplicateId.id}' appears more than once.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.autonomous-schedule-set",
        payload: {
          projectId: command.projectId,
          schedule: command.schedule,
          updatedAt: occurredAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
