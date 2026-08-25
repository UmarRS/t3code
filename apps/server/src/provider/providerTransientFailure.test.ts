import { assert, it } from "@effect/vitest";

import { isTransientProviderFailure } from "./providerTransientFailure.ts";

it("classifies a bare provider error as transient", () => {
  // The exact text that ended three reviewer turns on 24 Aug 2026.
  assert.equal(isTransientProviderFailure("API Error: 529 Overloaded"), true);
  assert.equal(isTransientProviderFailure("Overloaded"), true);
  assert.equal(isTransientProviderFailure("overloaded_error"), true);
  assert.equal(isTransientProviderFailure("internal_server_error"), true);
  assert.equal(isTransientProviderFailure("502 Bad Gateway"), true);
  assert.equal(isTransientProviderFailure("503 Service Unavailable"), true);
  assert.equal(isTransientProviderFailure("504 Gateway Timeout"), true);
  assert.equal(isTransientProviderFailure("Error: 500 Internal Server Error"), true);
  assert.equal(isTransientProviderFailure("Request failed with status code 502"), true);
  assert.equal(
    isTransientProviderFailure(
      'API Error: 500 {"type":"error","error":{"type":"internal_server_error","message":"Internal server error"}}',
    ),
    true,
  );
  // Decorated the way an agent tends to surface it.
  assert.equal(isTransientProviderFailure("`API Error: 529 Overloaded`"), true);
  assert.equal(isTransientProviderFailure("```\nAPI Error: 529 Overloaded\n```"), true);
});

it("does not classify a real answer that quotes an error", () => {
  // The whole reason the classifier reads every word: a reviewer may legitimately
  // report an error it saw, and that is a review, not a failure.
  assert.equal(
    isTransientProviderFailure(
      "The retry handler swallows `API Error: 529 Overloaded` instead of retrying. I fixed it and merged the pull request.",
    ),
    false,
  );
  assert.equal(
    isTransientProviderFailure(
      '```t3-review\n{"verdict":"merged","notes":"The 503 handling in the client is now covered by a test."}\n```',
    ),
    false,
  );
  assert.equal(
    isTransientProviderFailure("The tests pass and the branch is rebased onto main."),
    false,
  );
});

it("does not classify an exhausted account, which recovers on its own", () => {
  assert.equal(isTransientProviderFailure("Claude AI usage limit reached|1755100800"), false);
  assert.equal(isTransientProviderFailure('API Error: 429 {"type":"rate_limit_error"}'), false);
  assert.equal(isTransientProviderFailure("Your credit balance is too low"), false);
});

it("does not classify failures outside the transient family", () => {
  assert.equal(isTransientProviderFailure(null), false);
  assert.equal(isTransientProviderFailure(undefined), false);
  assert.equal(isTransientProviderFailure(""), false);
  assert.equal(isTransientProviderFailure("   "), false);
  assert.equal(isTransientProviderFailure("API Error: 400 Bad Request"), false);
  assert.equal(isTransientProviderFailure("API Error: 404 Not Found"), false);
  assert.equal(isTransientProviderFailure("Command failed: git push"), false);
});

it("does not classify a long message that only starts with an error", () => {
  const prose = `API Error: 529 Overloaded. ${"Reviewing the diff took several passes because the branch had drifted. ".repeat(6)}`;
  assert.equal(isTransientProviderFailure(prose), false);
});
