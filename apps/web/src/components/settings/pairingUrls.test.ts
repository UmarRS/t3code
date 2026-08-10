import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("never offers a hosted pairing URL, so callers use the endpoint directly", () => {
    expect(
      resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE"),
    ).toBeNull();
    expect(resolveDesktopPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://host.tailnet.example.ts.net:3773/pair#token=PAIRCODE",
    );
  });
});
