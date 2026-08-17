import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Both preferences are keyed by the physical project the sidebar row points
 * at — `"<environmentId>:<projectId>"` — rather than by the logical
 * (grouped) project key. Grouping is a *display* setting the user can flip at
 * any time; keying off it would silently drop a user's favorites the moment
 * they changed how projects merge. The physical ref is stable for the life of
 * the project.
 */
export function sidebarProjectPrefKey(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string {
  return `${input.environmentId}:${input.projectId}`;
}

interface SidebarProjectPrefsState {
  /** Favorited project keys. Favorites sort to the top of the Projects list. */
  favoriteProjectKeys: readonly string[];
  /**
   * Only keys the user has explicitly expanded or collapsed. Absence is
   * meaningful: it means "no choice yet", which lets favorites default to
   * expanded without stamping that default into storage (and without making a
   * later un-favorite silently collapse a project the user opened by hand).
   */
  expandedByProjectKey: Readonly<Record<string, boolean>>;
  toggleFavorite: (projectKey: string) => void;
  setExpanded: (projectKey: string, expanded: boolean) => void;
}

export const useSidebarProjectPrefsStore = create<SidebarProjectPrefsState>()(
  persist(
    (set) => ({
      favoriteProjectKeys: [],
      expandedByProjectKey: {},
      toggleFavorite: (projectKey) =>
        set((state) => ({
          favoriteProjectKeys: state.favoriteProjectKeys.includes(projectKey)
            ? state.favoriteProjectKeys.filter((key) => key !== projectKey)
            : [...state.favoriteProjectKeys, projectKey],
        })),
      setExpanded: (projectKey, expanded) =>
        set((state) => ({
          expandedByProjectKey: { ...state.expandedByProjectKey, [projectKey]: expanded },
        })),
    }),
    {
      name: "t3code:sidebar-project-prefs:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        favoriteProjectKeys: state.favoriteProjectKeys,
        expandedByProjectKey: state.expandedByProjectKey,
      }),
    },
  ),
);
