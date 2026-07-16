/**
 * Booking schedule — settings-driven weekly hours.
 *
 * Defaults (used when the admin has not customized anything):
 *   Monday–Friday: 8:00 AM – 6:00 PM
 *   Saturday:      8:00 AM – 4:00 PM
 *   Sunday:        Closed (bookings blocked unless manually enabled by admin)
 *
 * The admin can override any day via the `booking_schedule` site setting
 * (JSON). Slots are hourly, starting on the hour; the last slot starts one
 * hour before closing time. The legacy lunch-hour gap (no 12:00 slot) is
 * preserved for the default schedule via `skipHours`.
 */

export interface DaySchedule {
  /** Whether bookings are allowed on this day. */
  open: boolean;
  /** Opening hour, 0-23 (first slot starts at this hour). */
  start: number;
  /** Closing hour, 0-23 (last slot starts at end - 1). */
  end: number;
}

/** Keyed by JS Date.getDay(): 0=Sunday … 6=Saturday. */
export type WeeklySchedule = Record<number, DaySchedule>;

export const DEFAULT_SCHEDULE: WeeklySchedule = {
  0: { open: false, start: 8, end: 16 }, // Sunday — closed by default
  1: { open: true, start: 8, end: 18 },
  2: { open: true, start: 8, end: 18 },
  3: { open: true, start: 8, end: 18 },
  4: { open: true, start: 8, end: 18 },
  5: { open: true, start: 8, end: 18 },
  6: { open: true, start: 8, end: 16 }, // Saturday 8–4
};

/** Setting key that stores the admin-customized schedule as JSON. */
export const SCHEDULE_SETTING_KEY = "booking_schedule";

function isValidDay(d: unknown): d is DaySchedule {
  if (typeof d !== "object" || d === null) return false;
  const v = d as Record<string, unknown>;
  return (
    typeof v.open === "boolean" &&
    typeof v.start === "number" &&
    typeof v.end === "number" &&
    Number.isInteger(v.start) &&
    Number.isInteger(v.end) &&
    v.start >= 0 &&
    v.start <= 23 &&
    v.end >= 1 &&
    v.end <= 24 &&
    v.start < v.end
  );
}

/**
 * Parse a stored schedule setting. Invalid or missing input falls back to
 * the defaults so the booking flow never breaks.
 */
export function parseSchedule(raw: string | null | undefined): WeeklySchedule {
  if (!raw) return DEFAULT_SCHEDULE;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: WeeklySchedule = { ...DEFAULT_SCHEDULE };
    for (let day = 0; day <= 6; day++) {
      const candidate = parsed[String(day)];
      if (isValidDay(candidate)) result[day] = candidate;
    }
    return result;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

/**
 * Generate hourly slot strings ("HH:00") for a day schedule.
 * The 12:00 lunch hour is skipped to preserve the site's original
 * booking pattern (crew lunch break).
 */
export function slotsForDay(day: DaySchedule): string[] {
  if (!day.open) return [];
  const slots: string[] = [];
  for (let h = day.start; h < day.end; h++) {
    if (h === 12) continue; // lunch hour
    slots.push(`${String(h).padStart(2, "0")}:00`);
  }
  return slots;
}

/** Day-of-week (0-6) for a "YYYY-MM-DD" date string, timezone-safe. */
export function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Slots available for a specific date under a weekly schedule. */
export function slotsForDate(dateStr: string, schedule: WeeklySchedule): string[] {
  return slotsForDay(schedule[dayOfWeek(dateStr)]);
}
