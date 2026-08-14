import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeThreadScopeLinkedPaths,
  normalizeThreadScopePath,
  THREAD_SCOPE_MAX_LINKED_PATHS,
  ThreadScopePath,
  threadScopePathLabel,
} from "./threadScope.ts";

const decodePath = Schema.decodeUnknownSync(ThreadScopePath);

describe("normalizeThreadScopePath", () => {
  it("keeps a relative posix path", () => {
    expect(normalizeThreadScopePath("apps/web")).toBe("apps/web");
  });

  it("normalizes the shapes a folder picker produces", () => {
    expect(normalizeThreadScopePath("  apps/web/  ")).toBe("apps/web");
    expect(normalizeThreadScopePath("./apps/web")).toBe("apps/web");
    expect(normalizeThreadScopePath("apps//web")).toBe("apps/web");
    expect(normalizeThreadScopePath("apps\\web")).toBe("apps/web");
  });

  it("treats the workspace root as unscoped", () => {
    expect(normalizeThreadScopePath("")).toBeNull();
    expect(normalizeThreadScopePath(".")).toBeNull();
    expect(normalizeThreadScopePath("/")).toBeNull();
    expect(normalizeThreadScopePath(null)).toBeNull();
    expect(normalizeThreadScopePath(undefined)).toBeNull();
  });

  it("rejects paths that would escape the workspace", () => {
    expect(normalizeThreadScopePath("../secrets")).toBeNull();
    expect(normalizeThreadScopePath("apps/../../etc")).toBeNull();
    expect(normalizeThreadScopePath("/etc/passwd")).toBeNull();
    expect(normalizeThreadScopePath("C:/Windows")).toBeNull();
  });
});

describe("ThreadScopePath", () => {
  it("accepts a normalized path", () => {
    expect(decodePath("apps/web")).toBe("apps/web");
  });

  // The schema is the wire's last line of defense: a client that skipped
  // normalization must not be able to hand the server a traversal.
  it("rejects traversal and absolute paths on the wire", () => {
    expect(() => decodePath("../etc")).toThrow();
    expect(() => decodePath("/etc")).toThrow();
    expect(() => decodePath("apps/./web")).toThrow();
    expect(() => decodePath("apps/web/")).toThrow();
  });
});

describe("normalizeThreadScopeLinkedPaths", () => {
  it("drops duplicates and unusable entries", () => {
    expect(
      normalizeThreadScopeLinkedPaths(["apps/server", "apps/server", "../etc", "", null]),
    ).toEqual(["apps/server"]);
  });

  it("drops the focus path, which is already granted", () => {
    expect(
      normalizeThreadScopeLinkedPaths(["apps/web", "apps/server"], { focusPath: "apps/web" }),
    ).toEqual(["apps/server"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: THREAD_SCOPE_MAX_LINKED_PATHS + 5 }, (_, i) => `pkg/p${i}`);
    expect(normalizeThreadScopeLinkedPaths(many)).toHaveLength(THREAD_SCOPE_MAX_LINKED_PATHS);
  });

  it("preserves the order the user picked", () => {
    expect(normalizeThreadScopeLinkedPaths(["b", "a", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("threadScopePathLabel", () => {
  it("labels a path by its last segment", () => {
    expect(threadScopePathLabel("apps/web")).toBe("web");
    expect(threadScopePathLabel("backend")).toBe("backend");
  });
});
