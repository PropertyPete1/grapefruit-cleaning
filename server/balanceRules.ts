/**
 * Pure remaining-balance rules shared by the completion flow, the payment-link
 * route, and the admin invoice list. Kept free of DB and Stripe imports so they
 * are unit-testable (same shape as bookingRules.ts).
 */

/**
 * Metadata tag that marks a Checkout Session (and, since 0036, its
 * PaymentIntent) as an invoice payment — balance or manual alike.
 */
export const BALANCE_PAYMENT_TYPE = "balance";

/** Days an emailed balance payment link stays valid. */
export const BALANCE_LINK_DAYS = 7;

/**
 * Maximum lifetime Stripe allows for a single Checkout Session (30 minutes to
 * 24 hours from creation). The customer-facing link outlives this: it points at
 * /api/pay/balance/:token, which reopens the invoice's one live session and
 * mints a replacement only after that session has expired or its payment
 * failed, for as long as the invoice's own BALANCE_LINK_DAYS window is open.
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

/** True when a deposit was actually captured on this booking: a Stripe intent exists and the deposit was not 0. */
export function depositCaptured(booking: {
  depositAmount: number;
  depositAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
}): boolean {
  const depositCents = booking.depositAmountCents ?? Math.round(Number(booking.depositAmount) * 100);
  return Boolean(booking.stripePaymentIntentId) && depositCents > 0;
}

/**
 * How a settlement is booked in the payments ledger: "balance" when it
 * completes a captured deposit, "full" when it is the whole job — an Airbnb
 * turnover (never a deposit), a cash booking, or a manual invoice with no
 * booking at all. One rule for the card path and the cash path, so
 * Admin → Payments tells the two apart the same way whoever collected.
 */
export function settlementKind(
  booking: { depositAmount: number; depositAmountCents?: number | null; stripePaymentIntentId?: string | null } | null | undefined
): "balance" | "full" {
  return booking && depositCaptured(booking) ? "balance" : "full";
}

/** End of the payment link's validity window, BALANCE_LINK_DAYS after `now`. */
export function balanceLinkExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + BALANCE_LINK_DAYS * 24 * 60 * 60 * 1000);
}

/** Expiry to hand Stripe for a single Checkout Session, in epoch seconds. */
export function stripeSessionExpiresAt(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + STRIPE_SESSION_MAX_SECONDS;
}

export type BalanceLinkStatus = "none" | "awaiting_approval" | "sent" | "processing" | "paid" | "expired" | "void";

/**
 * Payment-link state shown in Admin → Invoices.
 * - "awaiting_approval": balance computed, waiting on an admin — nothing sent.
 * - "none": no link was ever generated (zero-balance invoices, or an invoice
 *   created before manual invoices became billable).
 * - "paid": settled, by card or in person — a paid invoice is never "expired".
 * - "void": the invoice was voided; its link is dead whatever its window says.
 * - "processing": the customer paid by bank (ACH) and the money is in flight.
 *   The link refuses a second checkout and reminders are paused.
 * - "expired": the 7-day window closed with the balance still outstanding.
 * - "sent": link is live and payable.
 */
export function balanceLinkStatus(
  invoice: {
    status: string;
    payToken?: string | null;
    linkExpiresAt?: Date | string | null;
    paymentProcessingAt?: Date | string | null;
  },
  now: Date = new Date()
): BalanceLinkStatus {
  // Checked first: an invoice pending review has no link yet, but "awaiting
  // approval" is what the owner needs to see, not "none".
  if (invoice.status === "awaiting_approval") return "awaiting_approval";
  // Checked before status so a zero-balance invoice — auto-marked paid without
  // ever issuing a link — doesn't claim a link was paid.
  if (!invoice.payToken) return "none";
  if (invoice.status === "paid") return "paid";
  // Voiding keeps the token and the window, so it must be read off the
  // status — otherwise a voided invoice's link would still open checkout.
  if (invoice.status === "void") return "void";
  // Before the window: a bank payment in flight outlives the 7 days, and
  // "expired, press Resend" is exactly the wrong thing to show for it.
  if (invoice.paymentProcessingAt) return "processing";
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
    paymentProcessingAt?: Date | string | null;
  },
  now: Date = new Date()
): BalanceReminderAction {
  // The gate is the LINK, not the kind. Manual invoices are billable now and a
  // dollar owed is a dollar owed, so both kinds are chased on the same
  // schedule; what disqualifies a row is having nothing to point the customer
  // at (no token) or having left "sent" (the money moved, or the invoice died).
  if (invoice.status !== "sent" || !invoice.payToken) return null;
  // A customer whose bank payment is processing has paid; chasing them with
  // the pay link is how a second debit happens.
  if (invoice.paymentProcessingAt) return null;
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

/** True while the emailed link may still open checkout. */
export function isBalanceLinkPayable(
  invoice: {
    status: string;
    payToken?: string | null;
    linkExpiresAt?: Date | string | null;
    paymentProcessingAt?: Date | string | null;
  },
  now: Date = new Date()
): boolean {
  return balanceLinkStatus(invoice, now) === "sent";
}
