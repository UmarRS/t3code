import { APP_VERSION } from "./branding";

export const RELEASE_NOTES_STORAGE_KEY = "atlas.release-notes.last-seen-version";

export interface AppReleaseNotes {
  readonly version: string;
  readonly changes: ReadonlyArray<string>;
}

const RELEASE_NOTES_BY_VERSION: Readonly<Record<string, ReadonlyArray<string>>> = {
  "0.0.34": [
    "Generated story plans now stay in chat until you choose Add to board, so you can request revisions without cleaning up stale issues.",
    "Issues now include an all-project overview for seeing work across your environment in one place.",
    "Autonomous runs recover more reliably from provider failures and finish cleanly when pull requests merge outside Atlas.",
  ],
};

export function releaseNotesForVersion(version: string): AppReleaseNotes | null {
  const changes = RELEASE_NOTES_BY_VERSION[version];
  return changes ? { version, changes } : null;
}

export function currentReleaseNotes(): AppReleaseNotes | null {
  return releaseNotesForVersion(APP_VERSION);
}

export function shouldShowReleaseNotes(
  release: AppReleaseNotes | null,
  lastSeenVersion: string | null,
): release is AppReleaseNotes {
  return release !== null && release.version !== lastSeenVersion;
}
