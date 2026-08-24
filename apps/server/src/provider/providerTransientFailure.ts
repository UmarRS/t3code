/**
 * Classification of provider failures that mean "the provider stumbled, ask
 * again" — an overloaded upstream, a 5xx, a gateway that gave up. These are
 * nobody's judgement about the work: an agent whose turn dies this way has not
 * said anything, so a caller must retry rather than read a result into the
 * silence.
 *
 * Deliberately narrow, and deliberately separate from
 * {@link ./providerExhaustion.ts}: an exhausted account (429/quota/plan) has
 * its own recovery path in `ModelFailover`, and must never be pulled into a
 * retry loop here.
 *
 * @module providerTransientFailure
 */
import { classifyProviderExhaustion } from "./providerExhaustion.ts";

/**
 * Longest message still treated as "nothing but an error". A provider error
 * surfaced as agent text is one line; a real answer that mentions an error is
 * prose around it. The word check below is the real gate — this only keeps the
 * scan cheap.
 */
const MAX_TRANSIENT_FAILURE_LENGTH = 400;

// At least one of these has to be present for the message to be about a
// transient failure at all. `529` is Anthropic's overloaded status; the rest
// are the ordinary gateway family.
const TRANSIENT_MARKERS: ReadonlyArray<RegExp> = [
  /\b5(?:00|02|03|04|29)\b/,
  /\boverloaded\b/,
  /\binternal server error\b/,
  /\bbad gateway\b/,
  /\bservice unavailable\b/,
  /\bgateway time ?out\b/,
];

/**
 * Every word these errors are built from. The message must consist of nothing
 * else — that is what makes the classifier conservative: one sentence of an
 * agent's own prose around a quoted error leaves a word behind here, and the
 * message is not classified as a failure.
 */
const ERROR_VOCABULARY: ReadonlySet<string> = new Set([
  // Shapes: `API Error: 529 Overloaded`, `Error: 503 Service Unavailable`.
  "api",
  "error",
  "errors",
  "failed",
  "failure",
  "http",
  "https",
  "status",
  "code",
  "request",
  "requests",
  "response",
  "provider",
  "upstream",
  "server",
  "service",
  "gateway",
  "internal",
  "unavailable",
  "overloaded",
  "bad",
  "timeout",
  "timed",
  "out",
  "temporarily",
  "temporary",
  "unexpected",
  "occurred",
  "retry",
  "again",
  "later",
  "please",
  "try",
  "sorry",
  // JSON envelopes: `{"type":"error","error":{"type":"overloaded_error"}}`.
  "type",
  "message",
  "detail",
  "details",
  "param",
  "reason",
  "id",
  "null",
  "true",
  "false",
  // Connective tissue. Content words stay out on purpose.
  "a",
  "an",
  "the",
  "is",
  "was",
  "and",
  "or",
  "at",
  "on",
  "of",
  "to",
  "in",
  "for",
  "from",
  "with",
  "this",
  "that",
  "it",
  "we",
  "you",
  "your",
]);

/**
 * Strip the decoration an agent puts around a bare error — a fenced block,
 * backticks, a bullet — so the words underneath can be checked directly.
 */
function normalizeFailureText(detail: string): string {
  return detail
    .replaceAll(/```[a-z0-9-]*/gi, " ")
    .replaceAll(/[`*_>#|]/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether `detail` is a transient provider failure and nothing else.
 *
 * `false` for anything with content of its own, including a real answer that
 * happens to quote an error: a missed classification costs one retry that was
 * never scheduled, while a false positive throws away work somebody did.
 */
export function isTransientProviderFailure(detail: string | null | undefined): boolean {
  const normalized = normalizeFailureText(detail ?? "");
  if (normalized.length === 0 || normalized.length > MAX_TRANSIENT_FAILURE_LENGTH) {
    return false;
  }
  // An exhausted account is not this: it parks and resumes on its own.
  if (classifyProviderExhaustion(normalized) !== null) {
    return false;
  }
  if (!TRANSIENT_MARKERS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  const words = normalized.split(/[^a-z]+/).filter((word) => word.length > 0);
  return words.every((word) => ERROR_VOCABULARY.has(word));
}
