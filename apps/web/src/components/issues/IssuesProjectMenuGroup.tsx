import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { CheckIcon, ListChecksIcon } from "lucide-react";

import { MenuGroup, MenuGroupLabel, MenuItem } from "../ui/menu";

export function IssuesProjectMenuGroup({
  currentProjectRef = null,
  label,
  onSelect,
  projects,
  showBoardIcon = false,
}: {
  readonly currentProjectRef?: ScopedProjectRef | null;
  readonly label: string;
  readonly onSelect: (project: EnvironmentProject) => void;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly showBoardIcon?: boolean;
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {projects.map((project) => {
        const selected =
          currentProjectRef?.environmentId === project.environmentId &&
          currentProjectRef.projectId === project.id;
        return (
          <MenuItem
            key={`${project.environmentId}:${project.id}`}
            className="min-w-0"
            onClick={() => onSelect(project)}
          >
            {showBoardIcon ? <ListChecksIcon /> : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{project.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {project.workspaceRoot}
              </span>
            </span>
            {selected ? <CheckIcon className="size-4" /> : null}
          </MenuItem>
        );
      })}
    </MenuGroup>
  );
}
