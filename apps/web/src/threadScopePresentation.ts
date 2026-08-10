import {
  normalizeThreadScopeLinkedPaths,
  normalizeThreadScopePath,
  THREAD_SCOPE_COLORS,
  threadScopePathLabel,
  type ThreadScopeColor,
} from "@t3tools/contracts";

/**
 * Stable selector so sidebar rows re-render on color changes only, not on
 * every unrelated settings write.
 */
export function selectThreadScopeColors(settings: {
  readonly threadScopeColors: Readonly<Record<string, ThreadScopeColor>>;
}): Readonly<Record<string, ThreadScopeColor>> {
  return settings.threadScopeColors;
}

export interface ThreadScopeSummary {
  readonly focusPath: string;
  readonly label: string;
  readonly linkedCount: number;
  readonly color: ThreadScopeColor;
  /** Full text for tooltips: the focus folder and every linked folder. */
  readonly title: string;
}

/**
 * Stable per-path color so an unconfigured folder still reads consistently
 * from session to session. Small palette, so collisions are expected and
 * harmless — the user can pin any folder to a specific color.
 */
export function deriveThreadScopeColor(path: string): ThreadScopeColor {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) | 0;
  }
  const bucket = Math.abs(hash) % THREAD_SCOPE_COLORS.length;
  return THREAD_SCOPE_COLORS[bucket] ?? "blue";
}

export function resolveThreadScopeColor(
  path: string,
  overrides: Readonly<Record<string, ThreadScopeColor>> | undefined,
): ThreadScopeColor {
  return overrides?.[path] ?? deriveThreadScopeColor(path);
}

/**
 * What a sidebar row renders for a thread's scope, or null when the thread is
 * unscoped and should show no chip at all.
 */
export function summarizeThreadScope(
  thread: {
    readonly focusPath?: string | null | undefined;
    readonly linkedPaths?: ReadonlyArray<string> | undefined;
  },
  overrides?: Readonly<Record<string, ThreadScopeColor>>,
): ThreadScopeSummary | null {
  const focusPath = normalizeThreadScopePath(thread.focusPath);
  if (focusPath === null) {
    return null;
  }
  const linkedPaths = normalizeThreadScopeLinkedPaths(thread.linkedPaths, { focusPath });
  return {
    focusPath,
    label: threadScopePathLabel(focusPath),
    linkedCount: linkedPaths.length,
    color: resolveThreadScopeColor(focusPath, overrides),
    title:
      linkedPaths.length === 0 ? focusPath : `${focusPath} · linked: ${linkedPaths.join(", ")}`,
  };
}

/** Tailwind classes per palette entry, tuned to stay readable in both themes. */
export const THREAD_SCOPE_COLOR_CLASSES: Record<ThreadScopeColor, string> = {
  blue: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  green: "bg-green-500/12 text-green-700 dark:text-green-300",
  purple: "bg-purple-500/12 text-purple-700 dark:text-purple-300",
  orange: "bg-orange-500/12 text-orange-700 dark:text-orange-300",
  pink: "bg-pink-500/12 text-pink-700 dark:text-pink-300",
  teal: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
  amber: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
};

/** Solid swatch classes for the color picker in the scope menu. */
export const THREAD_SCOPE_SWATCH_CLASSES: Record<ThreadScopeColor, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
  teal: "bg-teal-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
};
