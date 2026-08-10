import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Thread scope narrows what an agent works on inside one project. A project
 * rooted at a monorepo is often three or four unrelated areas; a thread about
 * the checkout button has no business reading the mobile app.
 *
 * `focusPath` moves the agent's working directory to a subdirectory, so its
 * searches, relative paths, and memory-file discovery all narrow with it.
 * `linkedPaths` are the neighbors that same thread still needs to read — the
 * backend API surface behind that checkout button — granted explicitly rather
 * than by leaving the whole tree open.
 *
 * Both are workspace-relative and always apply below whatever root the thread
 * already runs in, so a scoped thread in a worktree stays inside its worktree.
 * Git, checkpoints, and diffs deliberately ignore scope and keep operating on
 * the whole repository.
 */

const THREAD_SCOPE_PATH_MAX_LENGTH = 512;

/** Upper bound on linked paths, so a stray client cannot grant a thread the world. */
export const THREAD_SCOPE_MAX_LINKED_PATHS = 16;

/**
 * A workspace-relative directory path in POSIX form: no leading slash, no
 * drive letter, and no `..` segment that would escape the workspace root.
 * {@link normalizeThreadScopePath} produces values in this shape.
 */
export const ThreadScopePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_SCOPE_PATH_MAX_LENGTH),
  Schema.makeFilter(
    (value) =>
      isNormalizedThreadScopePath(value) ||
      `'${value}' must be a relative POSIX path inside the workspace`,
  ),
);
export type ThreadScopePath = typeof ThreadScopePath.Type;

function isNormalizedThreadScopePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/")) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("//")) return false;
  // A Windows drive letter would read as relative here but resolve as absolute.
  if (/^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

/**
 * Coerce user or wire input into a {@link ThreadScopePath}, or null when the
 * value does not name a directory inside the workspace. The workspace root
 * itself ("", ".", "/") normalizes to null: no focus is the absence of a
 * scope, not a scope on everything.
 */
export function normalizeThreadScopePath(value: string | null | undefined): ThreadScopePath | null {
  if (value == null) return null;
  const collapsed = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
  if (collapsed.length === 0 || collapsed === ".") return null;
  if (!isNormalizedThreadScopePath(collapsed)) return null;
  return collapsed as ThreadScopePath;
}

/**
 * Normalize a linked-path list: drop anything unusable, drop duplicates, drop
 * the focus path itself (it is already granted), and cap the length. Order is
 * the caller's, since it is the order the user picked them in.
 */
export function normalizeThreadScopeLinkedPaths(
  values: ReadonlyArray<string | null | undefined> | null | undefined,
  options?: { readonly focusPath?: string | null | undefined },
): ReadonlyArray<ThreadScopePath> {
  if (!values || values.length === 0) return [];
  const focusPath = normalizeThreadScopePath(options?.focusPath);
  const seen = new Set<string>();
  const linked: ThreadScopePath[] = [];
  for (const value of values) {
    const normalized = normalizeThreadScopePath(value);
    if (!normalized || normalized === focusPath || seen.has(normalized)) continue;
    seen.add(normalized);
    linked.push(normalized);
    if (linked.length === THREAD_SCOPE_MAX_LINKED_PATHS) break;
  }
  return linked;
}

/** Label for a scope path in menus and chips: the last segment, which is what the user named the folder. */
export function threadScopePathLabel(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** True when both sides describe the same scope, for change detection. */
export function threadScopesEqual(
  left: { readonly focusPath: string | null; readonly linkedPaths: ReadonlyArray<string> },
  right: { readonly focusPath: string | null; readonly linkedPaths: ReadonlyArray<string> },
): boolean {
  return (
    left.focusPath === right.focusPath &&
    left.linkedPaths.length === right.linkedPaths.length &&
    left.linkedPaths.every((path, index) => path === right.linkedPaths[index])
  );
}

/**
 * The scope fields as they ride on threads, events, and commands — optional
 * everywhere, like the other fields added to threads after the fact, so that
 * payloads written before scope existed still decode and callers that do not
 * care about scope keep constructing commands as they always did.
 *
 * On a thread, absent means unscoped. On a command or meta-update event,
 * absent means "leave the current scope alone", a null `focusPath` clears the
 * focus, and a `linkedPaths` array replaces the list wholesale — the same
 * split `branch` and `worktreePath` already use.
 */
export const ThreadScopeFields = {
  focusPath: Schema.optional(Schema.NullOr(ThreadScopePath)),
  linkedPaths: Schema.optional(
    Schema.Array(ThreadScopePath).check(Schema.isMaxLength(THREAD_SCOPE_MAX_LINKED_PATHS)),
  ),
} as const;

export const ThreadScope = Schema.Struct(ThreadScopeFields);
export type ThreadScope = typeof ThreadScope.Type;

/** The scope of a thread, with the absent-means-unscoped defaults applied. */
export function readThreadScope(thread: {
  readonly focusPath?: string | null | undefined;
  readonly linkedPaths?: ReadonlyArray<string> | undefined;
}): { readonly focusPath: string | null; readonly linkedPaths: ReadonlyArray<string> } {
  return { focusPath: thread.focusPath ?? null, linkedPaths: thread.linkedPaths ?? [] };
}
