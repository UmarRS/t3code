import { APP_VERSION } from "./branding";

export const RELEASE_NOTES_STORAGE_KEY = "atlas.release-notes.last-seen-version";

export interface AppReleaseNotes {
  readonly version: string;
  readonly changes: ReadonlyArray<string>;
}

const RELEASE_NOTES_BY_VERSION: Readonly<Record<string, ReadonlyArray<string>>> = {
  "0.0.35": [
    "Auto-ship lands a thread's own work with no review step: turn it on and every turn that changes code is committed, pushed, opened as a pull request and merged.",
    "Work boards now say why an issue wants you — a failed review reads differently from a run that stopped — and a plan that spans projects can start every board it reaches in one action.",
    "Autonomous reviews survive a provider failure: a killed reviewer is retried instead of recording a verdict on code nobody read, and a reset review releases the merge queue.",
    "Board stories can be revised in place, and merged work now settles itself — threads park and their worktrees are reclaimed as soon as the pull request lands.",
  ],
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
