/**
 * Pure booking-slot rules shared by availability, booking creation, and the
 * stale-deposit expiry job. Kept free of DB imports so they are unit-testable.
 */

/**
 * Minutes an unpaid (pending_deposit) booking from the PUBLIC flow may hold its
 * calendar slot. Admin-created bookings pin their own, longer window — see
 * holdMinutesFor and shared/holdWindow.ts.
 */
export const STALE_DEPOSIT_MINUTES = 15;

/** Stripe Checkout itself cannot be created with less than a 30-minute expiry. */
export const STRIPE_CHECKOUT_SESSION_MINUTES = 30;

/**
 * The hold window that applies to one booking, in minutes.
 *
 * Read from the row, not from the setting, because the window is pinned when
 * the booking is created: raising the setting later must not resurrect a slot
 * that has already been released and given to someone else.
 *
 * NULL means a row written before the column existed. The current public hold
 * is deliberately used as the safe fallback; the cleanup migration/sweep
 * releases any legacy unpaid row already beyond that window.
 */
export function holdMinutesFor(booking: { holdMinutes?: number | null }): number {
  const pinned = booking.holdMinutes;
  if (typeof pinned !== "number" || !Number.isFinite(pinned) || pinned <= 0) {
    return STALE_DEPOSIT_MINUTES;
  }
  return pinned;
}

/**
 * Whether a booking should block its calendar slot.
 * - cancelled / expired bookings never block;
 * - unpaid (pending_deposit) bookings only block while fresh — after their own
 *   hold window the abandoned checkout releases the slot;
 * - every other status (confirmed, in_progress, completed) blocks.
 */
export function blocksSlot(
  booking: { status: string; createdAt: Date | string | null; holdMinutes?: number | null },
  now: Date = new Date()
): boolean {
  if (booking.status === "cancelled" || booking.status === "expired") return false;
  if (booking.status === "pending_deposit") {
    if (!booking.createdAt) return true;
    const created = new Date(booking.createdAt).getTime();
    if (!Number.isFinite(created)) return true;
    return now.getTime() - created < holdMinutesFor(booking) * 60_000;
  }
  return true;
}
