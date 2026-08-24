import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { AutoShipReactor } from "../Services/AutoShipReactor.ts";
import { AutonomousRunReactor } from "../Services/AutonomousRunReactor.ts";
import { AutonomousScheduleReactor } from "../Services/AutonomousScheduleReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { IssueArchiveReactor } from "../Services/IssueArchiveReactor.ts";
import { LimitResumeReactor } from "../Services/LimitResumeReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const autonomousRunReactor = yield* AutonomousRunReactor;
  const autoShipReactor = yield* AutoShipReactor;
  const autonomousScheduleReactor = yield* AutonomousScheduleReactor;
  const limitResumeReactor = yield* LimitResumeReactor;
  const issueArchiveReactor = yield* IssueArchiveReactor;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* autonomousRunReactor.start();
    yield* autoShipReactor.start();
    yield* autonomousScheduleReactor.start();
    yield* limitResumeReactor.start();
    yield* issueArchiveReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
