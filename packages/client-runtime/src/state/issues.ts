import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationIssue,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import { arrayElementsEqual, parseProjectKey, projectKey } from "./entities.ts";
import {
  type ClearIssueAttentionInput,
  type CreateIssueInput,
  type DeleteIssueInput,
  type LinkIssuePullRequestInput,
  type ResetIssueReviewInput,
  type SetIssueStatusInput,
  type StartIssueInput,
  type UpdateIssueInput,
  clearIssueAttention,
  createIssue,
  deleteIssue,
  linkIssuePullRequest,
  resetIssueReview,
  setIssueStatus,
  startIssue,
  updateIssue,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ClearIssueAttentionInput,
  CreateIssueInput,
  DeleteIssueInput,
  LinkIssuePullRequestInput,
  ResetIssueReviewInput,
  SetIssueStatusInput,
  StartIssueInput,
  UpdateIssueInput,
} from "../operations/commands.ts";

const EMPTY_ISSUES: ReadonlyArray<OrchestrationIssue> = Object.freeze([]);

/**
 * Issue commands and the one point read. Issue summaries themselves ride the
 * shell snapshot, so the only unary call here is the markdown body an editor
 * needs — everything else on an issue is already live in the read model.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { issueId: string } }) =>
      JSON.stringify([environmentId, input.issueId]),
  };
  return {
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:detail",
      tag: ORCHESTRATION_WS_METHODS.getIssue,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:create",
      execute: (input: CreateIssueInput) => createIssue(input),
      scheduler,
      concurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:update",
      execute: (input: UpdateIssueInput) => updateIssue(input),
      scheduler,
      concurrency,
    }),
    setStatus: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:set-status",
      execute: (input: SetIssueStatusInput) => setIssueStatus(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:delete",
      execute: (input: DeleteIssueInput) => deleteIssue(input),
      scheduler,
      concurrency,
    }),
    start: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:start",
      execute: (input: StartIssueInput) => startIssue(input),
      scheduler,
      concurrency,
    }),
    clearAttention: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:clear-attention",
      execute: (input: ClearIssueAttentionInput) => clearIssueAttention(input),
      scheduler,
      concurrency,
    }),
    resetReview: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:reset-review",
      execute: (input: ResetIssueReviewInput) => resetIssueReview(input),
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:issue:link-pull-request",
      execute: (input: LinkIssuePullRequestInput) => linkIssuePullRequest(input),
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}

/**
 * Read selectors over the issues carried by the shell snapshot. The server
 * already sorts them by creation time, so the project slice preserves that
 * order and only re-identifies when the underlying rows change.
 */
export function createEnvironmentIssueAtoms(input: {
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentIssuesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationIssue> =>
        get(input.snapshotAtom(environmentId))?.issues ?? EMPTY_ISSUES,
    ).pipe(Atom.withLabel(`environment-issues:${environmentId}`)),
  );

  const projectIssuesAtomFamily = Atom.family((key: string) => {
    const ref = parseProjectKey(key);
    let previous: ReadonlyArray<OrchestrationIssue> = EMPTY_ISSUES;
    return Atom.make((get) => {
      const next = get(environmentIssuesAtom(ref.environmentId)).filter(
        (issue) => issue.projectId === ref.projectId,
      );
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next.length === 0 ? EMPTY_ISSUES : next;
      return previous;
    }).pipe(Atom.withLabel(`environment-project-issues:${key}`));
  });

  return {
    environmentIssuesAtom,
    projectIssuesAtom: (ref: ScopedProjectRef) => projectIssuesAtomFamily(projectKey(ref)),
    projectIssuesAtomByIds: (environmentId: EnvironmentId, projectId: ProjectId) =>
      projectIssuesAtomFamily(projectKey({ environmentId, projectId })),
  };
}
