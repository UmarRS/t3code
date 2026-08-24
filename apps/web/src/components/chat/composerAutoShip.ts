/**
 * Auto-ship's presentation, shared by the two composer footers. Lives outside
 * `ChatComposer` so the compact controls menu can read it without importing
 * the component that renders the menu.
 */

/**
 * Whether this thread ships its own work, and whether it may. Null on threads
 * where the question does not arise: drafts, and servers that predate the
 * feature — the toggle is hidden rather than shown dead.
 */
export interface ComposerAutoShipState {
  readonly enabled: boolean;
  /** Non-null disables the toggle and says why. */
  readonly disabledReason: string | null;
}

export function composerAutoShipTooltip(state: ComposerAutoShipState): string {
  if (state.disabledReason !== null) return state.disabledReason;
  return state.enabled
    ? "Auto-ship is on: every turn that changes code is committed, pushed, opened as a pull request and merged. Click to turn it off."
    : "Turn on auto-ship: commit, push, open a pull request and merge it at the end of every turn, with no review.";
}
