import {
  IssueReviewBlock,
  ISSUE_REVIEW_BLOCK_LANGUAGE,
  type IssueReviewNotes,
  type IssueReviewVerdict,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { extractFencedBlocks } from "./fencedBlocks.ts";

/**
 * A reviewer agent closes its final message with one fenced ```t3-review block
 * carrying its verdict and notes. This module turns that message into a
 * verdict and nothing else — no dispatching, no clock, no ids — so the whole
 * decision surface is exercised in tests.
 *
 * Nothing here ever fails: a missing or malformed block is a *result* the
 * caller turns into a needs-attention flag, because a reviewer that garbled
 * its output has still told us the work is not safely merged.
 */

export type IssueReviewParseResult =
  | {
      readonly kind: "parsed";
      readonly verdict: IssueReviewVerdict;
      readonly notes: IssueReviewNotes;
    }
  /** No block, bad JSON, or wrong shape — `detail` is user-facing. */
  | { readonly kind: "invalid"; readonly detail: string };

// One decode does both jobs: parse the JSON text and validate its shape, so a
// syntax error and a wrong shape surface through the same reported detail.
const decodeBlock = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueReviewBlock));

export const parseIssueReview = Effect.fn("parseIssueReview")(function* (
  markdown: string,
): Effect.fn.Return<IssueReviewParseResult> {
  const blocks = extractFencedBlocks(markdown, ISSUE_REVIEW_BLOCK_LANGUAGE);
  if (blocks.length === 0) {
    return {
      kind: "invalid",
      detail: `The reviewer finished without a ${ISSUE_REVIEW_BLOCK_LANGUAGE} block, so its verdict is unknown.`,
    } as const;
  }
  if (blocks.length > 1) {
    return {
      kind: "invalid",
      detail: `The reviewer emitted ${blocks.length} ${ISSUE_REVIEW_BLOCK_LANGUAGE} blocks; expected exactly one.`,
    } as const;
  }

  const decoded = yield* decodeBlock(blocks[0] ?? "").pipe(
    Effect.map((block) => ({ ok: true as const, block })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
  );
  if (!decoded.ok) {
    return {
      kind: "invalid",
      detail: `The reviewer's ${ISSUE_REVIEW_BLOCK_LANGUAGE} block could not be read: ${decoded.message}`,
    } as const;
  }

  return {
    kind: "parsed",
    verdict: decoded.block.verdict,
    notes: decoded.block.notes,
  } as const;
});
