import { assert, it } from "@effect/vitest";

import {
  classifyProviderExhaustion,
  describeProviderExhaustionKind,
  parseProviderExhaustionResetAt,
} from "./providerExhaustion.ts";

it("classifies rate-limit exhaustion", () => {
  assert.equal(
    classifyProviderExhaustion("Claude AI usage limit reached|1755100800"),
    "rate-limit",
  );
  assert.equal(
    classifyProviderExhaustion("You've reached your usage limit. Your limit resets at 3pm."),
    "rate-limit",
  );
  // The CLI banner shape. "session"/"hit your" is the pairing that used to
  // fall through as a generic error, leaving the thread with no recovery.
  assert.equal(
    classifyProviderExhaustion("You've hit your session limit · resets 12:10am (America/Detroit)"),
    "rate-limit",
  );
  assert.equal(
    classifyProviderExhaustion("You've hit your weekly limit · resets 9pm (America/Detroit)"),
    "rate-limit",
  );
  assert.equal(classifyProviderExhaustion("5-hour limit reached"), "rate-limit");
  assert.equal(classifyProviderExhaustion("Weekly limit reached for Claude"), "rate-limit");
  assert.equal(
    classifyProviderExhaustion('API Error: 429 {"type":"rate_limit_error"}'),
    "rate-limit",
  );
  assert.equal(
    classifyProviderExhaustion("Request failed: rate limit exceeded, retry later"),
    "rate-limit",
  );
  assert.equal(classifyProviderExhaustion("HTTP 429 Too Many Requests"), "rate-limit");
  assert.equal(classifyProviderExhaustion("You are out of extra usage."), "rate-limit");
});

it("classifies quota/billing exhaustion", () => {
  assert.equal(
    classifyProviderExhaustion(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.",
    ),
    "quota-billing",
  );
  assert.equal(classifyProviderExhaustion("insufficient credits remaining"), "quota-billing");
  assert.equal(classifyProviderExhaustion("You exceeded your current quota"), "quota-billing");
  assert.equal(classifyProviderExhaustion("billing_error: payment required"), "quota-billing");
});

it("classifies plan/auth exhaustion", () => {
  assert.equal(classifyProviderExhaustion("Your subscription has expired."), "plan-auth");
  assert.equal(
    classifyProviderExhaustion("This model requires a subscription upgrade."),
    "plan-auth",
  );
  assert.equal(
    classifyProviderExhaustion("OAuth token has expired for your plan; renew billing to continue"),
    "plan-auth",
  );
});

it("does not classify ordinary provider failures as exhaustion", () => {
  assert.isNull(classifyProviderExhaustion(null));
  assert.isNull(classifyProviderExhaustion(undefined));
  assert.isNull(classifyProviderExhaustion(""));
  assert.isNull(classifyProviderExhaustion("Failed to start Claude runtime session."));
  assert.isNull(classifyProviderExhaustion("Claude runtime stream failed."));
  assert.isNull(classifyProviderExhaustion("Tool call failed: command exited with code 1"));
  assert.isNull(classifyProviderExhaustion("network timeout while contacting api.anthropic.com"));
  assert.isNull(classifyProviderExhaustion("Invalid request: model not found"));
  assert.isNull(classifyProviderExhaustion("500 internal server error"));
  // Numbers that merely contain 429 must not trip the rate-limit patterns.
  assert.isNull(classifyProviderExhaustion("wrote file chunk-4290.txt"));
  // An interrupted turn is not exhaustion.
  assert.isNull(classifyProviderExhaustion("Claude runtime interrupted."));
});

// 2026-08-16T21:48:00-04:00 — an evening in Detroit, so "12:10am" is the
// small hours of the next day and "3pm" already passed today.
const NOW_MS = Date.parse("2026-08-17T01:48:00.000Z");

it("reads the reset instant out of a rate-limit banner", () => {
  assert.equal(
    parseProviderExhaustionResetAt(
      "You've hit your session limit · resets 12:10am (America/Detroit)",
      NOW_MS,
    ),
    Date.parse("2026-08-17T04:10:00.000Z"),
  );
  // Already past today in Detroit, so it belongs to tomorrow.
  assert.equal(
    parseProviderExhaustionResetAt(
      "You've hit your usage limit · resets 3pm (America/Detroit)",
      NOW_MS,
    ),
    Date.parse("2026-08-17T19:00:00.000Z"),
  );
  // 24-hour locales quote the same banner without a meridiem.
  assert.equal(
    parseProviderExhaustionResetAt(
      "You've hit your weekly limit · resets 15:30 (Europe/Berlin)",
      NOW_MS,
    ),
    Date.parse("2026-08-17T13:30:00.000Z"),
  );
});

it("prefers the machine-readable epoch reset when present", () => {
  assert.equal(
    parseProviderExhaustionResetAt("Claude AI usage limit reached|1786950000", NOW_MS),
    1786950000 * 1000,
  );
});

it("returns no reset instant when the failure names none", () => {
  assert.isNull(parseProviderExhaustionResetAt(null, NOW_MS));
  assert.isNull(parseProviderExhaustionResetAt("", NOW_MS));
  assert.isNull(parseProviderExhaustionResetAt("HTTP 429 Too Many Requests", NOW_MS));
  assert.isNull(parseProviderExhaustionResetAt("Tool call failed: exit code 1", NOW_MS));
  // A reset stamp already in the past is stale, not a schedulable instant.
  assert.isNull(parseProviderExhaustionResetAt("Claude AI usage limit reached|1600000000", NOW_MS));
  // Nonsense clock times must not resolve to a bogus instant.
  assert.isNull(parseProviderExhaustionResetAt("resets 47:99 (America/Detroit)", NOW_MS));
  assert.isNull(parseProviderExhaustionResetAt("resets 12:10am (Not/AZone)", NOW_MS));
});

it("describes each exhaustion kind", () => {
  assert.equal(describeProviderExhaustionKind("rate-limit"), "hit its usage/rate limit");
  assert.equal(describeProviderExhaustionKind("quota-billing"), "ran out of credits/quota");
  assert.equal(describeProviderExhaustionKind("plan-auth"), "lost plan access");
});
