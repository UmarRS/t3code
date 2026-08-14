import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

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
