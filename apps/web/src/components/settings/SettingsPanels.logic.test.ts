import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { getBackgroundActivityPresetSettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  getChangedTypographySettingLabels,
  groupArchivedThreadsByProject,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";

describe("typography settings restore", () => {
  it("detects family and size changes by font row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 18,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
  });
});

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("detects a legacy profile override so restoring defaults clears it", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivityProfile: "performance",
      }),
    ).toBe(true);
  });

  it("shows the effective legacy preset and marks custom legacy intervals as advanced", () => {
    const performance = getBackgroundActivityPresetSettings("performance");
    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: performance.automaticGitFetchInterval,
        providerHealthRefreshInterval: performance.providerHealthRefreshInterval,
      }),
    ).toBe("performance");

    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe("advanced");
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("project grouping toggle", () => {
  it("enables repository grouping and disables into separate projects", () => {
    expect(isProjectGroupingEnabled("repository")).toBe(true);
    expect(isProjectGroupingEnabled("repository_path")).toBe(true);
    expect(isProjectGroupingEnabled("separate")).toBe(false);
    expect(projectGroupingModeFromToggle(true)).toBe("repository");
    expect(projectGroupingModeFromToggle(false)).toBe("separate");
  });

  it("restores repository path grouping when the toggle is cycled", () => {
    expect(projectGroupingModeFromToggle(false, "repository_path")).toBe("separate");
    expect(projectGroupingModeFromToggle(true, "repository_path")).toBe("repository_path");
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("groupArchivedThreadsByProject", () => {
  const envA = EnvironmentId.make("env-a");
  const projectA = {
    id: "project-a",
    environmentId: envA,
    name: "Project A",
    cwd: "/repo/a",
    faviconPath: null,
  };
  const projectB = {
    id: "project-b",
    environmentId: envA,
    name: "Project B",
    cwd: "/repo/b",
    faviconPath: null,
  };
  const thread = (input: {
    id: string;
    projectId: string;
    archivedAt?: string | null;
    createdAt?: string;
  }) => ({
    id: input.id,
    environmentId: envA,
    projectId: input.projectId,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? "2026-03-01T00:00:00.000Z",
  });

  it("groups threads under their project, most recently archived first", () => {
    const groups = groupArchivedThreadsByProject(
      [
        thread({ id: "1", projectId: "project-a", archivedAt: "2026-03-01T10:00:00.000Z" }),
        thread({ id: "2", projectId: "project-a", archivedAt: "2026-03-05T10:00:00.000Z" }),
      ],
      [projectA],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.project.name).toBe("Project A");
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["2", "1"]);
  });

  it("produces one section per project, skipping projects with no archived threads", () => {
    const groups = groupArchivedThreadsByProject(
      [thread({ id: "1", projectId: "project-a" }), thread({ id: "2", projectId: "project-b" })],
      [projectA, projectB],
    );

    expect(groups.map((group) => group.project.name)).toEqual(["Project A", "Project B"]);
  });

  it("pools threads whose project no longer exists into a trailing Unknown project group", () => {
    const groups = groupArchivedThreadsByProject(
      [
        thread({ id: "1", projectId: "project-a" }),
        thread({ id: "2", projectId: "deleted-project" }),
      ],
      [projectA],
    );

    expect(groups.map((group) => group.project.name)).toEqual(["Project A", "Unknown project"]);
    expect(groups.at(-1)?.threads.map((t) => t.id)).toEqual(["2"]);
  });

  it("returns no groups when there are no archived threads", () => {
    expect(groupArchivedThreadsByProject([], [projectA])).toEqual([]);
  });
});
