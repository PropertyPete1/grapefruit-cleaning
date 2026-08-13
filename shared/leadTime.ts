/**
 * Minimum booking lead time — how far ahead of now a slot has to start before
 * a customer may take it.
 *
 * Stored as a plain integer hour count in the `booking_lead_time_hours` site
 * setting, alongside the weekly `booking_schedule`. 0 disables the rule; the
 * cap keeps an accidental extra digit from closing the calendar for months.
 *
 * The comparison happens against wall-clock time in America/Chicago, not the
 * server's UTC clock: a booking row stores "2026-08-13" + "15:00" meaning three
 * in the afternoon *in San Antonio*, and treating that as UTC would shift every
 * decision by five or six hours depending on the season.
 *
 * This rule only ever removes slots. It is applied on top of the weekly
 * schedule (open days, opening hours, the Sunday toggle) and the taken-slot
 * list, never instead of them.
 */

/** Setting key that stores the admin-configured lead time, in whole hours. */
export const LEAD_TIME_SETTING_KEY = "booking_lead_time_hours";

/** Hours of notice required when the admin has not configured anything. */
export const DEFAULT_LEAD_TIME_HOURS = 3;

/** Upper bound the admin can set (3 days). */
export const MAX_LEAD_TIME_HOURS = 72;

/** The business's own clock. Slot dates and times are wall time in this zone. */
export const BOOKING_TIMEZONE = "America/Chicago";

/** True for an integer hour count the admin is allowed to store. */
export function isValidLeadTimeHours(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_LEAD_TIME_HOURS
  );
}

/**
 * The hour count a stored setting string stands for, or null when it is not a
 * value the booking rules would honour.
 *
 * The save path and the read path both go through this, so they can never
 * disagree about what a stored string means. Without it they do: Number("") is
 * 0, so a blank value looks like a deliberate "disabled" to a validator and
 * like "nothing configured" to a reader.
 */
export function readLeadTimeHours(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return isValidLeadTimeHours(parsed) ? parsed : null;
}

/**
 * Parse the stored lead-time setting. Missing, blank, non-integer, or
 * out-of-range input falls back to the default rather than to "no rule", the
 * same way parseSchedule falls back to the default hours: a corrupt setting
 * must never quietly reopen the calendar.
 */
export function parseLeadTimeHours(raw: string | null | undefined): number {
  return readLeadTimeHours(raw) ?? DEFAULT_LEAD_TIME_HOURS;
}

const zoneFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: BOOKING_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * Offset of America/Chicago from UTC at a given instant, in milliseconds
 * (negative — Chicago is behind UTC). Read from Intl rather than hard-coded so
 * daylight saving is handled by the platform's tz data instead of by us.
 */
function zoneOffsetMs(instantMs: number): number {
  const parts = zoneFormat.formatToParts(new Date(instantMs));
  const field = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second")
  );
  return asIfUtc - instantMs;
}

/**
 * The real instant a "YYYY-MM-DD" + "HH:MM" slot starts, reading both as wall
 * time in America/Chicago.
 *
 * Two passes: the first guesses with the offset in effect around that
 * wall-clock reading, the second re-reads the offset at the instant that guess
 * landed on. That is what puts a slot on the correct side of a daylight-saving
 * change, where the offset before and after the boundary differ by an hour.
 */
export function slotStartInstant(dateStr: string, time: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClock = Date.UTC(year!, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  const firstGuess = wallClock - zoneOffsetMs(wallClock);
  return wallClock - zoneOffsetMs(firstGuess);
}

/**
 * Whether a slot starts far enough ahead to be offered.
 *
 * The boundary is inclusive: a slot exactly `leadTimeHours` away is still
 * offerable, one minute inside the window is not. A lead time of 0 disables
 * the rule entirely.
 */
export function slotMeetsLeadTime(
  dateStr: string,
  time: string,
  leadTimeHours: number,
  now: Date = new Date()
): boolean {
  if (leadTimeHours <= 0) return true;
  return slotStartInstant(dateStr, time) - now.getTime() >= leadTimeHours * 3_600_000;
}

// Composing this rule with the schedule, existing bookings and closing time
// lives in shared/availability.ts, so there is exactly one place that decides
// what a customer may book.
