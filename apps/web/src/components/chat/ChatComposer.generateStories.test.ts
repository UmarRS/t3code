// @effect-diagnostics nodeBuiltinImport:off - This regression checks the model-selection boundary in the composer source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("chat composer story generation", () => {
  it("keeps the current model while making linked boards available", () => {
    const source = NodeFS.readFileSync(new URL("./ChatComposer.tsx", import.meta.url), "utf8");
    const actionStart = source.indexOf("const prepareGenerateStoriesPrompt = useCallback");
    const actionEnd = source.indexOf("const providerTraitsMenuContent", actionStart);
    const action = source.slice(actionStart, actionEnd);

    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(actionEnd).toBeGreaterThan(actionStart);
    expect(action).toContain("linkedProjects: generateStoriesRoutingTargets");
    expect(action).not.toContain("resolvePlanningModelSelection");
    expect(action).not.toContain("setModelSelection");
  });
});
