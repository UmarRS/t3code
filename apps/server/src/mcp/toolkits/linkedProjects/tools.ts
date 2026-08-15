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
    "List the repositories this project is linked to. Worth calling as soon as a request touches something this repository does not contain — the API behind a screen you are building, the client that consumes an endpoint you are changing — because a linked repository is one you can hand that half of the work to.\n\nEntries marked routable can take work via delegate_to_linked_project. Non-routable entries are folders you may read but cannot delegate into. Each entry carries the description its owner wrote, which says what that repository is for.",
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
    "Hand a substantial piece of work to a dedicated agent in a linked repository, and wait for its result.\n\nYou may well be able to edit that repository's files yourself. Prefer this tool anyway when the work there is more than a couple of known edits — when it needs reading around the codebase, following that repo's conventions, or running its own checks. The delegated agent does that exploration in its own thread, so this conversation keeps its context for the work in front of you, and the other repository's changes land as a thread the user can open, review and take over on their own.\n\nFor a one-line change to a file you already know, editing it directly is simpler and better. Use your judgement on which of the two you are looking at.\n\nThe agent runs in that repository on the same model with the same write access, and cannot see this conversation, so `task` has to stand on its own: say what to build, name the contract both sides must agree on, and state anything already decided here. Returns its closing summary. A long run comes back as status 'timed-out' with a companionThreadId — the agent is still working; carry on with your half and poll it with check_linked_project_agent. Delegating to the same project again continues that agent's conversation, so follow-ups do not need to repeat the context.",
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
    "Check on an agent in a linked project that had not finished when delegate_to_linked_project returned. Pass the companionThreadId it gave you. Status is 'timed-out' while the agent is still working, and 'completed' or 'failed' once it is done. Do your own half of the work first and check back after — the two run in parallel, which is the point.",
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
