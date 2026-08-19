/**
 * Pure remaining-balance rules shared by the completion flow, the payment-link
 * route, and the admin invoice list. Kept free of DB and Stripe imports so they
 * are unit-testable (same shape as bookingRules.ts).
 */

/** Days an emailed balance payment link stays valid. */
export const BALANCE_LINK_DAYS = 7;

/**
 * Maximum lifetime Stripe allows for a single Checkout Session (30 minutes to
 * 24 hours from creation). The customer-facing link outlives this: it points at
 * /api/pay/balance/:token, which mints a fresh session on each visit for as
 * long as the invoice's own BALANCE_LINK_DAYS window is open.
 */
export const STRIPE_SESSION_MAX_SECONDS = 24 * 60 * 60;

/**
 * Remaining balance for a completed booking, in whole dollars.
 *
 * Server-authoritative: derived only from the amounts stored on the booking at
 * checkout time. Coupons need no special case — a discount is already baked
 * into totalAmount when the booking is created, so a 100% coupon (or any
 * deposit that covers the total) simply lands on 0 here.
 */
export function computeBalanceDue(booking: { totalAmount: number; depositAmount: number }): number {
  const total = Math.round(Number(booking.totalAmount) || 0);
  const deposit = Math.round(Number(booking.depositAmount) || 0);
  return Math.max(0, total - deposit);
}

/** End of the payment link's validity window, BALANCE_LINK_DAYS after `now`. */
export function balanceLinkExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + BALANCE_LINK_DAYS * 24 * 60 * 60 * 1000);
}

/** Expiry to hand Stripe for a single Checkout Session, in epoch seconds. */
export function stripeSessionExpiresAt(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + STRIPE_SESSION_MAX_SECONDS;
}

export type BalanceLinkStatus = "none" | "awaiting_approval" | "sent" | "paid" | "expired";

/**
 * Payment-link state shown in Admin → Invoices.
 * - "awaiting_approval": balance computed, waiting on an admin — nothing sent.
 * - "none": no link was ever generated (manual invoices, zero-balance invoices).
 * - "paid": settled, by card or in person — a paid invoice is never "expired".
 * - "expired": the 7-day window closed with the balance still outstanding.
 * - "sent": link is live and payable.
 */
export function balanceLinkStatus(
  invoice: { status: string; payToken?: string | null; linkExpiresAt?: Date | string | null },
  now: Date = new Date()
): BalanceLinkStatus {
  // Checked first: an invoice pending review has no link yet, but "awaiting
  // approval" is what the owner needs to see, not "none".
  if (invoice.status === "awaiting_approval") return "awaiting_approval";
  // Checked before status so a zero-balance invoice — auto-marked paid without
  // ever issuing a link — doesn't claim a link was paid.
  if (!invoice.payToken) return "none";
  if (invoice.status === "paid") return "paid";
  if (!invoice.linkExpiresAt) return "sent";
  const expires = new Date(invoice.linkExpiresAt).getTime();
  if (!Number.isFinite(expires)) return "sent";
  return expires <= now.getTime() ? "expired" : "sent";
}

/**
 * Automatic follow-ups for an unpaid balance link: a polite reminder 3 days
 * after the original send, one more at 7 days, then no more customer email —
 * the owner is alerted once instead. Days count from linkSentAt, which only a
 * manual resend moves, so renewing the link's validity with each reminder
 * never shifts the schedule.
 */
export const BALANCE_REMINDER_DAYS = [3, 7] as const;

/** Customer reminders per invoice, total. After these, the owner takes over. */
export const MAX_BALANCE_REMINDERS = BALANCE_REMINDER_DAYS.length;

export type BalanceReminderAction =
  | { action: "remind"; reminderNumber: 1 | 2 }
  | { action: "owner_alert" }
  | null;

/**
 * What the daily sweep should do for one invoice right now, judged from the
 * row alone. Null the moment the invoice leaves "sent" — payment or a manual
 * mark-paid halts the sequence wherever it stood — and null again once both
 * reminders are out and the owner has been told.
 */
export function balanceReminderAction(
  invoice: {
    status: string;
    kind?: string;
    payToken?: string | null;
    linkSentAt?: Date | string | null;
    reminderCount?: number | null;
    reminderExhaustedAlertAt?: Date | string | null;
  },
  now: Date = new Date()
): BalanceReminderAction {
  // Only a live balance link is chased: manual invoices have no link to point
  // at, and any status but "sent" means the money moved or the invoice died.
  if (invoice.kind !== "balance" || invoice.status !== "sent" || !invoice.payToken) return null;
  if (!invoice.linkSentAt) return null;
  const sentAt = new Date(invoice.linkSentAt).getTime();
  if (!Number.isFinite(sentAt)) return null;

  const count = invoice.reminderCount ?? 0;
  if (count >= MAX_BALANCE_REMINDERS) {
    // Both reminders ran their course unpaid. One owner alert, then silence.
    return invoice.reminderExhaustedAlertAt ? null : { action: "owner_alert" };
  }
  const dueAt = sentAt + BALANCE_REMINDER_DAYS[count]! * 24 * 60 * 60 * 1000;
  if (now.getTime() < dueAt) return null;
  return { action: "remind", reminderNumber: (count + 1) as 1 | 2 };
}

/** True while the emailed link may still mint a Checkout Session. */
export function isBalanceLinkPayable(
  invoice: { status: string; payToken?: string | null; linkExpiresAt?: Date | string | null },
  now: Date = new Date()
): boolean {
  return balanceLinkStatus(invoice, now) === "sent";
}
