import type {
  IssueId,
  OrchestrationCommand,
  OrchestrationIssue,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { findIssueDependencyCycle, isIssueDependencySatisfied } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function findIssueById(
  readModel: OrchestrationReadModel,
  issueId: IssueId,
): OrchestrationIssue | undefined {
  return readModel.issues.find((issue) => issue.id === issueId);
}

/** Live issues in a project, in read-model order. Deleted rows never count. */
export function listActiveIssuesByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationIssue> {
  return readModel.issues.filter(
    (issue) => issue.projectId === projectId && issue.deletedAt === null,
  );
}

/** The live issue a thread is doing the work for, if any. */
export function findActiveIssueByThreadId(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationIssue | undefined {
  return readModel.issues.find((issue) => issue.threadId === threadId && issue.deletedAt === null);
}

/** The live issue a thread is reviewing, if any. */
export function findActiveIssueByReviewerThreadId(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationIssue | undefined {
  return readModel.issues.find(
    (issue) => issue.reviewerThreadId === threadId && issue.deletedAt === null,
  );
}

export function requireIssue(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly issueId: IssueId;
}): Effect.Effect<OrchestrationIssue, OrchestrationCommandInvariantError> {
  const issue = findIssueById(input.readModel, input.issueId);
  if (issue && issue.deletedAt === null) {
    return Effect.succeed(issue);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Issue '${input.issueId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireIssueAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly issueId: IssueId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findIssueById(input.readModel, input.issueId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Issue '${input.issueId}' already exists and cannot be created twice.`,
    ),
  );
}

/**
 * Validate a proposed dependency list for one issue: every id must name a live
 * issue in the same project, an issue may not depend on itself, and the edge
 * set must leave the project graph acyclic. The proposed list replaces whatever
 * the issue depends on today, so an update that removes a back edge is allowed
 * even when the stored graph is (somehow) already cyclic.
 */
export function requireValidIssueDependencies(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly issueId: IssueId;
  readonly projectId: ProjectId;
  readonly dependsOn: ReadonlyArray<IssueId>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const projectIssues = listActiveIssuesByProjectId(input.readModel, input.projectId);
  const byId = new Map(projectIssues.map((issue) => [issue.id, issue] as const));
  const seen = new Set<string>();
  for (const dependencyId of input.dependsOn) {
    if (dependencyId === input.issueId) {
      return Effect.fail(
        invariantError(input.command.type, `Issue '${input.issueId}' cannot depend on itself.`),
      );
    }
    if (seen.has(dependencyId)) {
      return Effect.fail(
        invariantError(
          input.command.type,
          `Issue '${input.issueId}' lists dependency '${dependencyId}' twice.`,
        ),
      );
    }
    seen.add(dependencyId);
    if (!byId.has(dependencyId)) {
      return Effect.fail(
        invariantError(
          input.command.type,
          `Dependency '${dependencyId}' is not an issue in project '${input.projectId}'.`,
        ),
      );
    }
  }
  const cycle = findIssueDependencyCycle(projectIssues, {
    issueId: input.issueId,
    dependsOn: input.dependsOn,
  });
  if (cycle) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Issue dependencies would form a cycle: ${cycle.join(" -> ")}.`,
      ),
    );
  }
  return Effect.void;
}

/**
 * The start gate. Work on an issue may not begin while a dependency is
 * unfinished — that is the whole point of recording the dependency, and letting
 * an agent loose on a story whose groundwork is missing wastes a worktree and a
 * turn. Only `done` counts; a canceled dependency is an unresolved decision,
 * so the user must edit the graph rather than have the gate guess.
 */
export function requireIssueDependenciesSatisfied(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly issue: OrchestrationIssue;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const projectIssues = listActiveIssuesByProjectId(input.readModel, input.issue.projectId);
  const byId = new Map(projectIssues.map((issue) => [issue.id, issue] as const));
  const blocking = input.issue.dependsOn.filter((dependencyId) => {
    const dependency = byId.get(dependencyId);
    // A dependency that no longer exists cannot block: deleting the blocker is
    // how a user clears it.
    return dependency !== undefined && !isIssueDependencySatisfied(dependency.status);
  });
  if (blocking.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Issue '${input.issue.id}' is blocked by unfinished ${
        blocking.length === 1 ? "dependency" : "dependencies"
      } ${blocking.join(", ")}.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
