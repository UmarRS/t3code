import { describe, expect, it } from "vite-plus/test";

import { formatResumeCountdown, resolveThreadErrorBannerMode } from "./threadLimitPark";

const NOW_MS = Date.parse("2026-08-17T01:48:00.000Z");

describe("resolveThreadErrorBannerMode", () => {
  it("shows nothing when the thread has no error", () => {
    expect(resolveThreadErrorBannerMode({ error: null, session: null, nowMs: NOW_MS })).toBeNull();
  });

  it("shows a plain error when the session is not parked", () => {
    expect(
      resolveThreadErrorBannerMode({
        error: "Tool call failed",
        session: { resumeAt: null },
        nowMs: NOW_MS,
      }),
    ).toEqual({ kind: "error", message: "Tool call failed" });
  });

  it("prefers the park over the error that caused it", () => {
    const mode = resolveThreadErrorBannerMode({
      error: "You've hit your session limit",
      session: { resumeAt: "2026-08-17T04:10:00.000Z" },
      nowMs: NOW_MS,
    });

    expect(mode?.kind).toBe("parked");
    // The error text is kept so the tooltip can still show what happened.
    expect(mode?.message).toBe("You've hit your session limit");
  });

  it("still parks when the failure text was never recorded", () => {
    const mode = resolveThreadErrorBannerMode({
      error: null,
      session: { resumeAt: "2026-08-17T04:10:00.000Z" },
      nowMs: NOW_MS,
    });

    expect(mode?.kind).toBe("parked");
  });
});

describe("formatResumeCountdown", () => {
  it("reads whole minutes under an hour", () => {
    expect(formatResumeCountdown("2026-08-17T02:13:00.000Z", NOW_MS)).toBe("in 25m");
  });

  it("reads hours and minutes past an hour", () => {
    expect(formatResumeCountdown("2026-08-17T04:10:00.000Z", NOW_MS)).toBe("in 2h 22m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatResumeCountdown("2026-08-17T03:48:00.000Z", NOW_MS)).toBe("in 2h");
  });

  it("never counts below a minute, so the banner cannot read 'in 0m'", () => {
    expect(formatResumeCountdown("2026-08-17T01:48:20.000Z", NOW_MS)).toBe("in 1m");
  });

  it("has no countdown once the instant has passed", () => {
    expect(formatResumeCountdown("2026-08-17T01:00:00.000Z", NOW_MS)).toBeNull();
    expect(formatResumeCountdown("not a date", NOW_MS)).toBeNull();
  });
});
