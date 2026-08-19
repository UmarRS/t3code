import { describe, expect, it } from "vite-plus/test";
import packageJson from "../package.json" with { type: "json" };

import { releaseNotesForVersion, shouldShowReleaseNotes } from "./releaseNotes";

describe("release notes", () => {
  it("ships notes for the running application version", () => {
    const release = releaseNotesForVersion(packageJson.version);
    expect(release?.version).toBe("0.0.34");
    expect(release?.changes.length).toBeGreaterThan(0);
  });

  it("shows once for each version", () => {
    const release = releaseNotesForVersion(packageJson.version);
    expect(shouldShowReleaseNotes(release, null)).toBe(true);
    expect(shouldShowReleaseNotes(release, release?.version ?? null)).toBe(false);
  });
});
