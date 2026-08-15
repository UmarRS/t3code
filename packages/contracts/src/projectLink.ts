import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A cross-project link points one project at a folder that lives somewhere
 * else on the same environment — a backend linked to the web and mobile
 * frontends it serves. Deliberately distinct from thread scope
 * (`threadScope.ts`), which narrows a single thread *inside* one workspace:
 * these paths are absolute, cross-repository, and outlive any one thread.
 *
 * The target folder does not have to be a registered project, but whether it
 * is decides what the link can carry. When it is, the link is mirrored onto
 * that project (see `@t3tools/shared/projectLinks`) and work can be routed to
 * it: an agent there runs on the caller's model with its own write access
 * (see `LinkedProjectCoordinator`). When it is not, the link is read-only
 * context and nothing more — there is no project to open a thread in.
 */

const PROJECT_LINK_ID_MAX_LENGTH = 128;
const PROJECT_LINK_PATH_MAX_LENGTH = 512;
const PROJECT_LINK_DESCRIPTION_MAX_LENGTH = 500;

/** Upper bound per project, so a stray client cannot hand an agent the disk. */
export const PROJECT_LINK_MAX_PER_PROJECT = 16;

export const ProjectLinkId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_LINK_ID_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ProjectLinkId = typeof ProjectLinkId.Type;

/**
 * An absolute directory path on the environment that owns the project. POSIX
 * roots and Windows drive/UNC roots both qualify; a relative path does not,
 * because there is no workspace to resolve it against.
 */
export const ProjectLinkPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_LINK_PATH_MAX_LENGTH),
  Schema.makeFilter(
    (value) => isAbsoluteProjectLinkPath(value) || `'${value}' must be an absolute folder path`,
  ),
);
export type ProjectLinkPath = typeof ProjectLinkPath.Type;

function isAbsoluteProjectLinkPath(value: string): boolean {
  if (value.startsWith("/")) return true;
  // Windows drive (`C:\src`) and UNC (`\\host\share`) roots.
  return value.startsWith("\\\\") || /^[a-zA-Z]:[/\\]/.test(value);
}

/**
 * Required, and required for a reason: the description is what an agent reads
 * to learn what the linked folder *is*. "backend for all smartcanvass APIs"
 * earns its place in a prompt; a bare path does not.
 */
export const ProjectLinkDescription = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_LINK_DESCRIPTION_MAX_LENGTH),
);
export type ProjectLinkDescription = typeof ProjectLinkDescription.Type;

export const ProjectLink = Schema.Struct({
  id: ProjectLinkId,
  path: ProjectLinkPath,
  description: ProjectLinkDescription,
  createdAt: IsoDateTime,
});
export type ProjectLink = typeof ProjectLink.Type;

/**
 * Activity kind for the summary a companion agent folds back into the thread
 * that delegated to it. Rides the existing `thread.activity.append` channel,
 * like `model.failover`, so it streams to an open thread without widening the
 * thread-detail event allowlist in `ws.ts`.
 */
export const LINKED_PROJECT_AGENT_ACTIVITY_KIND = "linked-project.agent";

/**
 * How a delegated run ended. `timed-out` is not a failure: the companion is
 * still working and the delegating agent can poll it by thread id.
 */
export const LinkedProjectDelegationStatus = Schema.Literals(["completed", "failed", "timed-out"]);
export type LinkedProjectDelegationStatus = typeof LinkedProjectDelegationStatus.Type;

/**
 * Payload of the {@link LINKED_PROJECT_AGENT_ACTIVITY_KIND} activity. Typed
 * rather than left as free-form JSON because the thread timeline renders it
 * and needs the companion's id to offer "open this agent's thread".
 */
export const LinkedProjectAgentActivityPayload = Schema.Struct({
  companionThreadId: TrimmedNonEmptyString,
  targetProjectTitle: TrimmedNonEmptyString,
  targetWorkspaceRoot: TrimmedNonEmptyString,
  status: LinkedProjectDelegationStatus,
  task: TrimmedNonEmptyString,
  /** Absent while running, and on a run that produced no closing message. */
  result: Schema.optional(Schema.String),
});
export type LinkedProjectAgentActivityPayload = typeof LinkedProjectAgentActivityPayload.Type;

/**
 * Tool surface for handing work to an agent in a linked project.
 *
 * Targets are named by workspace root rather than project id: the id is an
 * internal identifier an agent has no way to learn, while the path is what
 * `list_linked_projects` hands back and what the agent already sees on disk.
 */
export const LinkedProjectSummary = Schema.Struct({
  path: ProjectLinkPath,
  title: TrimmedNonEmptyString,
  description: ProjectLinkDescription,
  /**
   * False for a folder no project is rooted at. Those are readable context
   * only — there is no project to open a thread in, so they cannot take work.
   */
  routable: Schema.Boolean,
});
export type LinkedProjectSummary = typeof LinkedProjectSummary.Type;

export const LinkedProjectListResult = Schema.Struct({
  projects: Schema.Array(LinkedProjectSummary),
});
export type LinkedProjectListResult = typeof LinkedProjectListResult.Type;

export const LinkedProjectDelegateInput = Schema.Struct({
  /** Workspace root of the linked project, exactly as `list_linked_projects` reports it. */
  path: ProjectLinkPath,
  /**
   * The task, written for an agent that cannot see this conversation. It runs
   * in its own repository with no view of the caller's context, so anything it
   * needs has to be stated here.
   */
  task: TrimmedNonEmptyString,
});
export type LinkedProjectDelegateInput = typeof LinkedProjectDelegateInput.Type;

export const LinkedProjectCheckInput = Schema.Struct({
  companionThreadId: TrimmedNonEmptyString,
});
export type LinkedProjectCheckInput = typeof LinkedProjectCheckInput.Type;

export const LinkedProjectDelegationResult = Schema.Struct({
  companionThreadId: TrimmedNonEmptyString,
  status: LinkedProjectDelegationStatus,
  targetProjectTitle: TrimmedNonEmptyString,
  targetWorkspaceRoot: TrimmedNonEmptyString,
  result: Schema.optional(Schema.String),
});
export type LinkedProjectDelegationResult = typeof LinkedProjectDelegationResult.Type;

export class LinkedProjectToolError extends Schema.TaggedErrorClass<LinkedProjectToolError>()(
  "LinkedProjectToolError",
  {
    reason: Schema.Literals(["unavailable", "unknown-project", "not-routable", "failed"]),
    message: Schema.String,
  },
) {}
