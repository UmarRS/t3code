import type { OrchestrationIssue } from "@t3tools/contracts";

import type { ProjectAccent } from "../../sidebarProjectPrefsStore";
import type { AutonomousStatusPresentation } from "./autonomousRun.logic";
import type { IssueColumnAccent } from "./IssuesBoard.logic";

/**
 * A project's identity colour, as classes. Written out per accent rather than
 * composed so Tailwind sees whole class names, and shared by every surface
 * that paints a project — the overview cards and the overall board's chips —
 * so one project reads as one colour wherever it appears.
 */
export const PROJECT_ACCENT_CLASSES: Record<
  ProjectAccent,
  { readonly bar: string; readonly icon: string; readonly badge: string }
> = {
  blue: {
    bar: "bg-blue-500",
    icon: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    badge: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  teal: {
    bar: "bg-teal-500",
    icon: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
    badge: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  purple: {
    bar: "bg-purple-500",
    icon: "bg-purple-500/12 text-purple-700 dark:text-purple-300",
    badge: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  },
  orange: {
    bar: "bg-orange-500",
    icon: "bg-orange-500/12 text-orange-700 dark:text-orange-300",
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  pink: {
    bar: "bg-pink-500",
    icon: "bg-pink-500/12 text-pink-700 dark:text-pink-300",
    badge: "bg-pink-500/10 text-pink-700 dark:text-pink-300",
  },
  green: {
    bar: "bg-green-500",
    icon: "bg-green-500/12 text-green-700 dark:text-green-300",
    badge: "bg-green-500/10 text-green-700 dark:text-green-300",
  },
};

export const PROJECT_ACCENT_LABELS: Record<ProjectAccent, string> = {
  blue: "Blue",
  teal: "Teal",
  purple: "Purple",
  orange: "Orange",
  pink: "Pink",
  green: "Green",
};

/**
 * The column rule's colour per pipeline state. Written out rather than
 * composed so Tailwind sees whole class names, and drawn from the semantic
 * tokens so it follows the active theme instead of pinning a palette.
 */
export const ISSUE_COLUMN_ACCENT_CLASS: Record<IssueColumnAccent, string> = {
  waiting: "bg-border",
  active: "bg-info",
  review: "bg-update",
  finished: "bg-success/60",
};

export const PRIORITY_DOT_CLASS: Record<NonNullable<OrchestrationIssue["priority"]>, string> = {
  urgent: "bg-destructive",
  high: "bg-amber-500",
  medium: "bg-sky-500",
  low: "bg-muted-foreground/50",
};

/**
 * The run readout as a pill: a tinted surface for the label and a dot that
 * carries the tone on its own, for rows too narrow to read the words.
 */
export const RUN_TONE_CLASS: Record<
  AutonomousStatusPresentation["tone"],
  { readonly pill: string; readonly dot: string }
> = {
  active: { pill: "bg-info/10 text-info-foreground", dot: "bg-info" },
  complete: { pill: "bg-success/10 text-success", dot: "bg-success" },
  stopped: { pill: "bg-warning-surface text-warning", dot: "bg-warning" },
  idle: { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" },
};
