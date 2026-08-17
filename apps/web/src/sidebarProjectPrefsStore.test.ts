import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { sidebarProjectPrefKey, useSidebarProjectPrefsStore } from "./sidebarProjectPrefsStore";

const KEY = sidebarProjectPrefKey({
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
});

describe("sidebarProjectPrefsStore", () => {
  beforeEach(() =>
    useSidebarProjectPrefsStore.setState({
      favoriteProjectKeys: [],
      expandedByProjectKey: {},
    }),
  );

  it("keys preferences by the physical project ref", () => {
    expect(KEY).toBe("environment-1:project-1");
  });

  it("toggles a favorite on and back off", () => {
    useSidebarProjectPrefsStore.getState().toggleFavorite(KEY);
    expect(useSidebarProjectPrefsStore.getState().favoriteProjectKeys).toEqual([KEY]);

    useSidebarProjectPrefsStore.getState().toggleFavorite(KEY);
    expect(useSidebarProjectPrefsStore.getState().favoriteProjectKeys).toEqual([]);
  });

  it("records explicit expansion choices without seeding defaults", () => {
    expect(useSidebarProjectPrefsStore.getState().expandedByProjectKey[KEY]).toBeUndefined();

    useSidebarProjectPrefsStore.getState().setExpanded(KEY, false);
    expect(useSidebarProjectPrefsStore.getState().expandedByProjectKey[KEY]).toBe(false);
  });

  it("persists both preferences", async () => {
    useSidebarProjectPrefsStore.getState().toggleFavorite(KEY);
    useSidebarProjectPrefsStore.getState().setExpanded(KEY, true);

    const { name, storage } = useSidebarProjectPrefsStore.persist.getOptions();
    if (!name) throw new Error("Expected sidebar project prefs to have a storage name");
    const persisted = await storage?.getItem(name);
    expect(persisted?.state).toMatchObject({
      favoriteProjectKeys: [KEY],
      expandedByProjectKey: { [KEY]: true },
    });
  });
});
