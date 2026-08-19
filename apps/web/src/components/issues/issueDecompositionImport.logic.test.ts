import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  issueIdForDecompositionEntry,
  parseIssueDecompositionForImport,
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
    // A dependency across boards cannot be created, so the whole block is unusable.
    '```t3-issues\n[{"key":"a","title":"A","description":"A"},{"key":"b","title":"B","description":"B","project":"/repos/other","dependsOn":["a"]}]\n```',
  ])("does not offer an import for unusable output", (markdown) => {
    expect(parseIssueDecompositionForImport(markdown)).toBeNull();
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
});

describe("issueIdForDecompositionEntry", () => {
  it("is stable per message and story key", () => {
    const messageId = MessageId.make("8c89d464-6d37-447c-9dd4-9f4ec461dd87");
    const first = issueIdForDecompositionEntry(messageId, "api");

    expect(first).toBe(issueIdForDecompositionEntry(messageId, "api"));
    expect(first).not.toBe(issueIdForDecompositionEntry(messageId, "ui"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
