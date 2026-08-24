import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CommandOf<T>
    ? {
        readonly createdAt?: CommandOf<T>["createdAt"];
      }
    : {});

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type AddProjectLinkInput = CommandInput<"project.link.add">;
export type RemoveProjectLinkInput = CommandInput<"project.link.remove">;
export type EnableProjectAutonomousInput = CommandInput<"project.autonomous.enable">;
export type DisableProjectAutonomousInput = Omit<
  CommandInput<"project.autonomous.disable">,
  "reason"
>;
export type SetProjectAutonomousScheduleInput = CommandInput<"project.autonomous.schedule.set">;
export type CreateThreadInput = CommandInput<"thread.create">;
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type SetThreadAutoShipInput = CommandInput<"thread.auto-ship.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start">;
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert">;
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;
export type ResumeThreadTurnInput = CommandInput<"thread.turn.resume">;
export type CreateIssueInput = CommandInput<"issue.create">;
export type UpdateIssueInput = CommandInput<"issue.update">;
export type SetIssueStatusInput = CommandInput<"issue.status.set">;
export type DeleteIssueInput = CommandInput<"issue.delete">;
export type StartIssueInput = CommandInput<"issue.start">;
export type LinkIssuePullRequestInput = CommandInput<"issue.pull-request.link">;
export type ClearIssueAttentionInput = CommandInput<"issue.attention.clear">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const addProjectLink: (input: AddProjectLinkInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.addProjectLink",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.link.add",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const removeProjectLink: (input: RemoveProjectLinkInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.removeProjectLink",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.link.remove",
    commandId: yield* commandId(input),
  });
});

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const setThreadAutoShip: (input: SetThreadAutoShipInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadAutoShip",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.auto-ship.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

/**
 * Pick a thread's interrupted turn back up now. The server rebuilds the turn
 * from the thread's own last user message, so this carries no message payload —
 * the client no longer holds the bytes of any attachment it sent.
 */
export const resumeThreadTurn: (input: ResumeThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.resumeThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.resume",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const createIssue: (input: CreateIssueInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createIssue",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "issue.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateIssue: (input: UpdateIssueInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateIssue",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "issue.update",
    commandId: yield* commandId(input),
  });
});

export const setIssueStatus: (input: SetIssueStatusInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setIssueStatus",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "issue.status.set",
    commandId: yield* commandId(input),
  });
});

export const deleteIssue: (input: DeleteIssueInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteIssue",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "issue.delete",
    commandId: yield* commandId(input),
  });
});

/**
 * Opens the worktree thread for an issue and seeds its first turn. The server
 * builds the prompt, so every surface that starts an issue sends the same text.
 */
export const startIssue: (input: StartIssueInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startIssue",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "issue.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/**
 * Records the pull request opened for a thread. Keyed by thread because that is
 * what the source-control surface knows; the server resolves the linked issue
 * and moves it to review.
 */
export const linkIssuePullRequest: (input: LinkIssuePullRequestInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.linkIssuePullRequest",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "issue.pull-request.link",
    commandId: yield* commandId(input),
  });
});

/**
 * Turn on autonomous mode for a project. Idempotent: re-enabling a live run
 * keeps its original start time.
 */
export const enableProjectAutonomous: (input: EnableProjectAutonomousInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.enableProjectAutonomous")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.autonomous.enable",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

/**
 * Stop starting new work. `reason` is fixed to `user` here: `completed` is the
 * server's own auto-stop and is what tells a finished run from a stopped one.
 */
export const disableProjectAutonomous: (input: DisableProjectAutonomousInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.disableProjectAutonomous")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "project.autonomous.disable",
      reason: "user",
      commandId: yield* commandId(input),
    });
  });

/** Replace a project's scheduled run times. The list is sent whole. */
export const setProjectAutonomousSchedule: (
  input: SetProjectAutonomousScheduleInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.setProjectAutonomousSchedule")(
  function* (input) {
    return yield* dispatch({
      ...input,
      type: "project.autonomous.schedule.set",
      commandId: yield* commandId(input),
    });
  },
);

export const clearIssueAttention: (input: ClearIssueAttentionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.clearIssueAttention",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "issue.attention.clear",
    commandId: yield* commandId(input),
  });
});
