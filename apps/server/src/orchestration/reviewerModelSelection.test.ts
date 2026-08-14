import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveReviewClassifierModelSelection,
  resolveReviewerModelSelection,
  resolveTieredReviewerModelSelection,
} from "./reviewerModelSelection.ts";

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

// The full Claude catalog, newest first, including the cheaper classes the
// tiers map onto.
const FULL_CLAUDE_CATALOG = [
  model("claude-fable-5"),
  model("claude-opus-5"),
  model("claude-sonnet-5"),
  model("claude-opus-4-8"),
  model("claude-sonnet-4-6"),
  model("claude-haiku-4-5"),
];

const codexProvider = (models: ReadonlyArray<{ slug: string }>) =>
  provider({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    models: models as never,
  });

const CODEX_CATALOG = [model("gpt-5.6-sol"), model("gpt-5.5"), model("gpt-5.4-mini")];

describe("resolveTieredReviewerModelSelection", () => {
  it("maps each tier to its model class in catalog order", () => {
    const providers = [provider({ models: FULL_CLAUDE_CATALOG })];
    expect(resolveTieredReviewerModelSelection(providers, "trivial")?.model).toBe(
      "claude-haiku-4-5",
    );
    expect(resolveTieredReviewerModelSelection(providers, "standard")?.model).toBe(
      "claude-sonnet-5",
    );
    expect(resolveTieredReviewerModelSelection(providers, "complex")?.model).toBe("claude-opus-5");
  });

  it("falls upward when a tier's class is missing from the catalog", () => {
    // No Haiku: trivial reviews on the standard tier's Sonnet.
    const noHaiku = [provider({ models: [model("claude-opus-5"), model("claude-sonnet-5")] })];
    expect(resolveTieredReviewerModelSelection(noHaiku, "trivial")?.model).toBe("claude-sonnet-5");

    // No Haiku and no Sonnet: everything reviews on the strongest.
    const opusOnly = [provider({ models: [model("claude-opus-5")] })];
    expect(resolveTieredReviewerModelSelection(opusOnly, "trivial")?.model).toBe("claude-opus-5");
    expect(resolveTieredReviewerModelSelection(opusOnly, "standard")?.model).toBe("claude-opus-5");
  });

  it("never falls downward: complex ignores cheaper models entirely", () => {
    const providers = [provider({ models: FULL_CLAUDE_CATALOG })];
    expect(resolveTieredReviewerModelSelection(providers, "complex")?.model).toBe("claude-opus-5");
  });

  it("lets a Codex mini review trivial work when no Claude provider is usable", () => {
    const providers = [
      provider({ enabled: false, models: FULL_CLAUDE_CATALOG }),
      codexProvider(CODEX_CATALOG),
    ];
    expect(resolveTieredReviewerModelSelection(providers, "trivial")).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-mini",
    });
  });

  it("does not go sideways to Codex while a Claude provider is usable", () => {
    // Claude without a Haiku falls up to Sonnet, not over to the Codex mini.
    const providers = [
      provider({ models: [model("claude-opus-5"), model("claude-sonnet-5")] }),
      codexProvider(CODEX_CATALOG),
    ];
    expect(resolveTieredReviewerModelSelection(providers, "trivial")?.model).toBe(
      "claude-sonnet-5",
    );
  });

  it("keeps the existing park-the-issue null when nothing is configured", () => {
    expect(resolveTieredReviewerModelSelection([], "trivial")).toBeNull();
    expect(resolveTieredReviewerModelSelection([], "complex")).toBeNull();
    // Codex alone cannot serve the standard or complex tiers; that stays the
    // existing null so the caller parks instead of inventing a new path.
    expect(resolveTieredReviewerModelSelection([codexProvider(CODEX_CATALOG)], "standard")).toBe(
      null,
    );
  });
});

describe("resolveReviewClassifierModelSelection", () => {
  it("prefers the Claude Haiku, then the Codex mini", () => {
    expect(
      resolveReviewClassifierModelSelection([provider({ models: FULL_CLAUDE_CATALOG })])?.model,
    ).toBe("claude-haiku-4-5");
    expect(resolveReviewClassifierModelSelection([codexProvider(CODEX_CATALOG)])?.model).toBe(
      "gpt-5.4-mini",
    );
  });

  it("returns null when no cheap class exists, so the caller skips classification", () => {
    expect(
      resolveReviewClassifierModelSelection([provider({ models: [model("claude-opus-5")] })]),
    ).toBeNull();
    expect(resolveReviewClassifierModelSelection([])).toBeNull();
  });
});
