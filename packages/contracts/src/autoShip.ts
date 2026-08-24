import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Activity kind for what auto-ship did at the end of a turn. Rides the
 * existing `thread.activity.append` channel, like `linked-project.agent` and
 * `model.failover`, so it streams into an open thread without widening the
 * thread-detail event allowlist in `ws.ts`.
 *
 * Every ship that does anything writes one of these. A ship that finds nothing
 * to send writes nothing at all: most turns change no code, and a timeline
 * that says "nothing to ship" after each of them is noise, not a record.
 */
export const THREAD_AUTO_SHIP_ACTIVITY_KIND = "thread.auto-ship";

/**
 * How a ship ended.
 *
 * `merged` is the whole point. `opened` means the pull request exists but the
 * merge was refused — a required check, a conflict, a branch protection rule —
 * so the work is on the remote and a human finishes it. `failed` means nothing
 * landed anywhere.
 */
export const ThreadAutoShipOutcome = Schema.Literals(["merged", "opened", "failed"]);
export type ThreadAutoShipOutcome = typeof ThreadAutoShipOutcome.Type;

/**
 * Payload of the {@link THREAD_AUTO_SHIP_ACTIVITY_KIND} activity. Typed rather
 * than free-form JSON because the timeline links the pull request, and because
 * `detail` is the only place a refused merge explains itself.
 */
export const ThreadAutoShipActivityPayload = Schema.Struct({
  outcome: ThreadAutoShipOutcome,
  pullRequestUrl: Schema.optional(Schema.String),
  /** Present whenever the ship did not reach `merged`. */
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadAutoShipActivityPayload = typeof ThreadAutoShipActivityPayload.Type;
