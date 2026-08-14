import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Menu } from "../ui/menu";
import { IssuesProjectMenuGroup } from "./IssuesProjectMenuGroup";

describe("IssuesProjectMenuGroup", () => {
  it("renders its label inside the Base UI menu group context", () => {
    const html = renderToStaticMarkup(
      <Menu>
        <IssuesProjectMenuGroup
          currentProjectRef={{
            environmentId: EnvironmentId.make("environment-1"),
            projectId: ProjectId.make("project-1"),
          }}
          label="Choose a project board"
          onSelect={() => {}}
          projects={[
            {
              environmentId: EnvironmentId.make("environment-1"),
              id: ProjectId.make("project-1"),
              title: "Atlas",
              workspaceRoot: "/workspace/atlas",
            } as EnvironmentProject,
          ]}
        />
      </Menu>,
    );

    expect(html).toContain("Choose a project board");
    expect(html).toContain("Atlas");
  });
});
