// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "SHARED=root\nROOT_ONLY=root\n");
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.local"), "SHARED=local\nLOCAL_ONLY=local\n");

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      SHARED: "local",
      ROOT_ONLY: "root",
      LOCAL_ONLY: "local",
    });
    expect(loadRepoEnv({ baseEnv: { SHARED: "ci" }, repoRoot })).toMatchObject({
      SHARED: "ci",
      ROOT_ONLY: "root",
      LOCAL_ONLY: "local",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
