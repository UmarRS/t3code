import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveReviewerModelSelection } from "./reviewerModelSelection.ts";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const model = (slug: string) => ({ slug, name: slug, isCustom: false }) as never;

// The catalog is ordered newest-first, so "the first Opus" is "the strongest
// Opus" without this module knowing any model names.
const CLAUDE_CATALOG = [
  model("claude-fable-5"),
  model("claude-opus-5"),
  model("claude-sonnet-5"),
  model("claude-opus-4-8"),
];

describe("resolveReviewerModelSelection", () => {
  it("picks the first Opus in the adapter's catalog order", () => {
    const selection = resolveReviewerModelSelection([provider({ models: CLAUDE_CATALOG })]);
    expect(selection).toEqual({
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5",
    });
  });

  it("ignores non-Claude providers", () => {
    const selection = resolveReviewerModelSelection([
      provider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        models: [model("gpt-5-codex")],
      }),
    ]);
    expect(selection).toBeNull();
  });

  it("skips a Claude provider that is disabled, missing, or unavailable", () => {
    expect(
      resolveReviewerModelSelection([provider({ enabled: false, models: CLAUDE_CATALOG })]),
    ).toBeNull();
    expect(
      resolveReviewerModelSelection([provider({ installed: false, models: CLAUDE_CATALOG })]),
    ).toBeNull();
    expect(
      resolveReviewerModelSelection([
        provider({ availability: "unavailable", models: CLAUDE_CATALOG }),
      ]),
    ).toBeNull();
  });

  // A custom-model-only Claude install still reviews rather than blocking the
  // whole run.
  it("falls back to the first model when no Opus is exposed", () => {
    const selection = resolveReviewerModelSelection([
      provider({ models: [model("claude-sonnet-5")] }),
    ]);
    expect(selection?.model).toBe("claude-sonnet-5");
  });

  it("returns null when the provider exposes no models at all", () => {
    expect(resolveReviewerModelSelection([provider({ models: [] })])).toBeNull();
  });

  it("returns null when there are no providers", () => {
    expect(resolveReviewerModelSelection([])).toBeNull();
  });
});
