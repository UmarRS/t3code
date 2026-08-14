import {
  isProviderAvailable,
  type IssueReviewComplexityTier,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Picking the reviewer's model. Reviewing is the step that decides whether work
 * lands on main unsupervised, so by default it does not inherit the worker's
 * model: `resolveReviewerModelSelection` always answers with the strongest Opus
 * the Claude adapter exposes.
 *
 * "Strongest" is the adapter's own catalog order, which lists models newest
 * first — so the first Opus in the list is the current one. Reading the order
 * rather than hard-coding a slug means a new Opus is picked up the moment the
 * adapter learns about it. The same rule extends to the cheaper classes below:
 * the first Haiku is the current Haiku, the first Sonnet the current Sonnet.
 *
 * `resolveTieredReviewerModelSelection` layers a complexity tier on top:
 * trivial work reviews on the cheapest capable model, standard work on a
 * mid-tier one, complex work on the strongest available. A tier whose model
 * class is missing falls *upward* to the next stronger class, never downward —
 * a review must never silently run on a weaker model than its classification
 * asked for. The chain ends at the exact strongest-available behavior above,
 * including its null → park-the-issue result when nothing is configured.
 */

const REVIEWER_DRIVER = "claudeAgent";
const CODEX_DRIVER = "codex";

function isOpusSlug(slug: string): boolean {
  return slug.toLowerCase().includes("opus");
}

function findAvailableProvider(
  providers: ReadonlyArray<ServerProvider>,
  driver: string,
): ServerProvider | undefined {
  return providers.find(
    (provider) =>
      provider.driver === driver &&
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider),
  );
}

function findModelBySlugKeyword(
  provider: ServerProvider | undefined,
  keyword: string,
): ModelSelection | null {
  if (!provider) return null;
  const model = provider.models.find((entry) => entry.slug.toLowerCase().includes(keyword));
  return model === undefined ? null : { instanceId: provider.instanceId, model: model.slug };
}

/**
 * The reviewer's model, or null when no usable Claude provider is configured —
 * in which case the caller parks the issue rather than reviewing it with
 * whatever happens to be around.
 */
export function resolveReviewerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const claude = findAvailableProvider(providers, REVIEWER_DRIVER);
  if (!claude) return null;

  const opus = claude.models.find((model) => isOpusSlug(model.slug));
  // A Claude install with no Opus at all (a custom-model-only setup) still
  // reviews, on whatever it does expose, rather than blocking the run.
  const model = opus ?? claude.models[0];
  if (!model) return null;

  return { instanceId: claude.instanceId, model: model.slug };
}

/**
 * The reviewer's model for a classified complexity tier, falling upward when a
 * tier's class is not available:
 *
 * - trivial:  Claude Haiku, else a Codex mini model when no Claude provider is
 *             usable at all, else the standard tier.
 * - standard: Claude Sonnet, else the complex tier.
 * - complex:  exactly `resolveReviewerModelSelection` — the current strongest
 *             behavior, null when nothing is configured.
 *
 * Codex only participates when no suitable Claude model exists: a Claude
 * install without a Haiku falls up to Sonnet rather than sideways to another
 * provider, so the fallback direction stays strictly upward in strength.
 */
export function resolveTieredReviewerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  tier: IssueReviewComplexityTier,
): ModelSelection | null {
  const claude = findAvailableProvider(providers, REVIEWER_DRIVER);

  if (tier === "trivial") {
    const haiku = findModelBySlugKeyword(claude, "haiku");
    if (haiku) return haiku;
    if (!claude) {
      const mini = findModelBySlugKeyword(findAvailableProvider(providers, CODEX_DRIVER), "mini");
      if (mini) return mini;
    }
  }

  if (tier === "trivial" || tier === "standard") {
    const sonnet = findModelBySlugKeyword(claude, "sonnet");
    if (sonnet) return sonnet;
  }

  return resolveReviewerModelSelection(providers);
}

/**
 * The model the complexity classifier itself runs on: the cheapest configured
 * model, because the classification must cost almost nothing next to the
 * review it sizes. Null when no cheap class exists anywhere, in which case the
 * caller skips classification and reviews on the safe (complex) tier instead
 * of burning a strong model on triage.
 */
export function resolveReviewClassifierModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  return (
    findModelBySlugKeyword(findAvailableProvider(providers, REVIEWER_DRIVER), "haiku") ??
    findModelBySlugKeyword(findAvailableProvider(providers, CODEX_DRIVER), "mini")
  );
}
