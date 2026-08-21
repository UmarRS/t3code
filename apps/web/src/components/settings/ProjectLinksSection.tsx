import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import {
  deriveProjectLinkViews,
  findProjectLinkTarget,
  type ProjectLinkView,
} from "@t3tools/shared/projectLinks";
import { FolderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { getBrowseLeafPathSegment, normalizeProjectPathForDispatch } from "../../lib/projectPaths";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NOT_A_PROJECT_NOTE = "Context only — not a t3code project.";
const AGENT_NOTE = "Agents in this project can delegate work to an agent here.";
const CONTEXT_ONLY_NOTE =
  "Readable context only. Register this folder as a project to let agents delegate work to it.";
const CASE_INSENSITIVE_PATH_MATCH = { caseInsensitive: true } as const;

/** A link as one checkout of this group sees it, plus the checkout itself. */
interface ProjectLinkRow extends ProjectLinkView {
  readonly member: SidebarProjectGroupMember;
}

/**
 * Links are stored per checkout, and a link path is meaningful only on the
 * environment that owns it, so derivation runs once per member against that
 * member's own environment.
 */
export function useProjectLinkRows(group: SidebarProjectSnapshot): ReadonlyArray<ProjectLinkRow> {
  const projects = useProjects();
  return useMemo(
    () =>
      group.memberProjects.flatMap((member) =>
        deriveProjectLinkViews({
          project: member,
          projects: projects.filter(
            (candidate) => candidate.environmentId === member.environmentId,
          ),
        }).map((view) => ({ ...view, member })),
      ),
    [group.memberProjects, projects],
  );
}

export function ProjectLinksSection({
  group,
  reportFailure,
}: {
  group: SidebarProjectSnapshot;
  reportFailure: (title: string, result: AtomCommandResult<void, unknown>) => void;
}) {
  const projects = useProjects();
  const rows = useProjectLinkRows(group);
  const addLink = useAtomCommand(projectEnvironment.addLink, { reportFailure: false });
  const removeLink = useAtomCommand(projectEnvironment.removeLink, { reportFailure: false });
  const browsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });

  // New links land on the checkout the page is showing. Every checkout's links
  // are listed above, each labelled with its own path when there is more than
  // one, so an existing link is still removable wherever it lives.
  const target =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0]!;
  const environment = useEnvironment(target.environmentId);
  const targetEnvironmentProjects = useMemo(
    () => projects.filter((candidate) => candidate.environmentId === target.environmentId),
    [projects, target.environmentId],
  );
  const pathMatchOptions =
    environment?.serverConfig?.environment.platform.os === "darwin"
      ? CASE_INSENSITIVE_PATH_MATCH
      : undefined;

  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const normalizedPath = normalizeProjectPathForDispatch(path);
  // Live, from the projects we already hold: no disk read needed to tell the
  // user a folder is not a project. Existence is checked on submit. Only an
  // already-absolute path can be matched here — a `~` path is resolved by the
  // server, so claiming anything about it before then would be a guess.
  const canResolveTargetLocally =
    normalizedPath.startsWith("/") || /^[a-zA-Z]:/.test(normalizedPath);
  const isRegisteredProject =
    canResolveTargetLocally &&
    findProjectLinkTarget(normalizedPath, targetEnvironmentProjects, pathMatchOptions) !== null;

  const submit = useCallback(async () => {
    if (isSaving) return;
    const nextPath = normalizeProjectPathForDispatch(path);
    const nextDescription = description.trim();
    if (nextPath.length === 0) {
      setError("Enter the folder to link.");
      return;
    }
    if (nextDescription.length === 0) {
      setError("Describe what this folder is — agents read this.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      // The decider is pure and never touches disk, so existence is checked
      // here. Browsing the path also resolves `~` and gives back the canonical
      // absolute path, which is what gets stored.
      const browsed = await browsePath({
        environmentId: target.environmentId,
        input: { partialPath: nextPath },
      });
      if (browsed._tag === "Failure") {
        setError(`No folder at ${nextPath}.`);
        return;
      }
      const { exactEntry } = filterFilesystemBrowseEntries(
        browsed.value.entries,
        getBrowseLeafPathSegment(nextPath),
      );
      if (exactEntry === null) {
        setError(`No folder at ${nextPath}.`);
        return;
      }

      // A macOS volume normally treats `Dev` and `dev` as the same directory.
      // Store the registered project's spelling so pure server-side link
      // derivation remains exact and case-sensitive remote filesystems are
      // unaffected.
      const submittedTarget = findProjectLinkTarget(
        exactEntry.fullPath,
        targetEnvironmentProjects,
        pathMatchOptions,
      );

      const result = mapAtomCommandResult(
        await addLink({
          environmentId: target.environmentId,
          input: {
            projectId: target.id,
            linkId: randomUUID(),
            path: submittedTarget?.workspaceRoot ?? exactEntry.fullPath,
            description: nextDescription,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Failed to add link.");
        return;
      }
      setPath("");
      setDescription("");
    } finally {
      setIsSaving(false);
    }
  }, [
    addLink,
    browsePath,
    description,
    isSaving,
    path,
    pathMatchOptions,
    target.environmentId,
    target.id,
    targetEnvironmentProjects,
  ]);

  const remove = useCallback(
    async (row: ProjectLinkRow) => {
      const result = mapAtomCommandResult(
        await removeLink({
          environmentId: row.member.environmentId,
          input: { projectId: row.member.id, linkId: row.link.id },
        }),
        () => undefined,
      );
      reportFailure("Failed to remove link", result);
    },
    [removeLink, reportFailure],
  );

  return (
    <SettingsSection id="project-linked-projects" title="Linked projects">
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          No linked folders yet. Link the codebases this project works with — a backend and its
          frontends — so agents know they exist and what they are.
        </p>
      ) : (
        <div className="space-y-2 px-3 sm:px-4">
          {rows.map((row) => (
            <div
              key={`${row.member.physicalProjectKey}:${row.link.id}`}
              className="flex min-w-0 items-start gap-3 rounded-lg border border-border/50 p-3"
            >
              <FolderIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-xs text-foreground">
                    {row.path}
                  </span>
                  {row.mirrored ? (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
                      mirrored
                    </span>
                  ) : null}
                  {row.targetProjectId === null ? (
                    <span
                      title={CONTEXT_ONLY_NOTE}
                      className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground"
                    >
                      context only
                    </span>
                  ) : (
                    <span
                      title={AGENT_NOTE}
                      className="shrink-0 rounded-sm border border-success/40 bg-success/8 px-1.5 py-px text-[11px] text-success"
                    >
                      agents
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-[1.45] text-muted-foreground">
                  {row.description}
                </p>
                {group.memberProjects.length > 1 ? (
                  <p className="truncate font-mono text-[11px] text-muted-foreground/70">
                    on {row.member.workspaceRoot}
                  </p>
                ) : null}
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-destructive-foreground"
                aria-label={`Remove link to ${row.path}`}
                onClick={() => void remove(row)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <SettingsRow
        title="Link a folder"
        description="Any folder on this environment. Linking a registered project links it both ways — it shows the mirrored link and can be removed from either side."
      >
        <div className="grid gap-2 pt-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
          <Input
            aria-label="Folder path"
            className="font-mono text-xs"
            placeholder="/Users/you/dev/backend"
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <Input
            aria-label="Link description"
            placeholder="backend for all smartcanvass APIs"
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={isSaving}
            className="shrink-0"
            onClick={() => void submit()}
          >
            <PlusIcon className="size-3.5" />
            Add link
          </Button>
        </div>
        {error ? <p className="pt-2 text-[13px] text-destructive-foreground">{error}</p> : null}
        {error === null && canResolveTargetLocally && !isRegisteredProject ? (
          <p className="pt-2 text-[13px] text-muted-foreground">{NOT_A_PROJECT_NOTE}</p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
