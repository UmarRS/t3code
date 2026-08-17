import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentIssueAtoms,
  createIssueEnvironmentAtoms,
} from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  OrchestrationIssue,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "./shell";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
export const environmentIssues = createEnvironmentIssueAtoms({
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_ISSUES: ReadonlyArray<OrchestrationIssue> = Object.freeze([]);
const EMPTY_ISSUES_ATOM = Atom.make(EMPTY_ISSUES).pipe(Atom.withLabel("web-project-issues:empty"));

/** Live backlog for one project, in creation order, deleted issues excluded. */
export function useProjectIssues(ref: ScopedProjectRef | null): ReadonlyArray<OrchestrationIssue> {
  return useAtomValue(ref === null ? EMPTY_ISSUES_ATOM : environmentIssues.projectIssuesAtom(ref));
}

/**
 * Every issue in one environment, across its projects. The board needs the
 * other projects' rows to see delegation links reaching into or out of it.
 */
export function useEnvironmentIssues(
  environmentId: EnvironmentId | null,
): ReadonlyArray<OrchestrationIssue> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_ISSUES_ATOM
      : environmentIssues.environmentIssuesAtom(environmentId),
  );
}

/** An issue carrying the environment it lives in, for cross-environment views. */
export interface EnvironmentIssue extends OrchestrationIssue {
  readonly environmentId: EnvironmentId;
}

const EMPTY_SCOPED_ISSUES: ReadonlyArray<EnvironmentIssue> = Object.freeze([]);

/**
 * One environment's issues, each tagged with its environment. Re-scopes only
 * when the underlying rows change, so the flattened list below can compare
 * slices by identity.
 */
const scopedEnvironmentIssuesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previousSource: ReadonlyArray<OrchestrationIssue> | null = null;
  let previous: ReadonlyArray<EnvironmentIssue> = EMPTY_SCOPED_ISSUES;
  return Atom.make((get): ReadonlyArray<EnvironmentIssue> => {
    const source = get(environmentIssues.environmentIssuesAtom(environmentId));
    if (source === previousSource) {
      return previous;
    }
    previousSource = source;
    previous =
      source.length === 0
        ? EMPTY_SCOPED_ISSUES
        : source.map((issue) => ({ ...issue, environmentId }));
    return previous;
  }).pipe(Atom.withLabel(`web-environment-scoped-issues:${environmentId}`));
});

let previousIssueSlices: ReadonlyArray<ReadonlyArray<EnvironmentIssue>> = [];
let previousAllIssues: ReadonlyArray<EnvironmentIssue> = EMPTY_SCOPED_ISSUES;
const allEnvironmentIssuesAtom = Atom.make((get): ReadonlyArray<EnvironmentIssue> => {
  const slices: ReadonlyArray<EnvironmentIssue>[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    slices.push(get(scopedEnvironmentIssuesAtom(environmentId)));
  }
  if (
    slices.length === previousIssueSlices.length &&
    slices.every((slice, index) => slice === previousIssueSlices[index])
  ) {
    return previousAllIssues;
  }
  previousIssueSlices = slices;
  previousAllIssues = slices.flat();
  return previousAllIssues;
}).pipe(Atom.withLabel("web-all-environment-issues"));

/**
 * Every issue in every connected environment. Only the cross-cutting surfaces
 * (attention notifications) need this much; a board reads its own project.
 */
export function useAllEnvironmentIssues(): ReadonlyArray<EnvironmentIssue> {
  return useAtomValue(allEnvironmentIssuesAtom);
}

export function readEnvironmentIssues(
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationIssue> {
  return appAtomRegistry.get(environmentIssues.environmentIssuesAtom(environmentId));
}

/**
 * The live issue a thread is doing the work for, if any. Read rather than
 * subscribed: the source-control path needs it at dispatch time only.
 */
export function readIssueForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): OrchestrationIssue | null {
  return readEnvironmentIssues(environmentId).find((issue) => issue.threadId === threadId) ?? null;
}
