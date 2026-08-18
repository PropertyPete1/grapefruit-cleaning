/**
 * What a customer may actually book — every scheduling rule, composed in one
 * place.
 *
 * There are four of them, and they only ever subtract:
 *   1. the weekly schedule (open days, opening hours, the Sunday toggle, and
 *      the optional lunch break)
 *   2. the minimum lead time
 *   3. the hours already occupied by live bookings, for their FULL duration
 *   4. whether the job being booked finishes before closing time
 *
 * Rule 3 is the one that used to be missing. A booking occupied only the hour
 * it started in, so a four-hour deep clean from 11:00 left 12:00 and 13:00
 * showing free.
 *
 * Rule 4 restricts starts rather than letting work run past close: a three-hour
 * job cannot start at 16:00 against a 18:00 close. The alternative — offering
 * the slot and letting the crew finish late — silently commits someone else's
 * evening, so the start is what gives way.
 *
 * Occupancy is a half-open interval [start, start + hours). A job at 11:00 for
 * three hours occupies 11:00, 12:00 and 13:00, and leaves 14:00 free: the crew
 * is gone by the time that slot begins.
 *
 * Both callers go through here — the public availability query and the
 * server-side check in booking.create — so the calendar and the validator can
 * never disagree about what is bookable.
 */
import { slotMeetsLeadTime } from "./leadTime";
import { dayOfWeek, slotsForDate, type WeeklySchedule } from "./schedule";

/** A span of a day a crew is committed to. */
export interface OccupiedInterval {
  /** Start of the job, "HH:MM" wall clock. */
  time: string;
  /** Whole hours the crew is on site. */
  hours: number;
}

/** Hour-of-day for an "HH:MM" slot string. */
export function slotHour(time: string): number {
  return Number(time.slice(0, 2));
}

/**
 * The hourly slots an interval covers, half-open: a job at 11:00 for 3 hours
 * covers 11:00, 12:00 and 13:00, and not 14:00.
 *
 * Slots the schedule never offers — the lunch hour, when that break is on —
 * are included here anyway. They are hours the crew is genuinely working, and a
 * caller filtering against the schedule's own slot list drops them harmlessly.
 * This is also what makes the lunch break a start-time rule rather than dead
 * time: a job spanning noon still occupies it, so nothing else can be booked
 * across it.
 */
export function slotsCoveredBy(time: string, hours: number): string[] {
  const start = slotHour(time);
  const covered: string[] = [];
  for (let h = start; h < start + hours; h++) {
    covered.push(`${String(h).padStart(2, "0")}:00`);
  }
  return covered;
}

/** The hour an interval ends, "HH:MM". 23:00 + 3h clamps to 24:00. */
export function intervalEndTime(time: string, hours: number): string {
  const end = Math.min(24, slotHour(time) + hours);
  return `${String(end).padStart(2, "0")}:00`;
}

/**
 * The span a job occupies, for the crew and admin views: "11:00–15:00 · est.
 * 4h". Twenty-four hour clock, matching every other time the dashboards show.
 */
export function formatJobSpan(time: string, hours: number): string {
  return `${time}–${intervalEndTime(time, hours)} · est. ${hours}h`;
}

/** Whether two half-open [start, start + hours) intervals share any time. */
export function intervalsOverlap(a: OccupiedInterval, b: OccupiedInterval): boolean {
  const aStart = slotHour(a.time);
  const bStart = slotHour(b.time);
  return aStart < bStart + b.hours && bStart < aStart + a.hours;
}

/** Whether any occupied interval overlaps the given one. */
export function overlapsAny(candidate: OccupiedInterval, occupied: OccupiedInterval[]): boolean {
  return occupied.some(interval => intervalsOverlap(candidate, interval));
}

/**
 * Whether a job of `hours` starting at `time` finishes by closing time.
 *
 * The schedule's `end` is the hour the business closes, so a 3-hour job under a
 * 18:00 close may start no later than 15:00. A day with no schedule entry, or a
 * closed one, fits nothing.
 */
export function fitsBeforeClose(
  time: string,
  hours: number,
  dateStr: string,
  schedule: WeeklySchedule
): boolean {
  const day = schedule[dayOfWeek(dateStr)];
  if (!day || !day.open) return false;
  return slotHour(time) + hours <= day.end;
}

/** Everything the rules need to decide a day's slots. */
export interface AvailabilityContext {
  date: string;
  schedule: WeeklySchedule;
  /**
   * Whether the crew's lunch hour is reserved. Carried in the context rather
   * than read where it is needed, so the calendar and booking.create cannot
   * end up asking two different questions about the same day.
   */
  lunchBreak: boolean;
  leadTimeHours: number;
  /** Spans already committed on this date, by live bookings. */
  occupied: OccupiedInterval[];
  /**
   * How long the job being booked will take. Omitted when the caller does not
   * know yet (a calendar opened before the quote is complete): the closing-time
   * rule is then skipped, and booking.create — which always knows — enforces
   * it. Every other rule still applies.
   */
  jobHours?: number;
  now?: Date;
}

/** Whether one specific slot is bookable under every rule. */
export function isSlotBookable(context: AvailabilityContext, time: string): boolean {
  const { date, schedule, lunchBreak, leadTimeHours, occupied, jobHours, now } = context;
  if (!slotsForDate(date, schedule, lunchBreak).includes(time)) return false;
  if (!slotMeetsLeadTime(date, time, leadTimeHours, now)) return false;
  // The prospective job is one hour long at minimum, so even without a known
  // duration its own start hour must be free.
  if (overlapsAny({ time, hours: jobHours ?? 1 }, occupied)) return false;
  if (jobHours !== undefined && !fitsBeforeClose(time, jobHours, date, schedule)) return false;
  return true;
}

/**
 * Every slot the schedule offers on this date, each flagged bookable or not.
 *
 * The full list is returned rather than only the bookable ones: an empty list
 * is how the calendar says "we are closed that day", which would be the wrong
 * thing to say about a day that is open but fully committed.
 */
export function slotAvailability(context: AvailabilityContext): { time: string; available: boolean }[] {
  return slotsForDate(context.date, context.schedule, context.lunchBreak).map(time => ({
    time,
    available: isSlotBookable(context, time),
  }));
}

/** Just the bookable slots, for callers that only need the list. */
export function bookableSlots(context: AvailabilityContext): string[] {
  return slotAvailability(context)
    .filter(slot => slot.available)
    .map(slot => slot.time);
}
