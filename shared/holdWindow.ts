/**
 * How long an unpaid booking may hold its calendar slot.
 *
 * The public flow holds for one hour (STALE_DEPOSIT_MINUTES in
 * server/bookingRules.ts): a customer who reached Stripe and wandered off is
 * either coming back within the hour or is not coming back at all, and the slot
 * should not sit dead for longer than that.
 *
 * An admin-created booking is a different situation. The owner has taken a
 * phone or text lead, quoted them, and sent a personal deposit link — that
 * customer is often at work, or wants to check with a partner first, and
 * releasing their slot after an hour would give away the appointment they were
 * just promised. So it holds for a day by default, and the owner can change it
 * here rather than in the source.
 *
 * Stored as a plain integer hour count in `admin_booking_hold_hours`, the same
 * shape as the lead-time setting, and read through the same kind of parser so
 * the save path and the read path can never disagree about what a stored string
 * means.
 */

/** Setting key holding the admin-created hold window, in whole hours. */
export const ADMIN_HOLD_SETTING_KEY = "admin_booking_hold_hours";

/** Hours an admin-created booking holds its slot when nothing is configured. */
export const DEFAULT_ADMIN_HOLD_HOURS = 24;

/**
 * Upper bound the owner can set (7 days).
 *
 * A cap at all because the hold is a slot nobody else can book: an accidental
 * extra digit would quietly wall off an appointment for months.
 */
export const MAX_ADMIN_HOLD_HOURS = 168;

/** Lower bound — an hour, matching the public flow. Below that is a typo. */
export const MIN_ADMIN_HOLD_HOURS = 1;

/** True for an hour count the booking rules are willing to store. */
export function isValidAdminHoldHours(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ADMIN_HOLD_HOURS &&
    value <= MAX_ADMIN_HOLD_HOURS
  );
}

/**
 * The hour count a stored setting string stands for, or null when it is not a
 * value the rules would honour. Blank is null rather than 0 — the same trap
 * readLeadTimeHours exists to avoid.
 */
export function readAdminHoldHours(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return isValidAdminHoldHours(parsed) ? parsed : null;
}

/**
 * Parse the stored hold window. Missing, blank or out-of-range input falls back
 * to the default rather than to the public one-hour window: a corrupt setting
 * must not quietly start releasing phone leads after an hour.
 */
export function parseAdminHoldHours(raw: string | null | undefined): number {
  return readAdminHoldHours(raw) ?? DEFAULT_ADMIN_HOLD_HOURS;
}

/** The stored window as the minute count pinned onto a booking row. */
export function adminHoldMinutes(raw: string | null | undefined): number {
  return parseAdminHoldHours(raw) * 60;
}
