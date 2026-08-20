/**
 * When a past customer may receive a re-booking nudge.
 *
 * Pure functions over plain data so the rules can be tested exhaustively
 * without a database, and so the same predicates read identically in the
 * sweep, in tests, and to a human auditing what we send.
 *
 * The cadence, in the owner's words: one nudge about 3–4 weeks after a
 * customer's last completed cleaning, then monthly at most, and never more
 * than one marketing email to the same person in any 21-day window.
 */

/** Days after the last completed cleaning before the first nudge is due. */
export const FIRST_NUDGE_DAYS = 24;

/** Days between subsequent nudges once the first has gone out. */
export const REPEAT_NUDGE_DAYS = 30;

/**
 * The legal floor: no two marketing emails to the same person inside this
 * window, whatever any other rule says. Checked last and independently, so a
 * future cadence change cannot accidentally breach it.
 */
export const MARKETING_COOLDOWN_DAYS = 21;

/** How many nudges a customer receives before we stop asking altogether. */
export const MAX_NUDGES = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/** Everything the decision needs about one customer. */
export interface NudgeCandidate {
  customerId: number;
  email: string | null;
  /** Most recent completed cleaning, or null if they have none. */
  lastCompletedAt: Date | null;
  /** True when they already have a booking on the calendar ahead of them. */
  hasUpcomingBooking: boolean;
  /** True when any invoice of theirs is unpaid — sent, overdue, or awaiting approval. */
  hasOpenInvoice: boolean;
  marketingUnsubscribedAt: Date | null;
  lastMarketingEmailAt: Date | null;
  marketingEmailCount: number;
}

export type NudgeDecision =
  | { send: true; nudgeNumber: number }
  | { send: false; reason: NudgeSkipReason };

export type NudgeSkipReason =
  | "no_email"
  | "unsubscribed"
  | "never_completed"
  | "has_upcoming_booking"
  | "open_invoice"
  | "too_soon_since_service"
  | "too_soon_since_last_nudge"
  | "cooldown"
  | "exhausted";

/**
 * Whether this customer should receive a nudge right now, and if not, why.
 *
 * Returning the reason rather than a bare boolean is deliberate: the sweep logs
 * it, which turns "why didn't Maria get one?" into a question with an answer
 * instead of an investigation.
 *
 * Order matters. Consent and suppression come first, so an unsubscribed
 * customer is never even evaluated against the cadence; the 21-day floor is
 * checked last and separately, as an absolute backstop over whatever the
 * cadence concluded.
 */
export function nudgeDecision(candidate: NudgeCandidate, now: Date): NudgeDecision {
  if (!candidate.email) return { send: false, reason: "no_email" };
  if (candidate.marketingUnsubscribedAt) return { send: false, reason: "unsubscribed" };

  // Nothing to invite them back to.
  if (!candidate.lastCompletedAt) return { send: false, reason: "never_completed" };

  // Already coming back — a "we miss you" to someone booked for Tuesday reads
  // as though we don't know our own calendar.
  if (candidate.hasUpcomingBooking) return { send: false, reason: "has_upcoming_booking" };

  // Never market to someone who owes us money. Ask for the balance, not for
  // more business.
  if (candidate.hasOpenInvoice) return { send: false, reason: "open_invoice" };

  if (candidate.marketingEmailCount >= MAX_NUDGES) return { send: false, reason: "exhausted" };

  const sinceService = daysBetween(candidate.lastCompletedAt, now);
  if (sinceService < FIRST_NUDGE_DAYS) return { send: false, reason: "too_soon_since_service" };

  if (candidate.lastMarketingEmailAt) {
    const sinceNudge = daysBetween(candidate.lastMarketingEmailAt, now);
    if (sinceNudge < REPEAT_NUDGE_DAYS) return { send: false, reason: "too_soon_since_last_nudge" };
    // The absolute floor, independent of the cadence above.
    if (sinceNudge < MARKETING_COOLDOWN_DAYS) return { send: false, reason: "cooldown" };
  }

  return { send: true, nudgeNumber: candidate.marketingEmailCount + 1 };
}
