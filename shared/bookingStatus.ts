/**
 * Booking-status facts shared by the calendars, the appointments table and the
 * server queries behind them.
 *
 * A cancelled or expired booking has released its slot (the generated slotKey
 * is NULL for both), so it must not be drawn on a calendar as if the crew were
 * still going. The appointments table is the place that still lists them —
 * history is kept, the schedule is not cluttered with it.
 *
 * Lives in shared/ so the admin calendar, the staff calendar and the admin
 * router all ask the same predicate, instead of each keeping its own list of
 * "statuses that don't count".
 */

/** Statuses whose booking no longer occupies its calendar slot. */
export const RELEASED_STATUSES = ["cancelled", "expired"] as const;

export type ReleasedStatus = (typeof RELEASED_STATUSES)[number];

/** True while a booking still belongs on a calendar. */
export function holdsCalendarSlot(status: string): boolean {
  return !(RELEASED_STATUSES as readonly string[]).includes(status);
}

/**
 * Airbnb work, whichever road it arrived by: a feed-created turnover (kind
 * "ical_auto") or a self-serve / phone booking for the Airbnb service. One
 * predicate so the violet Airbnb color means the same thing on every screen.
 */
export function isAirbnbBooking(booking: { serviceType?: string | null; kind?: string | null }): boolean {
  return booking.serviceType === "airbnb" || booking.kind === "ical_auto";
}
