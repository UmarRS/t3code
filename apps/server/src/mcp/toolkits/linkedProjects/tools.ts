import {
  LinkedProjectCheckInput,
  LinkedProjectDelegateInput,
  LinkedProjectDelegationResult,
  LinkedProjectListResult,
  LinkedProjectToolError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { LinkedProjectCoordinator } from "../../../orchestration/Services/LinkedProjectCoordinator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, LinkedProjectCoordinator];

export const ListLinkedProjectsTool = Tool.make("list_linked_projects", {
  description:
    "List the projects this project is linked to. Routable entries are separate repositories you can hand work to with delegate_to_linked_project; non-routable entries are folders you may read but cannot delegate into. Each entry carries the description its owner wrote, which says what that repository is for.",
  parameters: Schema.Struct({}),
  success: LinkedProjectListResult,
  failure: LinkedProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "List linked projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const DelegateToLinkedProjectTool = Tool.make("delegate_to_linked_project", {
  description:
    "Hand a task to an agent running in a linked project, and wait for it to finish. Use this when work spans repositories — building a UI here while its API is added there. The agent runs in that repository with the same model and the same write access you have, and cannot see this conversation, so state everything it needs in `task`. Returns its closing summary. A long run comes back as status 'timed-out' with a companionThreadId: the agent is still working, poll it with check_linked_project_agent. Delegating twice to the same project continues the same agent's conversation.",
  parameters: LinkedProjectDelegateInput,
  success: LinkedProjectDelegationResult,
  failure: LinkedProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate to a linked project")
  .annotate(Tool.Readonly, false)
  // It writes to another repository — the most consequential thing any tool
  // here does, and worth flagging as such.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const CheckLinkedProjectAgentTool = Tool.make("check_linked_project_agent", {
  description:
    "Check on an agent in a linked project that had not finished when delegate_to_linked_project returned. Pass the companionThreadId it gave you. Status is 'timed-out' while the agent is still working, and 'completed' or 'failed' once it is done.",
  parameters: LinkedProjectCheckInput,
  success: LinkedProjectDelegationResult,
  failure: LinkedProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check a linked-project agent")
  .annotate(Tool.Readonly, true);

export const LinkedProjectsToolkit = Toolkit.make(
  ListLinkedProjectsTool,
  DelegateToLinkedProjectTool,
  CheckLinkedProjectAgentTool,
);
