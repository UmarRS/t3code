import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAttentionStateSchema, DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("decodes a running backend instance with its endpoints", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    ).toEqual({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });

  it("allows a registered but not-yet-running instance to report no endpoints", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).httpBaseUrl,
    ).toBeNull();
  });
});

describe("DesktopAttentionStateSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopAttentionStateSchema);

  it("round-trips a thread target unchanged, as older builds already send it", () => {
    const state = {
      badgeCount: 1,
      alerts: [
        {
          title: "Approval needed",
          body: "Fix the flaky test",
          target: { environmentId: "environment-local", threadId: "thread-1" },
        },
      ],
    };

    expect(decode(state)).toEqual(state);
  });

  it("round-trips a board target, discriminated by its own keys alone", () => {
    const state = {
      badgeCount: 1,
      alerts: [
        {
          title: "Issue needs you",
          body: "Ship the importer",
          target: { environmentId: "environment-local", projectId: "project-1", view: "review" },
        },
      ],
    };

    expect(decode(state)).toEqual(state);
  });

  it("keeps a rollup alert targetless", () => {
    expect(
      decode({
        badgeCount: 4,
        alerts: [{ title: "4 items need you", body: "One · Two", target: null }],
      }).alerts[0]?.target,
    ).toBeNull();
  });
});
