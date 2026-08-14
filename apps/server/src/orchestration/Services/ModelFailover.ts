/**
 * ModelFailoverService - Automatic Claude → Codex backup failover.
 *
 * When a thread's turn fails because the Claude provider exhausted its
 * credits/limits (and only for that class of failure), this service switches
 * the thread to the fixed codex backup model, records the switch in the
 * thread timeline, and restarts the failed turn in the same worktree. At most
 * one automatic failover happens per attempt: once the thread runs on the
 * codex backup there is no further backup, so a backup failure follows the
 * normal needs-attention path (enriched to mention both attempts).
 *
 * @module ModelFailoverService
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * ModelFailoverShape - Service API for exhaustion-triggered model failover.
 */
export interface ModelFailoverShape {
  /**
   * Attempt an automatic failover for a provider failure. Returns true when
   * the failure was classified as credit/limit exhaustion, the thread was
   * running a Claude model with a mapped codex backup, and the restart
   * commands were dispatched. Returns false in every other case (including
   * internal errors, which are logged, never thrown).
   */
  readonly maybeFailoverToBackup: (input: {
    readonly threadId: ThreadId;
    /** Full failure text used for exhaustion classification. */
    readonly failureDetail: string;
    readonly createdAt: string;
  }) => Effect.Effect<boolean>;

  /**
   * Append prior-failover context to a failure detail, so a failure of the
   * codex backup surfaces both attempts. Returns the detail unchanged when
   * the thread has no recorded failover or no longer runs the backup model.
   */
  readonly withFailoverContext: (threadId: ThreadId, detail: string) => Effect.Effect<string>;
}

/**
 * ModelFailoverService - Service tag for model failover coordination.
 */
export class ModelFailoverService extends Context.Service<
  ModelFailoverService,
  ModelFailoverShape
>()("t3/orchestration/Services/ModelFailover/ModelFailoverService") {}
