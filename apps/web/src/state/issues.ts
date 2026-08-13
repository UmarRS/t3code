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
