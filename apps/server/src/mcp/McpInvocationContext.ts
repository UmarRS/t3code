import {
  type EnvironmentId,
  LinkedProjectToolError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "linked-projects";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * Preview's capability gate. Narrowed to `"preview"` because it reports
 * refusal as a preview-automation error; other capabilities carry their own
 * failure type and gate through their own helper.
 */
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

/**
 * Linked-project gate. A session only carries this capability when its project
 * actually has a routable link, so refusal here means "nothing to delegate to",
 * not "something went wrong".
 */
export const requireLinkedProjectsCapability = Effect.fn("mcp.requireLinkedProjects")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("linked-projects")) {
    return yield* new LinkedProjectToolError({
      reason: "unavailable",
      message:
        "This thread's project has no linked projects that work can be routed to. Add one in project settings, pointing at a folder that is itself a registered project.",
    });
  }
  return invocation;
});
