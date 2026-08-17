import type { ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface LastBoardStoreState {
  /** The most recently visited issues board, or null before the user has visited one. */
  lastBoardRef: ScopedProjectRef | null;
  setLastBoardRef: (ref: ScopedProjectRef) => void;
}

/**
 * Remembers the last issues board the user visited so entry points that open
 * "the" issues board (sidebar footer button, command palette) can jump
 * straight there instead of making the user pick a project every time. A
 * stale ref (its project got removed) is a real possibility since this is
 * long-lived localStorage state, so readers must validate it against the
 * live project list rather than trusting it outright — this store just
 * records the visit.
 */
export const useLastBoardStore = create<LastBoardStoreState>()(
  persist(
    (set) => ({
      lastBoardRef: null,
      setLastBoardRef: (ref) => set({ lastBoardRef: ref }),
    }),
    {
      name: "t3code:last-board:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ lastBoardRef: state.lastBoardRef }),
    },
  ),
);
