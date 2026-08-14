/**
 * Classification of provider failures that mean "this account cannot do more
 * work right now" — exhausted rate limits, spent credits/quota, or a
 * plan/subscription that no longer grants access. Only this class of failure
 * may trigger automatic model failover; every other provider error keeps its
 * normal handling. All string matching for that decision lives here so call
 * sites never pattern-match provider error text themselves.
 *
 * @module providerExhaustion
 */

export type ProviderExhaustionKind = "rate-limit" | "quota-billing" | "plan-auth";

// Matched against lowercased failure text. Patterns are deliberately narrow:
// a false positive silently reroutes work to another provider, which is worse
// than a missed failover (that just leaves the existing needs-attention flow).
const RATE_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /usage limit reached/,
  /reached your (usage|session|weekly|monthly) limit/,
  /hit your usage limit/,
  /\busage limit\b.*\bresets?\b/,
  /\b(5|five)-hour limit/,
  /weekly limit reached/,
  /session limit reached/,
  /rate[_ ]limit[_ ]error/,
  /rate limit (reached|exceeded|exhausted)/,
  /exceeded.*rate limit/,
  /too many requests/,
  /\b429\b.*(rate|limit|request)/,
  /(rate|limit|request).*\b429\b/,
  /out of extra usage/,
];

const QUOTA_BILLING_PATTERNS: ReadonlyArray<RegExp> = [
  /credit balance is too low/,
  /insufficient (credit|credits|funds|quota)/,
  /out of credits/,
  /no credits remaining/,
  /exceeded your (current )?quota/,
  /quota (exceeded|exhausted)/,
  /billing[_ ]error/,
  /payment required/,
  /\b402\b/,
];

const PLAN_AUTH_PATTERNS: ReadonlyArray<RegExp> = [
  /subscription (has )?(expired|ended|lapsed)/,
  /plan (has )?(expired|ended|lapsed)/,
  /(does not|doesn't) include.*(usage|access)/,
  /requires an? (active )?(subscription|plan|upgrade)/,
  /upgrade your plan/,
  /oauth token (has )?expired.*(plan|subscription|billing)/,
];

/**
 * Classify provider failure text as credit/limit exhaustion, or null when the
 * failure is anything else (crash, tool error, network, invalid request, …).
 */
export function classifyProviderExhaustion(
  detail: string | null | undefined,
): ProviderExhaustionKind | null {
  const normalized = detail?.toLowerCase() ?? "";
  if (normalized.length === 0) {
    return null;
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "rate-limit";
  }
  if (QUOTA_BILLING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "quota-billing";
  }
  if (PLAN_AUTH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "plan-auth";
  }
  return null;
}

/** Short human phrase for a classified exhaustion kind. */
export function describeProviderExhaustionKind(kind: ProviderExhaustionKind): string {
  switch (kind) {
    case "rate-limit":
      return "hit its usage/rate limit";
    case "quota-billing":
      return "ran out of credits/quota";
    case "plan-auth":
      return "lost plan access";
  }
}
