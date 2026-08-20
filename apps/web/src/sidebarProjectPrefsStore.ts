import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PROJECT_ACCENTS = ["blue", "teal", "purple", "orange", "pink", "green"] as const;

export type ProjectAccent = (typeof PROJECT_ACCENTS)[number];

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
  /** Explicit overview-card colors. Missing keys retain their generated color. */
  accentByProjectKey: Readonly<Partial<Record<string, ProjectAccent>>>;
  toggleFavorite: (projectKey: string) => void;
  setExpanded: (projectKey: string, expanded: boolean) => void;
  setAccent: (projectKey: string, accent: ProjectAccent | null) => void;
}

export const useSidebarProjectPrefsStore = create<SidebarProjectPrefsState>()(
  persist(
    (set) => ({
      favoriteProjectKeys: [],
      expandedByProjectKey: {},
      accentByProjectKey: {},
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
      setAccent: (projectKey, accent) =>
        set((state) => {
          const accentByProjectKey = { ...state.accentByProjectKey };
          if (accent === null) delete accentByProjectKey[projectKey];
          else accentByProjectKey[projectKey] = accent;
          return { accentByProjectKey };
        }),
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
        accentByProjectKey: state.accentByProjectKey,
      }),
    },
  ),
);
