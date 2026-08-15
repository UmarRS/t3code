import {
  CommandId,
  ProjectId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { deriveProjectLinkViews } from "@t3tools/shared/projectLinks";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FRONTEND_ID = ProjectId.make("project-frontend");
const BACKEND_ID = ProjectId.make("project-backend");
const FRONTEND_ROOT = "/repos/smartcanvass-fe";
const BACKEND_ROOT = "/repos/smartcanvass-be";

const invariantDetail = (error: { readonly _tag: string }): string => {
  expect(error._tag).toBe("OrchestrationCommandInvariantError");
  return (error as unknown as { readonly detail: string }).detail;
};

const project = (
  id: ProjectId,
  workspaceRoot: string,
  overrides: Partial<OrchestrationProject> = {},
): OrchestrationProject => ({
  id,
  title: workspaceRoot.split("/").at(-1) ?? id,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const link = (id: string, path: string, description: string): ProjectLink => ({
  id,
  path,
  description,
  createdAt: NOW,
});

const readModel = (projects: ReadonlyArray<OrchestrationProject>): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects,
  threads: [],
  issues: [],
  updatedAt: NOW,
});

const decide = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  model: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({ command, readModel: model }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

/** Decide a command and fold its events back onto the model, as the engine does. */
const apply = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  model: OrchestrationReadModel,
) =>
  Effect.gen(function* () {
    const events = yield* decide(command, model);
    let next = model;
    let sequence = model.snapshotSequence;
    for (const event of events) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence }).pipe(Effect.orDie);
    }
    return next;
  });

const addLink = (input: {
  readonly projectId: ProjectId;
  readonly linkId: string;
  readonly path: string;
  readonly description?: string;
}) =>
  ({
    type: "project.link.add",
    commandId: CommandId.make(`cmd-add-${input.linkId}`),
    projectId: input.projectId,
    linkId: input.linkId,
    path: input.path,
    description: input.description ?? "backend for all smartcanvass APIs",
    createdAt: NOW,
  }) as const;

const removeLink = (projectId: ProjectId, linkId: string) =>
  ({
    type: "project.link.remove",
    commandId: CommandId.make(`cmd-remove-${linkId}`),
    projectId,
    linkId,
  }) as const;

it.layer(NodeServices.layer)("project link decider", (it) => {
  describe("project.link.add", () => {
    it.effect("stores the link on the project that created it", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: BACKEND_ROOT }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT), project(BACKEND_ID, BACKEND_ROOT)]),
        );

        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("project.link-added");
        if (events[0]?.type !== "project.link-added") return;
        expect(events[0].aggregateKind).toBe("project");
        expect(events[0].aggregateId).toBe(FRONTEND_ID);
        expect(events[0].payload.projectId).toBe(FRONTEND_ID);
        expect(events[0].payload.link).toEqual({
          id: "link-1",
          path: BACKEND_ROOT,
          description: "backend for all smartcanvass APIs",
          createdAt: NOW,
        });
      }),
    );

    it.effect("accepts a folder that is not a registered project", () =>
      Effect.gen(function* () {
        const events = yield* decide(
          addLink({
            projectId: FRONTEND_ID,
            linkId: "link-1",
            path: "/repos/design-tokens",
            description: "shared design tokens, read only",
          }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT)]),
        );

        expect(events[0]?.type).toBe("project.link-added");
      }),
    );

    it.effect("rejects a path this project already links", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-2", path: `${BACKEND_ROOT}/` }),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT, {
              links: [link("link-1", BACKEND_ROOT, "the backend")],
            }),
          ]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("already linked");
      }),
    );

    it.effect("rejects a second edge between the same pair of projects", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: BACKEND_ID, linkId: "link-2", path: FRONTEND_ROOT }),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT, {
              links: [link("link-1", BACKEND_ROOT, "the backend")],
            }),
            project(BACKEND_ID, BACKEND_ROOT),
          ]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("already linked");
      }),
    );

    it.effect("rejects linking the project's own workspace root", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: FRONTEND_ROOT }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT)]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("own workspace root");
      }),
    );

    it.effect("rejects a link id that already exists on another project", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: "/repos/other" }),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT),
            project(BACKEND_ID, BACKEND_ROOT, {
              links: [link("link-1", "/repos/somewhere", "somewhere")],
            }),
          ]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("already exists");
      }),
    );

    it.effect("rejects a link on a deleted project", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: BACKEND_ROOT }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT, { deletedAt: NOW })]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("is deleted");
      }),
    );

    it.effect("caps the number of links per project", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          addLink({ projectId: FRONTEND_ID, linkId: "link-17", path: "/repos/one-too-many" }),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT, {
              links: Array.from({ length: 16 }, (_, index) =>
                link(`link-${index}`, `/repos/linked-${index}`, `linked ${index}`),
              ),
            }),
          ]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("maximum");
      }),
    );
  });

  describe("mirroring", () => {
    it.effect("derives the mirror on a linked registered project", () =>
      Effect.gen(function* () {
        const next = yield* apply(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: BACKEND_ROOT }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT), project(BACKEND_ID, BACKEND_ROOT)]),
        );

        const backend = next.projects.find((entry) => entry.id === BACKEND_ID)!;
        expect(backend.links ?? []).toEqual([]);

        const views = deriveProjectLinkViews({ project: backend, projects: next.projects });
        expect(views).toHaveLength(1);
        expect(views[0]?.mirrored).toBe(true);
        expect(views[0]?.ownerProjectId).toBe(FRONTEND_ID);
        expect(views[0]?.path).toBe(FRONTEND_ROOT);
        expect(views[0]?.targetProjectId).toBe(FRONTEND_ID);
        expect(views[0]?.description).toContain("backend for all smartcanvass APIs");

        const owned = deriveProjectLinkViews({
          project: next.projects.find((entry) => entry.id === FRONTEND_ID)!,
          projects: next.projects,
        });
        expect(owned).toHaveLength(1);
        expect(owned[0]?.mirrored).toBe(false);
        expect(owned[0]?.targetProjectId).toBe(BACKEND_ID);
      }),
    );

    it.effect("leaves a context-only folder with no target project", () =>
      Effect.gen(function* () {
        const next = yield* apply(
          addLink({ projectId: FRONTEND_ID, linkId: "link-1", path: "/repos/design-tokens" }),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT)]),
        );

        const views = deriveProjectLinkViews({
          project: next.projects[0]!,
          projects: next.projects,
        });
        expect(views[0]?.targetProjectId).toBeNull();
      }),
    );
  });

  describe("project.link.remove", () => {
    it.effect("removes a link from the project that owns it", () =>
      Effect.gen(function* () {
        const next = yield* apply(
          removeLink(FRONTEND_ID, "link-1"),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT, {
              links: [link("link-1", BACKEND_ROOT, "the backend")],
            }),
            project(BACKEND_ID, BACKEND_ROOT),
          ]),
        );

        expect(next.projects.find((entry) => entry.id === FRONTEND_ID)?.links).toEqual([]);
      }),
    );

    it.effect("removes the stored edge when the mirrored side removes it", () =>
      Effect.gen(function* () {
        const model = readModel([
          project(FRONTEND_ID, FRONTEND_ROOT, {
            links: [link("link-1", BACKEND_ROOT, "the backend")],
          }),
          project(BACKEND_ID, BACKEND_ROOT),
        ]);

        const events = yield* decide(removeLink(BACKEND_ID, "link-1"), model);
        expect(events[0]?.type).toBe("project.link-removed");
        if (events[0]?.type !== "project.link-removed") return;
        expect(events[0].payload.projectId).toBe(FRONTEND_ID);

        const next = yield* apply(removeLink(BACKEND_ID, "link-1"), model);
        expect(next.projects.find((entry) => entry.id === FRONTEND_ID)?.links).toEqual([]);
        expect(
          deriveProjectLinkViews({
            project: next.projects.find((entry) => entry.id === BACKEND_ID)!,
            projects: next.projects,
          }),
        ).toEqual([]);
      }),
    );

    it.effect("rejects removing a link the project neither owns nor mirrors", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          removeLink(BACKEND_ID, "link-1"),
          readModel([
            project(FRONTEND_ID, FRONTEND_ROOT, {
              links: [link("link-1", "/repos/elsewhere", "elsewhere")],
            }),
            project(BACKEND_ID, BACKEND_ROOT),
          ]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("does not exist");
      }),
    );

    it.effect("rejects an unknown link id", () =>
      Effect.gen(function* () {
        const error = yield* decide(
          removeLink(FRONTEND_ID, "link-missing"),
          readModel([project(FRONTEND_ID, FRONTEND_ROOT)]),
        ).pipe(Effect.flip);

        expect(invariantDetail(error)).toContain("does not exist");
      }),
    );
  });
});
