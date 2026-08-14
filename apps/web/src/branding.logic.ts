const NIGHTLY_SERVER_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

// Stages that ship as the plain product name. Everything else is suffixed so a
// non-release build is always identifiable from the window title alone.
const UNSUFFIXED_STAGE_LABELS = new Set(["latest", "release"]);

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (UNSUFFIXED_STAGE_LABELS.has(input.stageLabel.trim().toLowerCase())) {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
