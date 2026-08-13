/**
 * Shared date fixtures for the suite.
 *
 * Several tests book a slot to exercise something else entirely — the slot
 * constraint, the Stripe return URLs, the sqft re-pricing — and each hard-coded
 * the same Monday in July 2026. That was already fragile and became wrong once
 * booking.create started enforcing a minimum lead time: a date in the past is
 * no longer bookable, so those fixtures failed for a reason that had nothing to
 * do with what they were testing.
 *
 * This gives them a date that is always a Monday (open under the default
 * schedule) and always far enough ahead to clear any configurable lead time,
 * however long after it was written the suite runs.
 */

/**
 * The first Monday at least `minDaysAhead` days from `now`, as "YYYY-MM-DD".
 * The default week of margin clears the 72-hour lead-time cap several times
 * over.
 */
export function upcomingMonday(now: Date = new Date(), minDaysAhead = 7): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + minDaysAhead);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** A Monday a week or more out: open under the default schedule, and bookable. */
export const OPEN_MONDAY = upcomingMonday();
