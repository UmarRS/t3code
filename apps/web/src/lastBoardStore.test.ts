import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useLastBoardStore } from "./lastBoardStore";

const PROJECT_REF = scopeProjectRef(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);

describe("lastBoardStore", () => {
  beforeEach(() => useLastBoardStore.setState({ lastBoardRef: null }));

  it("starts with no remembered board", () => {
    expect(useLastBoardStore.getState().lastBoardRef).toBeNull();
  });

  it("records the last visited board and persists it", async () => {
    useLastBoardStore.getState().setLastBoardRef(PROJECT_REF);

    expect(useLastBoardStore.getState().lastBoardRef).toEqual(PROJECT_REF);
    expect(
      useLastBoardStore.persist.getOptions().partialize?.(useLastBoardStore.getState()),
    ).toMatchObject({ lastBoardRef: PROJECT_REF });

    const { name, storage } = useLastBoardStore.persist.getOptions();
    if (!name) throw new Error("Expected last-board persistence to have a storage name");
    const persisted = await storage?.getItem(name);
    expect(persisted?.state).toMatchObject({ lastBoardRef: PROJECT_REF });
  });

  it("overwrites a previously remembered board when a new one is visited", () => {
    const otherRef = scopeProjectRef(
      EnvironmentId.make("environment-2"),
      ProjectId.make("project-2"),
    );
    useLastBoardStore.getState().setLastBoardRef(PROJECT_REF);
    useLastBoardStore.getState().setLastBoardRef(otherRef);

    expect(useLastBoardStore.getState().lastBoardRef).toEqual(otherRef);
  });
});
