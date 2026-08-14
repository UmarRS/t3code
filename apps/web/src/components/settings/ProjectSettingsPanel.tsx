import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { MAX_AUTONOMOUS_SCHEDULE_ENTRIES } from "@t3tools/contracts";
import type {
  ModelSelection,
  ProjectAutonomousScheduleEntry,
  ProviderDriverKind,
  SidebarProjectGroupingMode,
  T3ProjectFileScript,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@t3tools/shared/model";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { CopyIcon, FolderIcon, PlusIcon, ServerIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { isElectron } from "../../env";
import {
  useClientSettings,
  useUpdateClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { keybindingValueForCommand } from "../../lib/projectScriptKeybindings";
import { readLocalApi } from "../../localApi";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
} from "../../projectScripts";
import { decodeProjectScriptKeybindingRule } from "../../lib/projectScriptKeybindings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import {
  primaryServerKeybindingsAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";

/** Sunday-first, matching `Date.prototype.getDay` and every calendar UI. */
const SCHEDULE_DAYS = [
  { value: 0, short: "S", label: "Sunday" },
  { value: 1, short: "M", label: "Monday" },
  { value: 2, short: "T", label: "Tuesday" },
  { value: 3, short: "W", label: "Wednesday" },
  { value: 4, short: "T", label: "Thursday" },
  { value: 5, short: "F", label: "Friday" },
  { value: 6, short: "S", label: "Saturday" },
] as const;

const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

/** Logical project groups for the settings page, sorted by display name. */
export function useSettingsProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export function ProjectSettingsPanel({
  selectedProjectKey,
}: {
  selectedProjectKey: string | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });

  // The index route auto-selects the first project so /settings/projects is
  // never a dead end. Hash is preserved for settings-search jumps.
  useEffect(() => {
    if (selectedProjectKey !== null) return;
    const first = groups[0];
    if (!first) return;
    void navigate({
      to: "/settings/projects/$projectKey",
      params: { projectKey: first.projectKey },
      ...(currentHash ? { hash: currentHash } : {}),
      replace: true,
      hashScrollIntoView: false,
    });
  }, [currentHash, groups, navigate, selectedProjectKey]);

  const selected =
    selectedProjectKey === null
      ? null
      : (groups.find((group) => group.projectKey === selectedProjectKey) ?? null);

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{ key: string; memberKeys: string[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      memberKeys: selected.memberProjects.map((member) => member.physicalProjectKey),
    };
  }, [selected]);

  // Recover when the selected key stops matching (regroup, removal, or a
  // stale deep link) instead of parking on a dead-end message.
  useEffect(() => {
    if (selectedProjectKey === null || selected !== null || groups.length === 0) return;
    const last = lastSelectionRef.current;
    const successor =
      last?.key === selectedProjectKey
        ? (groups.find((group) =>
            group.memberProjects.some((member) =>
              last.memberKeys.includes(member.physicalProjectKey),
            ),
          ) ?? null)
        : null;
    if (successor) {
      void navigate({
        to: "/settings/projects/$projectKey",
        params: { projectKey: successor.projectKey },
        replace: true,
        hashScrollIntoView: false,
      });
    } else {
      void navigate({ to: "/settings/projects", replace: true, hashScrollIntoView: false });
    }
  }, [groups, navigate, selected, selectedProjectKey]);

  const selectProject = useCallback(
    (projectKey: string) => {
      void navigate({
        to: "/settings/projects/$projectKey",
        params: { projectKey },
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [navigate],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Projects"
        className="w-60 shrink-0 space-y-0.5 overflow-y-auto border-e border-border/40 p-3 pt-10 max-sm:hidden sm:pt-12"
      >
        {groups.map((group) => {
          const isActive = group.projectKey === selected?.projectKey;
          return (
            <button
              key={group.projectKey}
              type="button"
              onClick={() => selectProject(group.projectKey)}
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
            >
              <ProjectFavicon
                environmentId={group.environmentId}
                cwd={group.workspaceRoot}
                faviconPath={group.faviconPath}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              {group.groupedProjectCount > 1 ? (
                <span className="shrink-0 text-xs text-muted-foreground/70">
                  {group.groupedProjectCount}
                </span>
              ) : null}
            </button>
          );
        })}
        {groups.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">No projects yet.</p>
        ) : null}
      </nav>
      {selected ? (
        <ProjectDetail
          key={selected.projectKey}
          group={selected}
          groups={groups}
          onSelectProject={selectProject}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {groups.length === 0 ? "Add a project from the sidebar to configure it here." : null}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({
  group,
  groups,
  onSelectProject,
}: {
  group: SidebarProjectSnapshot;
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  onSelectProject: (projectKey: string) => void;
}) {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const setAutonomousSchedule = useAtomCommand(projectEnvironment.setAutonomousSchedule, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const representative =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0]!;
  const faviconPath = representative.faviconPath ?? null;

  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const groupThreadCount = group.memberProjects.reduce(
    (total, member) => total + (threadCountByMember.get(memberKey(member)) ?? 0),
    0,
  );

  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  // Group-shared fields (default model, scripts) live on each physical
  // project record, so a group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        faviconPath: string | null;
        scripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, storedSelection);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === resolvedSelection?.instanceId,
  );
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) =>
      void updateAllMembers({ defaultModelSelection: selection }, "Failed to update default model"),
    [updateAllMembers],
  );

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers(
        { defaultThreadEnvMode: mode },
        "Failed to update new-thread workspace",
      ),
    [updateAllMembers],
  );

  // ----- favicon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setFaviconPath = useCallback(
    async (faviconPath: string | null) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers({ faviconPath }, "Failed to update project icon");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- scripts -----
  const scripts = representative.scripts;
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  // Script writes replace the whole array, so two overlapping writes computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [isSavingScripts, setIsSavingScripts] = useState(false);
  const savingScriptsRef = useRef(false);
  const t3File = useT3ProjectFileState(representative.environmentId, representative.workspaceRoot);
  // What the "Default" option resolves to while no override is set: the
  // repo's t3.json value when present, otherwise the global setting.
  const inheritedEnvMode = t3File.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource = t3File.file?.defaultThreadEnvMode != null ? "t3.json" : "global";
  const importableScripts = useMemo(
    () =>
      t3File.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, t3File.scripts],
  );

  const persistScripts = useCallback(
    async (
      nextScripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>,
      keybinding: string | null | undefined,
      keybindingCommand: ReturnType<typeof commandForProjectScript>,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (savingScriptsRef.current) {
        return AsyncResult.failure(
          Cause.fail(new Error("Another script change is still saving. Try again.")),
        );
      }
      savingScriptsRef.current = true;
      setIsSavingScripts(true);
      try {
        // Captured before the write so a cleared or deleted binding can be
        // removed from the keybindings config afterwards.
        const previousKeybinding = keybindingValueForCommand(keybindings, keybindingCommand);
        const updateResult = await updateAllMembers(
          { scripts: nextScripts },
          "Failed to save scripts",
        );
        if (updateResult._tag === "Failure") return updateResult;

        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: keybindingCommand,
        });
        if (!isElectron) return updateResult;
        const environmentIds = [
          ...new Set(group.memberProjects.map((member) => member.environmentId)),
        ];
        const previousTarget = previousKeybinding
          ? decodeProjectScriptKeybindingRule({
              keybinding: previousKeybinding,
              command: keybindingCommand,
            })
          : null;
        if (keybindingRule) {
          // `replace` swaps the command's previous rule instead of appending a
          // second one that would keep the old shortcut alive.
          const input =
            previousTarget && previousTarget.key !== keybindingRule.key
              ? { ...keybindingRule, replace: previousTarget }
              : keybindingRule;
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await upsertKeybinding({ environmentId, input }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to save keybinding", result);
              return result;
            }
          }
        } else if (previousTarget) {
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await removeKeybinding({ environmentId, input: previousTarget }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to remove keybinding", result);
              return result;
            }
          }
        }
        return updateResult;
      } finally {
        savingScriptsRef.current = false;
        setIsSavingScripts(false);
      }
    },
    [
      group.memberProjects,
      keybindings,
      removeKeybinding,
      reportFailure,
      updateAllMembers,
      upsertKeybinding,
    ],
  );

  const submitScript = useCallback(
    async (
      scriptId: string | null,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (scriptId === null) {
        const nextId = nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
        const nextScript = buildProjectScript(nextId, input);
        const nextScripts = input.runOnWorktreeCreate
          ? [
              ...scripts.map((script) =>
                script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
              ),
              nextScript,
            ]
          : [...scripts, nextScript];
        return persistScripts(nextScripts, input.keybinding, commandForProjectScript(nextId));
      }

      const updatedScript = buildProjectScript(scriptId, input);
      const nextScripts = scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, input.keybinding, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const deleteScript = useCallback(
    (scriptId: string) => {
      const nextScripts = scripts.filter((script) => script.id !== scriptId);
      void persistScripts(nextScripts, null, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submitScript],
  );

  // ----- scheduled runs -----
  const schedule = representative.autonomousSchedule ?? [];
  // Like scripts, a write replaces the whole list, so two overlapping writes
  // computed from the same snapshot would drop each other's changes.
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const savingScheduleRef = useRef(false);
  const persistSchedule = useCallback(
    async (nextSchedule: ReadonlyArray<ProjectAutonomousScheduleEntry>) => {
      if (savingScheduleRef.current) return;
      savingScheduleRef.current = true;
      setIsSavingSchedule(true);
      try {
        for (const member of group.memberProjects) {
          const result = mapAtomCommandResult(
            await setAutonomousSchedule({
              environmentId: member.environmentId,
              input: { projectId: member.id, schedule: nextSchedule },
            }),
            () => undefined,
          );
          if (result._tag === "Failure") {
            reportFailure(
              group.memberProjects.length > 1
                ? `Failed to save scheduled runs on ${member.environmentLabel ?? "the current environment"}`
                : "Failed to save scheduled runs",
              result,
            );
            return;
          }
        }
      } finally {
        savingScheduleRef.current = false;
        setIsSavingSchedule(false);
      }
    },
    [group.memberProjects, reportFailure, setAutonomousSchedule],
  );

  const updateScheduleEntry = useCallback(
    (entryId: string, patch: Partial<ProjectAutonomousScheduleEntry>) =>
      void persistSchedule(
        schedule.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)),
      ),
    [persistSchedule, schedule],
  );

  const addScheduleEntry = useCallback(
    () =>
      void persistSchedule([
        ...schedule,
        { id: randomUUID(), time: "09:00", daysOfWeek: [], enabled: true },
      ]),
    [persistSchedule, schedule],
  );

  const removeScheduleEntry = useCallback(
    (entryId: string) => void persistSchedule(schedule.filter((entry) => entry.id !== entryId)),
    [persistSchedule, schedule],
  );

  // ----- checkouts -----
  const renameMember = useCallback(
    async (member: SidebarProjectGroupMember, nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === member.title) return;
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, title },
        }),
        () => undefined,
      );
      reportFailure("Failed to rename project", result);
    },
    [reportFailure, updateProject],
  );

  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Remove project "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? ["This permanently clears conversation history for those threads."]
              : []),
            isWholeGroup
              ? "This removes only the project entries, not the files on disk."
              : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...(memberThreads.length > 0 ? { force: true } : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (isWholeGroup) {
        void navigate({ to: "/settings/projects", replace: true });
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const repositoryLine =
    representative.repositoryIdentity?.displayName ??
    representative.repositoryIdentity?.canonicalKey ??
    "No git remote detected";
  const environmentCount = new Set(group.memberProjects.map((member) => member.environmentId)).size;

  return (
    <SettingsPageContainer className="gap-10">
      <div className="flex items-center gap-3 px-3 sm:px-4">
        <ProjectFavicon
          environmentId={group.environmentId}
          cwd={group.workspaceRoot}
          faviconPath={group.faviconPath}
          className="size-8 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-[-0.02em] text-foreground">
            {group.displayName}
          </h1>
          <p className="truncate text-[13px] text-muted-foreground">
            {repositoryLine}
            {" · "}
            {group.memberProjects.length === 1
              ? "1 checkout"
              : `${group.memberProjects.length} checkouts`}
            {environmentCount > 1 ? ` across ${environmentCount} environments` : ""}
            {" · "}
            {groupThreadCount === 1 ? "1 thread" : `${groupThreadCount} threads`}
          </p>
        </div>
        <Select value={group.projectKey} onValueChange={(value) => onSelectProject(String(value))}>
          <SelectTrigger className="sm:hidden" aria-label="Switch project">
            <SelectValue>{group.displayName}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {groups.map((candidate) => (
              <SelectItem key={candidate.projectKey} hideIndicator value={candidate.projectKey}>
                {candidate.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <SettingsSection title="Appearance">
        <SettingsRow
          id="project-favicon"
          title="Project icon"
          description={faviconPath ?? "Automatic"}
          resetAction={
            faviconPath !== null ? (
              <SettingResetButton
                label="project icon"
                disabled={isSavingFavicon}
                onClick={() => void setFaviconPath(null)}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <ProjectFavicon
                environmentId={representative.environmentId}
                cwd={representative.workspaceRoot}
                faviconPath={faviconPath}
                className="size-6"
              />
              <Button
                size="xs"
                variant="outline"
                type="button"
                aria-label="Choose a project icon file"
                disabled={isSavingFavicon}
                onClick={() => setFaviconPickerOpen(true)}
              >
                Choose file
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Model">
        <SettingsRow
          id="project-default-model"
          title="Default model"
          description="New threads in this project start with this model. Applies to every checkout in this group."
          resetAction={
            storedSelection !== null ? (
              <SettingResetButton
                label="project default model"
                onClick={() => setDefaultModel(null)}
              />
            ) : null
          }
          control={
            resolvedSelection && activeEntry ? (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={resolvedSelection.instanceId}
                  model={resolvedSelection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) => {
                    setDefaultModel(createModelSelection(instanceId, model));
                  }}
                />
                <TraitsPicker
                  provider={activeEntry.driverKind as ProviderDriverKind}
                  models={activeEntry.models}
                  model={resolvedSelection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={resolvedSelection.options ?? []}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    setDefaultModel(
                      createModelSelection(
                        resolvedSelection.instanceId,
                        resolvedSelection.model,
                        nextOptions,
                      ),
                    );
                  }}
                />
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">No providers available</span>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="New threads">
        <SettingsRow
          id="project-new-thread-workspace"
          title="Workspace"
          description="Where new threads in this project start. Overrides t3.json and the global default; applies to every checkout in this group."
          resetAction={
            storedEnvMode !== null ? (
              <SettingResetButton
                label="project workspace default"
                onClick={() => setDefaultThreadEnvMode(null)}
              />
            ) : null
          }
          control={
            <Select
              value={storedEnvMode ?? "inherit"}
              onValueChange={(value) => {
                if (value === "worktree" || value === "local") {
                  setDefaultThreadEnvMode(value);
                } else if (value === "inherit") {
                  setDefaultThreadEnvMode(null);
                }
              }}
            >
              <SelectTrigger aria-label="New-thread workspace">
                <SelectValue>
                  {storedEnvMode === null
                    ? `Default (${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`
                    : resolveEnvModeLabel(storedEnvMode)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="inherit">
                  Default ({inheritedEnvModeSource}:{" "}
                  {resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})
                </SelectItem>
                <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection
        id="project-scripts"
        title="Scripts"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={isSavingScripts}
            onClick={() =>
              setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
            }
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        }
      >
        {scripts.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No scripts yet. Scripts run in a project terminal from the thread top bar; one script
            can run automatically when a worktree is created.
          </p>
        ) : (
          <div className="space-y-0.5">
            {scripts.map((script) => {
              const shortcutLabel = shortcutLabelForCommand(
                keybindings,
                commandForProjectScript(script.id),
              );
              return (
                <div
                  key={script.id}
                  className="group flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50 sm:px-4"
                >
                  <ScriptIcon
                    icon={script.icon}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {script.name}
                  </span>
                  {script.runOnWorktreeCreate ? (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
                      setup
                    </span>
                  ) : null}
                  {script.previewUrl ? (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground max-sm:hidden">
                      preview · desktop only
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/80">
                    {script.command}
                  </span>
                  {shortcutLabel ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{shortcutLabel}</span>
                  ) : null}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    aria-label={`Edit ${script.name}`}
                    disabled={isSavingScripts}
                    onClick={() => setEditorRequest(editorRequestForScript(script, keybindings))}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {t3File.status === "invalid" ? (
          <SettingsRow
            title="t3.json is invalid"
            description="A t3.json exists at the workspace root but fails to parse, so every script and icon it declares is ignored. Check the JSON syntax and icon values."
            className="text-warning"
          />
        ) : null}
        {importableScripts.length > 0 ? (
          <SettingsRow
            title="Import from t3.json"
            description={`${importableScripts.length} script${importableScripts.length === 1 ? "" : "s"} declared in this repo's t3.json ${importableScripts.length === 1 ? "is" : "are"} not set up yet.`}
            control={
              <div className="flex flex-wrap justify-end gap-1.5">
                {importableScripts.map((fileScript) => (
                  <Button
                    key={`${fileScript.name} ${fileScript.command}`}
                    size="xs"
                    variant="outline"
                    disabled={isSavingScripts}
                    onClick={() => void importFileScript(fileScript)}
                  >
                    <ScriptIcon icon={fileScript.icon ?? "play"} className="size-3.5" />
                    {fileScript.name}
                  </Button>
                ))}
              </div>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="project-scheduled-runs"
        title="Scheduled runs"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={isSavingSchedule || schedule.length >= MAX_AUTONOMOUS_SCHEDULE_ENTRIES}
            onClick={addScheduleEntry}
          >
            <PlusIcon className="size-3.5" />
            Add time
          </Button>
        }
      >
        {schedule.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No scheduled runs. Add a time and this project starts an autonomous run then, on the
            server&rsquo;s clock. A time that passes while the server is off is skipped rather than
            caught up later, and a scheduled time never interrupts a run that is already going.
          </p>
        ) : (
          <div className="space-y-2 px-3 sm:px-4">
            {schedule.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border/50 p-3"
              >
                <Input
                  key={`${entry.id}:${entry.time}`}
                  type="time"
                  aria-label="Run time"
                  className="w-32 shrink-0"
                  defaultValue={entry.time}
                  disabled={isSavingSchedule}
                  onChange={(event) => {
                    // The picker emits an empty string mid-edit; only a
                    // complete time is worth a round trip.
                    const value = event.currentTarget.value;
                    if (!SCHEDULE_TIME_PATTERN.test(value) || value === entry.time) return;
                    updateScheduleEntry(entry.id, { time: value });
                  }}
                />
                <ToggleGroup
                  multiple
                  size="sm"
                  className="gap-1"
                  disabled={isSavingSchedule}
                  value={entry.daysOfWeek.map(String)}
                  onValueChange={(value) => {
                    const daysOfWeek = SCHEDULE_DAYS.map((day) => day.value).filter((day) =>
                      value.includes(String(day)),
                    );
                    updateScheduleEntry(entry.id, { daysOfWeek });
                  }}
                >
                  {SCHEDULE_DAYS.map((day) => (
                    <Toggle
                      key={day.value}
                      value={String(day.value)}
                      aria-label={day.label}
                      variant="outline"
                      className="w-8"
                    >
                      {day.short}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <span className="text-xs text-muted-foreground">
                  {entry.daysOfWeek.length === 0 ? "Every day" : ""}
                </span>
                <div className="ms-auto flex shrink-0 items-center gap-2">
                  <Switch
                    checked={entry.enabled}
                    disabled={isSavingSchedule}
                    aria-label={`Scheduled run at ${entry.time}`}
                    onCheckedChange={(checked) =>
                      updateScheduleEntry(entry.id, { enabled: checked })
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive-foreground"
                    aria-label={`Remove scheduled run at ${entry.time}`}
                    disabled={isSavingSchedule}
                    onClick={() => removeScheduleEntry(entry.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="project-checkouts" title="Checkouts">
        <div className="space-y-2 px-3 sm:px-4">
          {group.memberProjects.map((member) => {
            const threadCount = threadCountByMember.get(memberKey(member)) ?? 0;
            const groupingOverride =
              projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                deriveProjectGroupingOverrideKey(member)
              ] ?? "inherit";
            return (
              <div
                key={member.physicalProjectKey}
                className="space-y-3 rounded-lg border border-border/50 p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {member.environmentLabel ?? "Current environment"}
                  </span>
                  <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                    {threadCount === 1 ? "1 thread" : `${threadCount} threads`}
                  </span>
                  {group.memberProjects.length > 1 ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground hover:text-destructive-foreground"
                      aria-label={`Remove checkout ${member.workspaceRoot}`}
                      onClick={() => void removeMembers([member])}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {member.workspaceRoot}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-4 shrink-0 rounded-sm"
                    aria-label="Copy project path"
                    onClick={() =>
                      copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot })
                    }
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid min-w-0 gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Name</span>
                    <Input
                      key={`${member.physicalProjectKey}:${member.title}`}
                      aria-label={`Project name in ${member.environmentLabel ?? "current environment"}`}
                      defaultValue={member.title}
                      onBlur={(event) => {
                        void renameMember(member, event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Grouping rule</span>
                    <Select
                      value={groupingOverride}
                      onValueChange={(value) => {
                        if (
                          value === "inherit" ||
                          value === "repository" ||
                          value === "repository_path" ||
                          value === "separate"
                        ) {
                          updateGroupingPreference(member, value);
                        }
                      }}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={`Grouping rule for ${member.environmentLabel ?? "current environment"}`}
                      >
                        <SelectValue>
                          {groupingOverride === "inherit"
                            ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                            : PROJECT_GROUPING_MODE_LABELS[groupingOverride]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        <SelectItem hideIndicator value="inherit">
                          Use global default
                        </SelectItem>
                        <SelectItem hideIndicator value="repository">
                          {PROJECT_GROUPING_MODE_LABELS.repository}
                        </SelectItem>
                        <SelectItem hideIndicator value="repository_path">
                          {PROJECT_GROUPING_MODE_LABELS.repository_path}
                        </SelectItem>
                        <SelectItem hideIndicator value="separate">
                          {PROJECT_GROUPING_MODE_LABELS.separate}
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Danger">
        <SettingsRow
          title={
            group.memberProjects.length > 1 ? "Remove this project everywhere" : "Remove project"
          }
          description={
            group.memberProjects.length > 1
              ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
              : "Deletes the project entry and its threads. Files on disk are not touched."
          }
          control={
            <Button
              variant="destructive-outline"
              onClick={() => void removeMembers(group.memberProjects)}
            >
              <Trash2Icon />
              {group.memberProjects.length > 1 ? "Remove all entries" : "Remove project"}
            </Button>
          }
        />
      </SettingsSection>

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={deleteScript}
        onClose={() => setEditorRequest(null)}
      />
      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        onSelect={(path) => void setFaviconPath(path)}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
    </SettingsPageContainer>
  );
}
