import { assert, it } from "@effect/vitest";

import {
  classifyProviderExhaustion,
  describeProviderExhaustionKind,
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

it("describes each exhaustion kind", () => {
  assert.equal(describeProviderExhaustionKind("rate-limit"), "hit its usage/rate limit");
  assert.equal(describeProviderExhaustionKind("quota-billing"), "ran out of credits/quota");
  assert.equal(describeProviderExhaustionKind("plan-auth"), "lost plan access");
});
