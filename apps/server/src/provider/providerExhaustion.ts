/**
 * Classification of provider failures that mean "this account cannot do more
 * work right now" — exhausted rate limits, spent credits/quota, or a
 * plan/subscription that no longer grants access. Only this class of failure
 * may park a thread for auto-resume or trigger automatic model failover; every
 * other provider error keeps its normal handling. All string matching for that
 * decision lives here so call sites never pattern-match provider error text
 * themselves.
 *
 * @module providerExhaustion
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type ProviderExhaustionKind = "rate-limit" | "quota-billing" | "plan-auth";

// Matched against lowercased failure text. Patterns are deliberately narrow:
// a false positive silently reroutes work to another provider, which is worse
// than a missed failover (that just leaves the existing needs-attention flow).
const RATE_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /usage limit reached/,
  // Claude phrases the same wall three ways depending on which window ran out
  // ("usage", "session", "weekly") and two ways depending on tense ("reached
  // your" on the API path, "hit your" in the CLI banner). Covering the whole
  // grid here is what keeps a new window name from silently disabling recovery.
  /(reached|hit) your (usage|session|weekly|monthly|5-hour|five-hour) limit/,
  /\b(usage|session|weekly|monthly) limit\b.*\bresets?\b/,
  /\b(5|five)-hour limit/,
  /(weekly|session|monthly) limit reached/,
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

// `Claude AI usage limit reached|1755100800` — the machine-readable form, in
// epoch seconds. Preferred over the prose form whenever both are present.
const EPOCH_RESET_PATTERN = /limit reached\|(\d{10,13})\b/i;

// `resets 12:10am (America/Detroit)`, `resets at 3pm`, `· resets 9:30 PM`.
const CLOCK_12H_RESET_PATTERN =
  /\bresets?\b[^0-9]{0,12}(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\((UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)\))?/i;

// `resets 15:30 (Europe/Berlin)` — the same banner in a 24-hour locale.
const CLOCK_24H_RESET_PATTERN =
  /\bresets?\b[^0-9]{0,12}(\d{1,2}):(\d{2})(?!\s*[ap]\.?m\.?)(?:\s*\((UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)\))?/i;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Next instant matching a wall-clock time, read in `zoneId` when the provider
 * named one and in the server's own zone when it did not. Providers only ever
 * quote a clock time, never a date, so "next occurrence" is the whole rule: a
 * reset that already passed today belongs to tomorrow.
 */
function nextWallClockInstant(input: {
  readonly hours: number;
  readonly minutes: number;
  readonly zoneId: string | undefined;
  readonly nowMs: number;
}): number | null {
  if (input.hours > 23 || input.minutes > 59) {
    return null;
  }
  // "GMT" is not an IANA id; providers that quote it mean UTC. A reset with no
  // zone at all is quoted in the reader's own zone, which is the server's.
  const normalizedZoneId =
    input.zoneId === undefined
      ? undefined
      : /^(utc|gmt)$/i.test(input.zoneId)
        ? "UTC"
        : input.zoneId;
  const zone =
    normalizedZoneId === undefined
      ? Option.some(DateTime.zoneMakeLocal())
      : DateTime.zoneMakeNamed(normalizedZoneId);
  if (Option.isNone(zone)) {
    return null;
  }
  const zonedNow = DateTime.setZone(DateTime.makeUnsafe(input.nowMs), zone.value);
  const candidate = DateTime.setParts(zonedNow, {
    hour: input.hours,
    minute: input.minutes,
    second: 0,
    millisecond: 0,
  });
  const candidateMs = DateTime.toEpochMillis(candidate);
  return candidateMs > input.nowMs ? candidateMs : candidateMs + DAY_MS;
}

function twelveHourToTwentyFour(hour: number, meridiem: string): number | null {
  if (hour < 1 || hour > 12) {
    return null;
  }
  const isPm = meridiem.toLowerCase() === "p";
  if (hour === 12) {
    return isPm ? 12 : 0;
  }
  return isPm ? hour + 12 : hour;
}

/**
 * Epoch-millis instant at which an exhausted account is expected to accept work
 * again, read out of the provider's own failure text, or null when the text
 * names no reset. A known instant is what lets a thread park and resume itself
 * instead of failing over to another provider or waiting on a human.
 *
 * `nowMs` anchors the "next occurrence" reading of a bare clock time and is
 * passed in rather than read from the clock so the parse stays pure.
 */
export function parseProviderExhaustionResetAt(
  detail: string | null | undefined,
  nowMs: number,
): number | null {
  const text = detail ?? "";
  if (text.length === 0) {
    return null;
  }

  const epochMatch = EPOCH_RESET_PATTERN.exec(text);
  if (epochMatch?.[1] !== undefined) {
    const value = Number(epochMatch[1]);
    // Ten digits is seconds, thirteen is millis; both appear in the wild.
    const epochMs = epochMatch[1].length <= 10 ? value * 1000 : value;
    return Number.isFinite(epochMs) && epochMs > nowMs ? epochMs : null;
  }

  const twelveHourMatch = CLOCK_12H_RESET_PATTERN.exec(text);
  if (twelveHourMatch?.[1] !== undefined && twelveHourMatch[3] !== undefined) {
    const hours = twelveHourToTwentyFour(Number(twelveHourMatch[1]), twelveHourMatch[3]);
    if (hours !== null) {
      return nextWallClockInstant({
        hours,
        minutes: Number(twelveHourMatch[2] ?? "0"),
        zoneId: twelveHourMatch[4],
        nowMs,
      });
    }
  }

  const twentyFourHourMatch = CLOCK_24H_RESET_PATTERN.exec(text);
  if (twentyFourHourMatch?.[1] !== undefined && twentyFourHourMatch[2] !== undefined) {
    return nextWallClockInstant({
      hours: Number(twentyFourHourMatch[1]),
      minutes: Number(twentyFourHourMatch[2]),
      zoneId: twentyFourHourMatch[3],
      nowMs,
    });
  }

  return null;
}
