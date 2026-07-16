/**
 * Pure booking-slot rules shared by availability, booking creation, and the
 * stale-deposit expiry job. Kept free of DB imports so they are unit-testable.
 */

/** Minutes an unpaid (pending_deposit) booking may hold its calendar slot. */
export const STALE_DEPOSIT_MINUTES = 60;

/**
 * Whether a booking should block its calendar slot.
 * - cancelled / expired bookings never block;
 * - unpaid (pending_deposit) bookings only block while fresh — after
 *   STALE_DEPOSIT_MINUTES the abandoned checkout releases the slot;
 * - every other status (confirmed, in_progress, completed) blocks.
 */
export function blocksSlot(
  booking: { status: string; createdAt: Date | string | null },
  now: Date = new Date()
): boolean {
  if (booking.status === "cancelled" || booking.status === "expired") return false;
  if (booking.status === "pending_deposit") {
    if (!booking.createdAt) return true;
    const created = new Date(booking.createdAt).getTime();
    if (!Number.isFinite(created)) return true;
    return now.getTime() - created < STALE_DEPOSIT_MINUTES * 60_000;
  }
  return true;
}
