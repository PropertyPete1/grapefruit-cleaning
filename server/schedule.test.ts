import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  dayOfWeek,
  parseSchedule,
  slotsForDate,
  slotsForDay,
} from "@shared/schedule";

describe("booking schedule defaults", () => {
  it("keeps Sunday closed by default", () => {
    expect(DEFAULT_SCHEDULE[0].open).toBe(false);
    expect(slotsForDay(DEFAULT_SCHEDULE[0])).toEqual([]);
  });

  it("Monday–Friday run 8 AM to 6 PM (last slot 5 PM), skipping the 12 PM lunch hour", () => {
    for (const day of [1, 2, 3, 4, 5]) {
      const slots = slotsForDay(DEFAULT_SCHEDULE[day]);
      expect(slots[0]).toBe("08:00");
      expect(slots[slots.length - 1]).toBe("17:00");
      expect(slots).not.toContain("12:00");
      expect(slots).toHaveLength(9); // 8..17 minus 12
    }
  });

  it("Saturday runs 8 AM to 4 PM (last slot 3 PM)", () => {
    const slots = slotsForDay(DEFAULT_SCHEDULE[6]);
    expect(slots[0]).toBe("08:00");
    expect(slots[slots.length - 1]).toBe("15:00");
    expect(slots).not.toContain("12:00");
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
    expect(slotsForDay(schedule[0])).toEqual(["10:00", "11:00", "13:00"]);
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
