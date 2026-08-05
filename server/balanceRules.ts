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

export type BalanceLinkStatus = "none" | "sent" | "paid" | "expired";

/**
 * Payment-link state shown in Admin → Invoices.
 * - "none": no link was ever generated (manual invoices, zero-balance invoices).
 * - "paid": settled, by card or in person — a paid invoice is never "expired".
 * - "expired": the 7-day window closed with the balance still outstanding.
 * - "sent": link is live and payable.
 */
export function balanceLinkStatus(
  invoice: { status: string; payToken?: string | null; linkExpiresAt?: Date | string | null },
  now: Date = new Date()
): BalanceLinkStatus {
  // Checked before status so a zero-balance invoice — auto-marked paid without
  // ever issuing a link — doesn't claim a link was paid.
  if (!invoice.payToken) return "none";
  if (invoice.status === "paid") return "paid";
  if (!invoice.linkExpiresAt) return "sent";
  const expires = new Date(invoice.linkExpiresAt).getTime();
  if (!Number.isFinite(expires)) return "sent";
  return expires <= now.getTime() ? "expired" : "sent";
}

/** True while the emailed link may still mint a Checkout Session. */
export function isBalanceLinkPayable(
  invoice: { status: string; payToken?: string | null; linkExpiresAt?: Date | string | null },
  now: Date = new Date()
): boolean {
  return balanceLinkStatus(invoice, now) === "sent";
}
