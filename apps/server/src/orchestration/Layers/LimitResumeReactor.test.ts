import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { ModelFailoverService } from "../Services/ModelFailover.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { LimitResumeReactor } from "../Services/LimitResumeReactor.ts";
import { LimitResumeReactorLive } from "./LimitResumeReactor.ts";

const THREAD_A = ThreadId.make("thread-a");
/** Parked, but with no user turn left to restart — the ticker must not count it. */
const THREAD_B = ThreadId.make("thread-b");
const DUE_AT = "2026-08-17T04:10:00.000Z";

function createHarness(options?: {
  readonly due?: ReadonlyArray<ThreadId>;
  readonly dueFails?: boolean;
  readonly resumeFails?: boolean;
}) {
  const dueCalls: string[] = [];
  const listThreadIdsDueForResume = vi.fn((now: string) => {
    dueCalls.push(now);
    return options?.dueFails === true
      ? Effect.die(new Error("projection unavailable"))
      : Effect.succeed(options?.due ?? []);
  });
  const resumeParkedThread = vi.fn((input: { readonly threadId: ThreadId }) =>
    options?.resumeFails === true
      ? Effect.die(new Error("resume blew up"))
      : Effect.succeed({ resumed: input.threadId !== THREAD_B, sequence: 7 }),
  );

  const layer = LimitResumeReactorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({ listThreadIdsDueForResume }),
        Layer.mock(ModelFailoverService)({ resumeParkedThread }),
      ),
    ),
  );

  const runDueAt = (at: string) =>
    Effect.flatMap(Effect.service(LimitResumeReactor), (reactor) =>
      reactor.runDueAt(DateTime.toDate(DateTime.makeUnsafe(at))),
    ).pipe(Effect.provide(layer));

  return { runDueAt, listThreadIdsDueForResume, resumeParkedThread, dueCalls };
}

describe("LimitResumeReactor", () => {
  it.effect("resumes every thread whose park is due at the evaluated instant", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [THREAD_A] });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(1);
      expect(harness.dueCalls).toEqual([DUE_AT]);
      expect(harness.resumeParkedThread).toHaveBeenCalledWith({
        threadId: THREAD_A,
        createdAt: DUE_AT,
      });
    }),
  );

  it.effect("does nothing when no park is due", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [] });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
      expect(harness.resumeParkedThread).not.toHaveBeenCalled();
    }),
  );

  it.effect("counts only the threads that actually restarted", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [THREAD_A, THREAD_B] });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(1);
      expect(harness.resumeParkedThread).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("survives a projection read that fails", () =>
    Effect.gen(function* () {
      const harness = createHarness({ dueFails: true });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
    }),
  );

  it.effect("survives a resume that fails, so one bad thread cannot stop the ticker", () =>
    Effect.gen(function* () {
      const harness = createHarness({ due: [THREAD_A], resumeFails: true });

      expect(yield* harness.runDueAt(DUE_AT)).toBe(0);
    }),
  );
});
