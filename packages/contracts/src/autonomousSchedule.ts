/**
 * Scheduled autonomous runs: per-project wall-clock times at which the server
 * starts an autonomous run on its own.
 *
 * The format is deliberately the one macOS uses for auto-wake rather than cron:
 * a time of day, an optional set of weekdays, and an on/off switch. Times are
 * read in the server's own timezone, because the server is the machine that has
 * to be awake to do the work.
 *
 * Matching lives here so the server's ticker and the settings UI can never
 * disagree about when an entry is due.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** How many entries one project may hold. Bounded so a tick stays cheap. */
export const MAX_AUTONOMOUS_SCHEDULE_ENTRIES = 24;

/** `0` is Sunday through `6` is Saturday, matching `Date.prototype.getDay`. */
export const ScheduleDayOfWeek = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));
export type ScheduleDayOfWeek = typeof ScheduleDayOfWeek.Type;

/** A wall-clock `HH:MM` on a 24-hour dial. */
export const ScheduleTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type ScheduleTimeOfDay = typeof ScheduleTimeOfDay.Type;

export const ProjectAutonomousScheduleEntry = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  time: ScheduleTimeOfDay,
  /** Empty means every day, so a new entry needs no weekday decision. */
  daysOfWeek: Schema.Array(ScheduleDayOfWeek),
  /** Off keeps an entry the user configured without firing it. */
  enabled: Schema.Boolean,
});
export type ProjectAutonomousScheduleEntry = typeof ProjectAutonomousScheduleEntry.Type;

export const ProjectAutonomousSchedule = Schema.Array(ProjectAutonomousScheduleEntry).check(
  Schema.isMaxLength(MAX_AUTONOMOUS_SCHEDULE_ENTRIES),
);
export type ProjectAutonomousSchedule = typeof ProjectAutonomousSchedule.Type;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The local `HH:MM` an instant falls on, in the runtime's own timezone. */
export function localTimeOfDay(at: Date): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
export function localDateKey(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/**
 * Whether an entry is due at `at`. Seconds are ignored: an entry owns a minute,
 * and the ticker evaluates each minute exactly once.
 */
export function scheduleEntryMatches(entry: ProjectAutonomousScheduleEntry, at: Date): boolean {
  if (!entry.enabled) return false;
  if (entry.time !== localTimeOfDay(at)) return false;
  return entry.daysOfWeek.length === 0 || entry.daysOfWeek.includes(at.getDay());
}

/** Every entry due at `at`, in the order the project lists them. */
export function scheduleEntriesDueAt(
  schedule: ReadonlyArray<ProjectAutonomousScheduleEntry>,
  at: Date,
): ReadonlyArray<ProjectAutonomousScheduleEntry> {
  return schedule.filter((entry) => scheduleEntryMatches(entry, at));
}

/**
 * The slot an entry firing belongs to. Used as the command id of the enable it
 * dispatches, so the same slot can only ever be accepted once — command
 * receipts are persisted, which makes this hold across a restart too.
 */
export function autonomousScheduleSlotKey(
  projectId: string,
  entry: ProjectAutonomousScheduleEntry,
  at: Date,
): string {
  return `autonomous-schedule:${projectId}:${localDateKey(at)}:${entry.time}:${entry.id}`;
}
