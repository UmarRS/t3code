/**
 * ModelFailoverService - Recovery from provider credit/limit exhaustion.
 *
 * When a thread's turn fails because the provider account cannot do more work
 * right now (and only for that class of failure), this service decides how the
 * thread gets going again. It prefers waiting: a rate limit that names when it
 * lifts parks the thread until then and restarts the interrupted turn on the
 * same provider session, so the agent continues with its context intact. Only
 * when no reset instant is known does it fall back to switching the thread to
 * the fixed codex backup model, which restarts the turn in a fresh session.
 *
 * At most one automatic failover happens per attempt: once the thread runs on
 * the codex backup there is no further backup, so a backup failure follows the
 * normal needs-attention path (enriched to mention both attempts).
 *
 * @module ModelFailoverService
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** What a provider-exhaustion failure was turned into. */
export type ProviderExhaustionRecovery =
  /** Thread parked; the turn restarts by itself at `resumeAt`. */
  | { readonly kind: "parked"; readonly resumeAt: string }
  /** Thread switched to the codex backup and the turn already restarted. */
  | { readonly kind: "failed-over"; readonly model: string }
  /** Not exhaustion, or nothing could be done — the error path stands. */
  | { readonly kind: "none" };

/**
 * ModelFailoverShape - Service API for exhaustion-triggered recovery.
 */
export interface ModelFailoverShape {
  /**
   * Decide and apply recovery for a provider failure. Returns "none" for every
   * failure that is not credit/limit exhaustion, and for exhaustion that no
   * strategy can act on (including internal errors, which are logged, never
   * thrown) — in those cases the caller's error state stands unchanged.
   */
  readonly recoverFromExhaustion: (input: {
    readonly threadId: ThreadId;
    /** Full failure text used for exhaustion classification. */
    readonly failureDetail: string;
    readonly createdAt: string;
  }) => Effect.Effect<ProviderExhaustionRecovery>;

  /**
   * Restart the interrupted turn of a parked thread on its current model,
   * clearing the park. Used by the resume ticker when a limit lifts, and by the
   * client's "resume now" affordance to skip the wait. The thread's own last
   * user message is what restarts, so a turn whose message carried attachments
   * comes back whole — the caller never has to supply it.
   *
   * `resumed` is false when the thread is gone, already recovering, or has no
   * user turn to restart; `sequence` is then the last sequence this call
   * reached, or 0 when it dispatched nothing at all.
   */
  readonly resumeParkedThread: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) => Effect.Effect<{ readonly resumed: boolean; readonly sequence: number }>;

  /**
   * Append prior-failover context to a failure detail, so a failure of the
   * codex backup surfaces both attempts. Returns the detail unchanged when
   * the thread has no recorded failover or no longer runs the backup model.
   */
  readonly withFailoverContext: (threadId: ThreadId, detail: string) => Effect.Effect<string>;
}

/**
 * ModelFailoverService - Service tag for exhaustion recovery coordination.
 */
export class ModelFailoverService extends Context.Service<
  ModelFailoverService,
  ModelFailoverShape
>()("t3/orchestration/Services/ModelFailover/ModelFailoverService") {}
