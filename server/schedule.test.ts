import { describe, expect, it } from "vitest";
import {
  DEFAULT_LUNCH_BREAK,
  DEFAULT_SCHEDULE,
  dayOfWeek,
  LUNCH_HOUR,
  parseLunchBreak,
  parseSchedule,
  slotsForDate,
  slotsForDay,
} from "@shared/schedule";

describe("booking schedule defaults", () => {
  it("keeps Sunday closed by default", () => {
    expect(DEFAULT_SCHEDULE[0].open).toBe(false);
    expect(slotsForDay(DEFAULT_SCHEDULE[0])).toEqual([]);
  });

  it("Monday–Friday run 8 AM to 6 PM (last slot 5 PM), noon included by default", () => {
    for (const day of [1, 2, 3, 4, 5]) {
      const slots = slotsForDay(DEFAULT_SCHEDULE[day]);
      expect(slots[0]).toBe("08:00");
      expect(slots[slots.length - 1]).toBe("17:00");
      expect(slots).toContain("12:00");
      expect(slots).toHaveLength(10); // 8..17 inclusive
    }
  });

  it("Saturday runs 8 AM to 4 PM (last slot 3 PM)", () => {
    const slots = slotsForDay(DEFAULT_SCHEDULE[6]);
    expect(slots[0]).toBe("08:00");
    expect(slots[slots.length - 1]).toBe("15:00");
    expect(slots).toContain("12:00");
  });
});

describe("the lunch break", () => {
  it("is off unless the admin turns it on", () => {
    expect(DEFAULT_LUNCH_BREAK).toBe(false);
    expect(slotsForDay(DEFAULT_SCHEDULE[1])).toContain("12:00");
  });

  it("removes only the noon slot when on, leaving the rest of the day intact", () => {
    const open = slotsForDay(DEFAULT_SCHEDULE[1], false);
    const withLunch = slotsForDay(DEFAULT_SCHEDULE[1], true);
    expect(withLunch).not.toContain("12:00");
    expect(withLunch).toHaveLength(open.length - 1);
    expect(withLunch).toEqual(open.filter(t => t !== "12:00"));
  });

  it("reserves LUNCH_HOUR rather than a hardcoded 12", () => {
    expect(LUNCH_HOUR).toBe(12);
    const slots = slotsForDay({ open: true, start: 8, end: 18 }, true);
    expect(slots).not.toContain(`${String(LUNCH_HOUR).padStart(2, "0")}:00`);
  });

  it("does nothing on a day that never reaches noon", () => {
    const morning = { open: true, start: 8, end: 11 };
    expect(slotsForDay(morning, true)).toEqual(slotsForDay(morning, false));
  });

  it("keeps a closed day closed", () => {
    expect(slotsForDay(DEFAULT_SCHEDULE[0], true)).toEqual([]);
  });

  it("applies per date through slotsForDate", () => {
    // 2026-07-22 is a Wednesday.
    expect(slotsForDate("2026-07-22", DEFAULT_SCHEDULE)).toContain("12:00");
    expect(slotsForDate("2026-07-22", DEFAULT_SCHEDULE, true)).not.toContain("12:00");
  });
});

describe("parseLunchBreak", () => {
  it("reads a stored true", () => {
    expect(parseLunchBreak("true")).toBe(true);
    expect(parseLunchBreak("TRUE")).toBe(true);
    expect(parseLunchBreak("  true  ")).toBe(true);
  });

  it("treats missing, blank and garbage as no break", () => {
    // The permissive direction on purpose: a corrupt setting must not close a
    // slot the owner never asked to close.
    expect(parseLunchBreak(null)).toBe(false);
    expect(parseLunchBreak(undefined)).toBe(false);
    expect(parseLunchBreak("")).toBe(false);
    expect(parseLunchBreak("yes")).toBe(false);
    expect(parseLunchBreak("1")).toBe(false);
    expect(parseLunchBreak("{}")).toBe(false);
  });

  it("reads a stored false", () => {
    expect(parseLunchBreak("false")).toBe(false);
  });
});

describe("parseSchedule", () => {
  it("falls back to defaults on null, garbage, and invalid JSON", () => {
    expect(parseSchedule(null)).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule("")).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule("not-json")).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule('{"0":{"open":true,"start":25,"end":3}}')).toEqual(DEFAULT_SCHEDULE);
  });

  it("applies a valid admin override (Sunday manually enabled)", () => {
    const raw = JSON.stringify({ 0: { open: true, start: 10, end: 14 } });
    const schedule = parseSchedule(raw);
    expect(schedule[0]).toEqual({ open: true, start: 10, end: 14 });
    // untouched days keep defaults
    expect(schedule[1]).toEqual(DEFAULT_SCHEDULE[1]);
    expect(slotsForDay(schedule[0])).toEqual(["10:00", "11:00", "12:00", "13:00"]);
    expect(slotsForDay(schedule[0], true)).toEqual(["10:00", "11:00", "13:00"]);
  });

  it("ignores partially invalid days while keeping valid ones", () => {
    const raw = JSON.stringify({
      0: { open: true, start: 9, end: 13 },
      3: { open: "yes", start: 8, end: 18 }, // invalid → default kept
    });
    const schedule = parseSchedule(raw);
    expect(schedule[0].open).toBe(true);
    expect(schedule[3]).toEqual(DEFAULT_SCHEDULE[3]);
  });
});

describe("date handling", () => {
  it("maps YYYY-MM-DD to the right weekday without timezone drift", () => {
    expect(dayOfWeek("2026-07-19")).toBe(0); // Sunday
    expect(dayOfWeek("2026-07-20")).toBe(1); // Monday
    expect(dayOfWeek("2026-07-25")).toBe(6); // Saturday
  });

  it("returns no slots for a Sunday under the default schedule", () => {
    expect(slotsForDate("2026-07-19", DEFAULT_SCHEDULE)).toEqual([]);
  });

  it("returns Saturday slots ending at 15:00 under the default schedule", () => {
    const slots = slotsForDate("2026-07-25", DEFAULT_SCHEDULE);
    expect(slots[slots.length - 1]).toBe("15:00");
  });
});
