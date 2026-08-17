import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AutonomousRunReactor } from "../Services/AutonomousRunReactor.ts";
import { AutonomousScheduleReactor } from "../Services/AutonomousScheduleReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { IssueArchiveReactor } from "../Services/IssueArchiveReactor.ts";
import { LimitResumeReactor } from "../Services/LimitResumeReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts provider ingestion, provider command, checkpoint, thread deletion, autonomous, limit-resume, and issue archive reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AutonomousRunReactor, {
            start: () => {
              started.push("autonomous-run-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AutonomousScheduleReactor, {
            start: () => {
              started.push("autonomous-schedule-reactor");
              return Effect.void;
            },
            runDueAt: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(LimitResumeReactor, {
            start: () => {
              started.push("limit-resume-reactor");
              return Effect.void;
            },
            runDueAt: () => Effect.succeed(0),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(IssueArchiveReactor, {
            start: () => {
              started.push("issue-archive-reactor");
              return Effect.void;
            },
            runDueAt: () => Effect.succeed(0),
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "autonomous-run-reactor",
      "autonomous-schedule-reactor",
      "limit-resume-reactor",
      "issue-archive-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
