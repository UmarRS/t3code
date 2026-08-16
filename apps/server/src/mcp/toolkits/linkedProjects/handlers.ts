import {
  LinkedProjectToolError,
  ThreadId,
  type LinkedProjectDelegationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { LinkedProjectCoordinator } from "../../../orchestration/Services/LinkedProjectCoordinator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LinkedProjectsToolkit } from "./tools.ts";

const failed = (detail: unknown) =>
  new LinkedProjectToolError({ reason: "failed", message: String(detail) });

const toToolResult = (result: LinkedProjectDelegationResult) => ({
  companionThreadId: result.companionThreadId,
  status: result.status,
  targetProjectTitle: result.targetProjectTitle,
  targetWorkspaceRoot: result.targetWorkspaceRoot,
  ...(result.result !== undefined ? { result: result.result } : {}),
  // Present only on a queued delegation, and worth handing back: it is what
  // names the delegated work on the other project's board.
  ...(result.issueId !== undefined ? { issueId: result.issueId } : {}),
});

const handlers = {
  list_linked_projects: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireLinkedProjectsCapability();
      const coordinator = yield* LinkedProjectCoordinator;
      const projects = yield* coordinator
        .listLinksForThread(scope.threadId)
        .pipe(Effect.mapError(failed));
      return { projects };
    }),

  delegate_to_linked_project: (input: { readonly path: string; readonly task: string }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireLinkedProjectsCapability();
      const coordinator = yield* LinkedProjectCoordinator;

      const target = yield* coordinator
        .resolveTarget({ parentThreadId: scope.threadId, path: input.path })
        .pipe(Effect.mapError(failed));
      if (Option.isNone(target)) {
        return yield* new LinkedProjectToolError({
          reason: "not-routable",
          message: `'${input.path}' is not a linked project this thread can delegate to. Call list_linked_projects and use a path whose 'routable' is true.`,
        });
      }

      const result = yield* coordinator
        .delegate({
          parentThreadId: scope.threadId,
          targetProjectId: target.value.projectId,
          task: input.task,
        })
        .pipe(Effect.mapError(failed));
      return toToolResult(result);
    }),

  check_linked_project_agent: (input: { readonly companionThreadId: string }) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireLinkedProjectsCapability();
      const coordinator = yield* LinkedProjectCoordinator;
      const result = yield* coordinator
        .readDelegation(ThreadId.make(input.companionThreadId))
        .pipe(Effect.mapError(failed));
      return toToolResult(result);
    }),
} satisfies Parameters<typeof LinkedProjectsToolkit.toLayer>[0];

export const LinkedProjectsToolkitHandlersLive = LinkedProjectsToolkit.toLayer(handlers);
