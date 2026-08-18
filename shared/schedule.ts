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
 * hour before closing time.
 *
 * The 12:00 lunch gap the original site had is now the `booking_lunch_break`
 * setting, and it is OFF by default — noon is bookable unless the owner says
 * otherwise. It used to be hardcoded, which is a policy the code had no
 * business deciding on its own.
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

/** Setting key that stores whether the crew's lunch hour is reserved. */
export const LUNCH_SETTING_KEY = "booking_lunch_break";

/**
 * The hour reserved when the lunch break is on. Noon, as it always was.
 *
 * A single hour rather than a configurable window: the owner asked for the old
 * behaviour back as a switch, not for a lunch scheduler, and every extra knob
 * here is one more way for the calendar and the validator to disagree.
 */
export const LUNCH_HOUR = 12;

/**
 * Whether the lunch break is reserved when the admin has not chosen.
 *
 * OFF. The hardcoded skip predates the setting, and the owner noticed noon had
 * gone missing and asked where it went — so the shipped default is the answer
 * to that question, not to what the code used to do.
 */
export const DEFAULT_LUNCH_BREAK = false;

/**
 * Parse the stored lunch-break setting. Anything other than a stored "true" —
 * missing, blank, garbage — means no break, which is both the default and the
 * more permissive reading: a corrupt setting must not quietly close a slot the
 * owner never asked to close.
 */
export function parseLunchBreak(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return DEFAULT_LUNCH_BREAK;
  return raw.trim().toLowerCase() === "true";
}

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
 *
 * `lunchBreak` reserves LUNCH_HOUR, and only as a START time. A job booked at
 * 11:00 that runs three hours still works through noon — the break takes an
 * hour out of the booking grid, it does not interrupt a cleaning already under
 * way. Enforcing it as dead time inside a job would mean either stretching
 * every span that crosses noon or refusing to book across it at all, and both
 * cost the owner far more slots than the setting is worth. See the note on
 * slotsCoveredBy in availability.ts, which deliberately counts the lunch hour
 * as occupied when a job spans it.
 */
export function slotsForDay(day: DaySchedule, lunchBreak: boolean = DEFAULT_LUNCH_BREAK): string[] {
  if (!day.open) return [];
  const slots: string[] = [];
  for (let h = day.start; h < day.end; h++) {
    if (lunchBreak && h === LUNCH_HOUR) continue;
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
export function slotsForDate(
  dateStr: string,
  schedule: WeeklySchedule,
  lunchBreak: boolean = DEFAULT_LUNCH_BREAK
): string[] {
  return slotsForDay(schedule[dayOfWeek(dateStr)], lunchBreak);
}
