// @effect-diagnostics globalDate:off -- Schedules fire on local wall-clock instants, so the tests build them the same way.
import { describe, expect, it } from "vite-plus/test";

import {
  autonomousScheduleSlotKey,
  localDateKey,
  localTimeOfDay,
  scheduleEntriesDueAt,
  scheduleEntryMatches,
  type ProjectAutonomousScheduleEntry,
} from "./autonomousSchedule.ts";

const entry = (
  overrides: Partial<ProjectAutonomousScheduleEntry> = {},
): ProjectAutonomousScheduleEntry => ({
  id: "entry-1",
  time: "09:00",
  daysOfWeek: [],
  enabled: true,
  ...overrides,
});

/** Local wall-clock instants, because that is what the server schedules on. */
const at = (
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds = 0,
) => new Date(year, month - 1, day, hours, minutes, seconds);

// 2026-03-02 is a Monday.
const MONDAY_0900 = at(2026, 3, 2, 9, 0);
const SATURDAY_0900 = at(2026, 3, 7, 9, 0);

describe("scheduleEntryMatches", () => {
  it("matches the entry's minute regardless of seconds", () => {
    expect(scheduleEntryMatches(entry(), MONDAY_0900)).toBe(true);
    expect(scheduleEntryMatches(entry(), at(2026, 3, 2, 9, 0, 59))).toBe(true);
  });

  it("does not match a neighbouring minute", () => {
    expect(scheduleEntryMatches(entry(), at(2026, 3, 2, 8, 59))).toBe(false);
    expect(scheduleEntryMatches(entry(), at(2026, 3, 2, 9, 1))).toBe(false);
  });

  it("treats an empty day list as every day", () => {
    expect(scheduleEntryMatches(entry(), MONDAY_0900)).toBe(true);
    expect(scheduleEntryMatches(entry(), SATURDAY_0900)).toBe(true);
  });

  it("honours a day list", () => {
    const weekdays = entry({ daysOfWeek: [1, 2, 3, 4, 5] });
    expect(scheduleEntryMatches(weekdays, MONDAY_0900)).toBe(true);
    expect(scheduleEntryMatches(weekdays, SATURDAY_0900)).toBe(false);
  });

  it("never matches a disabled entry", () => {
    expect(scheduleEntryMatches(entry({ enabled: false }), MONDAY_0900)).toBe(false);
  });

  it("matches midnight, which is where a naive time comparison breaks", () => {
    expect(scheduleEntryMatches(entry({ time: "00:00" }), at(2026, 3, 2, 0, 0))).toBe(true);
  });
});

describe("scheduleEntriesDueAt", () => {
  it("returns every entry naming the minute, in list order", () => {
    const schedule = [
      entry({ id: "weekday", daysOfWeek: [1, 2, 3, 4, 5] }),
      entry({ id: "evening", time: "18:30" }),
      entry({ id: "daily" }),
      entry({ id: "off", enabled: false }),
    ];
    expect(scheduleEntriesDueAt(schedule, MONDAY_0900).map((due) => due.id)).toEqual([
      "weekday",
      "daily",
    ]);
  });

  it("returns nothing when the minute belongs to no entry", () => {
    expect(scheduleEntriesDueAt([entry()], at(2026, 3, 2, 10, 0))).toEqual([]);
  });
});

describe("autonomousScheduleSlotKey", () => {
  it("is stable for one slot and different across days, times and entries", () => {
    const key = autonomousScheduleSlotKey("project-1", entry(), MONDAY_0900);
    expect(autonomousScheduleSlotKey("project-1", entry(), at(2026, 3, 2, 9, 0, 42))).toBe(key);
    expect(autonomousScheduleSlotKey("project-1", entry(), at(2026, 3, 9, 9, 0))).not.toBe(key);
    expect(autonomousScheduleSlotKey("project-2", entry(), MONDAY_0900)).not.toBe(key);
    expect(autonomousScheduleSlotKey("project-1", entry({ id: "entry-2" }), MONDAY_0900)).not.toBe(
      key,
    );
  });
});

describe("local formatting", () => {
  it("zero-pads the wall clock and the calendar day", () => {
    expect(localTimeOfDay(at(2026, 3, 2, 7, 5))).toBe("07:05");
    expect(localDateKey(at(2026, 3, 2, 7, 5))).toBe("2026-03-02");
  });
});
