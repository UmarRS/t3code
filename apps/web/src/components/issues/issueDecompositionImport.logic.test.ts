import {
  IssueId,
  MessageId,
  ProjectId,
  type IssueDecompositionEntry,
  type IssueStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isIssueDecompositionImportApplied,
  issueIdForDecompositionEntry,
  parseIssueDecompositionForImport,
  planIssueDecompositionImport,
  type DecompositionImportIssue,
} from "./issueDecompositionImport.logic";

describe("parseIssueDecompositionForImport", () => {
  it("validates and orders stories by dependency", () => {
    const result = parseIssueDecompositionForImport(`Ready.\n\n\`\`\`t3-issues
[
  { "key": "ui", "title": "Build UI", "description": "Add the screen.", "dependsOn": ["api"] },
  { "key": "api", "title": "Build API", "description": "Add the endpoint." }
]
\`\`\``);

    expect(result?.map((entry) => entry.key)).toEqual(["api", "ui"]);
  });

  it.each([
    "plain response",
    "```t3-issues\nnot json\n```",
    '```t3-issues\n[{"key":"a","title":"A","description":"A","dependsOn":["missing"]}]\n```',
    '```t3-issues\n[{"key":"a","title":"A","description":"A","dependsOn":["b"]},{"key":"b","title":"B","description":"B","dependsOn":["a"]}]\n```',
  ])("does not offer an import for unusable output", (markdown) => {
    expect(parseIssueDecompositionForImport(markdown)).toBeNull();
  });

  // A plan that spans repositories orders itself across their boards, so a
  // dependency naming a story on another board is ordinary, importable output.
  it("orders a dependency that crosses boards", () => {
    const result = parseIssueDecompositionForImport(`\`\`\`t3-issues
[
  { "key": "ui", "title": "Build UI", "description": "Add the screen.", "project": "/repos/web-client", "dependsOn": ["api"] },
  { "key": "api", "title": "Build API", "description": "Add the endpoint." }
]
\`\`\``);

    expect(result?.map((entry) => entry.key)).toEqual(["api", "ui"]);
  });

  it("keeps a story routed to another project", () => {
    const result = parseIssueDecompositionForImport(`\`\`\`t3-issues
[
  { "key": "api", "title": "Build API", "description": "Add the endpoint." },
  { "key": "ui", "title": "Build UI", "description": "Add the screen.", "project": "/repos/web-client" }
]
\`\`\``);

    expect(result?.map((entry) => entry.project)).toEqual([undefined, "/repos/web-client"]);
  });

  // The board decides whether the id is real; the block only has to look like
  // it means an issue rather than a story it forgot to define.
  it("accepts a dependency that names an issue already on a board", () => {
    const result = parseIssueDecompositionForImport(`\`\`\`t3-issues
[
  { "key": "ui", "title": "Build UI", "description": "Add the screen.", "dependsOn": ["5f3a1c22-1111-4a11-8a11-111111111111"] }
]
\`\`\``);

    expect(result?.[0]?.dependsOn).toEqual(["5f3a1c22-1111-4a11-8a11-111111111111"]);
  });

  it("carries a revision through", () => {
    const result = parseIssueDecompositionForImport(`\`\`\`t3-issues
[
  {
    "key": "auth",
    "title": "Rework the session flow",
    "description": "One story, not three.",
    "updates": "5f3a1c22-1111-4a11-8a11-111111111111",
    "supersedes": ["5f3a1c22-2222-4a11-8a11-222222222222"]
  }
]
\`\`\``);

    expect(result?.[0]?.updates).toBe("5f3a1c22-1111-4a11-8a11-111111111111");
    expect(result?.[0]?.supersedes).toEqual(["5f3a1c22-2222-4a11-8a11-222222222222"]);
  });
});

describe("issueIdForDecompositionEntry", () => {
  const messageId = MessageId.make("8c89d464-6d37-447c-9dd4-9f4ec461dd87");

  it("is stable per message and story key", () => {
    const first = issueIdForDecompositionEntry(messageId, { key: "api" });

    expect(first).toBe(issueIdForDecompositionEntry(messageId, { key: "api" }));
    expect(first).not.toBe(issueIdForDecompositionEntry(messageId, { key: "ui" }));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps the existing id when the story rewrites one", () => {
    expect(
      issueIdForDecompositionEntry(messageId, {
        key: "api",
        updates: IssueId.make("5f3a1c22-1111-4a11-8a11-111111111111"),
      }),
    ).toBe("5f3a1c22-1111-4a11-8a11-111111111111");
  });
});

const MESSAGE = MessageId.make("8c89d464-6d37-447c-9dd4-9f4ec461dd87");
const BOARD = ProjectId.make("board");
const LINKED = ProjectId.make("linked");
const CURRENT = { id: BOARD, title: "Atlas", workspaceRoot: "/repos/atlas" };
const LINKED_PROJECTS = [{ id: LINKED, title: "web-client", workspaceRoot: "/repos/web-client" }];

const EXISTING_A = IssueId.make("5f3a1c22-1111-4a11-8a11-111111111111");
const EXISTING_B = IssueId.make("5f3a1c22-2222-4a11-8a11-222222222222");

function existing(
  id: IssueId,
  overrides: Partial<DecompositionImportIssue> = {},
): DecompositionImportIssue {
  return {
    id,
    projectId: BOARD,
    title: `Story ${id.slice(0, 4)}`,
    status: "backlog" as IssueStatus,
    priority: null,
    modelSelection: null,
    dependsOn: [],
    threadId: null,
    needsAttentionAt: null,
    ...overrides,
  };
}

function plan(
  entries: ReadonlyArray<IssueDecompositionEntry>,
  issues: ReadonlyArray<DecompositionImportIssue> = [],
) {
  return planIssueDecompositionImport({
    entries,
    messageId: MESSAGE,
    currentProject: CURRENT,
    linkedProjects: LINKED_PROJECTS,
    issues,
  });
}

const entry = (
  overrides: Partial<IssueDecompositionEntry> & Pick<IssueDecompositionEntry, "key">,
): IssueDecompositionEntry =>
  ({
    title: `Title ${overrides.key}`,
    description: "Body.",
    ...overrides,
  }) as IssueDecompositionEntry;

describe("planIssueDecompositionImport", () => {
  it("creates every story with the id the message derives", () => {
    const result = plan([entry({ key: "api" }), entry({ key: "ui", dependsOn: ["api"] })]);

    expect(result?.creates.map((planned) => planned.key)).toEqual(["api", "ui"]);
    expect(result?.creates[1]?.dependsOn).toEqual([
      issueIdForDecompositionEntry(MESSAGE, { key: "api" }),
    ]);
    expect(result?.updates).toEqual([]);
    expect(result?.cancels).toEqual([]);
  });

  it("rewrites the named story instead of adding one beside it", () => {
    const result = plan(
      [entry({ key: "auth", title: "Rework the session flow", updates: EXISTING_A })],
      [existing(EXISTING_A, { title: "Add sessions" })],
    );

    expect(result?.creates).toEqual([]);
    expect(result?.updates).toHaveLength(1);
    expect(result?.updates[0]?.issueId).toBe(EXISTING_A);
    expect(result?.updates[0]?.existing.title).toBe("Add sessions");
    expect(result?.updates[0]?.applied).toBe(false);
  });

  it("cancels what a story replaces", () => {
    const result = plan(
      [entry({ key: "auth", supersedes: [EXISTING_A, EXISTING_B] })],
      [existing(EXISTING_A), existing(EXISTING_B)],
    );

    expect(result?.cancels.map((planned) => planned.issue.id)).toEqual([EXISTING_A, EXISTING_B]);
    expect(result?.cancels[0]?.replacedByTitle).toBe("Title auth");
    expect(result?.creates).toHaveLength(1);
  });

  it.each([
    { status: "in_progress" as IssueStatus },
    { status: "in_review" as IssueStatus },
    { status: "done" as IssueStatus },
    { threadId: "thread-1" },
    { needsAttentionAt: "2026-01-01T00:00:00.000Z" },
  ])("refuses to rewrite work that has started or been flagged", (overrides) => {
    expect(
      plan([entry({ key: "auth", updates: EXISTING_A })], [existing(EXISTING_A, overrides)]),
    ).toBeNull();
    expect(
      plan([entry({ key: "auth", supersedes: [EXISTING_A] })], [existing(EXISTING_A, overrides)]),
    ).toBeNull();
  });

  it("refuses a story naming an issue that is not there", () => {
    expect(plan([entry({ key: "auth", updates: EXISTING_A })])).toBeNull();
  });

  it("refuses a story revising an issue on a board it does not route to", () => {
    expect(
      plan(
        [entry({ key: "auth", project: "/repos/web-client", updates: EXISTING_A })],
        [existing(EXISTING_A)],
      ),
    ).toBeNull();
  });

  it("routes a revision to the linked board that owns the issue", () => {
    const result = plan(
      [entry({ key: "auth", project: "/repos/web-client", updates: EXISTING_A })],
      [existing(EXISTING_A, { projectId: LINKED })],
    );

    expect(result?.updates[0]?.projectId).toBe(LINKED);
    expect(result?.groups.find((group) => group.projectId === LINKED)?.updates).toHaveLength(1);
  });

  it("refuses two stories claiming the same issue", () => {
    expect(
      plan(
        [
          entry({ key: "one", updates: EXISTING_A }),
          entry({ key: "two", supersedes: [EXISTING_A] }),
        ],
        [existing(EXISTING_A)],
      ),
    ).toBeNull();
  });

  it("keeps a dependency on an issue that already exists", () => {
    const result = plan([entry({ key: "ui", dependsOn: [EXISTING_A] })], [existing(EXISTING_A)]);

    expect(result?.creates[0]?.dependsOn).toEqual([EXISTING_A]);
  });

  it("drops a dependency whose issue is gone, as the board does", () => {
    const result = plan([entry({ key: "ui", dependsOn: [EXISTING_A] })]);

    expect(result?.creates[0]?.dependsOn).toEqual([]);
  });

  it("refuses a plan that waits on a story it cancels", () => {
    expect(
      plan(
        [
          entry({ key: "one", supersedes: [EXISTING_A] }),
          entry({ key: "two", dependsOn: [EXISTING_A] }),
        ],
        [existing(EXISTING_A)],
      ),
    ).toBeNull();
  });

  it("refuses a revision that would close a cycle through the board", () => {
    expect(
      plan(
        [entry({ key: "one", updates: EXISTING_A, dependsOn: ["two"] }), entry({ key: "two" })],
        [
          existing(EXISTING_A),
          existing(EXISTING_B, {
            dependsOn: [issueIdForDecompositionEntry(MESSAGE, { key: "two" })],
          }),
        ],
      ),
    ).not.toBeNull();

    expect(
      plan(
        [entry({ key: "one", updates: EXISTING_A, dependsOn: [EXISTING_B] })],
        [existing(EXISTING_A), existing(EXISTING_B, { dependsOn: [EXISTING_A] })],
      ),
    ).toBeNull();
  });
});

describe("applying a plan twice", () => {
  const entries = [
    entry({ key: "auth", title: "Rework the session flow", updates: EXISTING_A }),
    entry({ key: "new", supersedes: [EXISTING_B] }),
  ];

  it("has work to do against the board it was planned on", () => {
    const result = plan(entries, [existing(EXISTING_A), existing(EXISTING_B)]);

    expect(result).not.toBeNull();
    expect(
      result === null
        ? null
        : isIssueDecompositionImportApplied(result, {
            existingIssueIds: new Set([EXISTING_A, EXISTING_B]),
            completedIds: new Set(),
          }),
    ).toBe(false);
  });

  it("is a no-op once the board already reads that way", () => {
    const created = issueIdForDecompositionEntry(MESSAGE, { key: "new" });
    const result = plan(entries, [
      existing(EXISTING_A, { title: "Rework the session flow" }),
      existing(EXISTING_B, { status: "canceled" }),
      existing(created, { title: "Title new" }),
    ]);

    expect(result?.updates[0]?.applied).toBe(true);
    expect(result?.cancels[0]?.applied).toBe(true);
    expect(
      result === null
        ? null
        : isIssueDecompositionImportApplied(result, {
            existingIssueIds: new Set([EXISTING_A, EXISTING_B, created]),
            completedIds: new Set(),
          }),
    ).toBe(true);
  });
});
