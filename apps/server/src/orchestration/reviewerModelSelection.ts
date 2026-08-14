import { isProviderAvailable, type ModelSelection, type ServerProvider } from "@t3tools/contracts";

/**
 * Picking the reviewer's model. Reviewing is the step that decides whether work
 * lands on main unsupervised, so it deliberately does not inherit the worker's
 * model: it always runs on the strongest Opus the Claude adapter exposes.
 *
 * "Strongest" is the adapter's own catalog order, which lists models newest
 * first — so the first Opus in the list is the current one. Reading the order
 * rather than hard-coding a slug means a new Opus is picked up the moment the
 * adapter learns about it.
 */

const REVIEWER_DRIVER = "claudeAgent";

function isOpusSlug(slug: string): boolean {
  return slug.toLowerCase().includes("opus");
}

/**
 * The reviewer's model, or null when no usable Claude provider is configured —
 * in which case the caller parks the issue rather than reviewing it with
 * whatever happens to be around.
 */
export function resolveReviewerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const claude = providers.find(
    (provider) =>
      provider.driver === REVIEWER_DRIVER &&
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider),
  );
  if (!claude) return null;

  const opus = claude.models.find((model) => isOpusSlug(model.slug));
  // A Claude install with no Opus at all (a custom-model-only setup) still
  // reviews, on whatever it does expose, rather than blocking the run.
  const model = opus ?? claude.models[0];
  if (!model) return null;

  return { instanceId: claude.instanceId, model: model.slug };
}
