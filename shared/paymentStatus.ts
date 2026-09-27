/**
 * The payment position of a booking, in one word the owner can scan.
 *
 * Derived, never stored: it is read off the booking row and its balance
 * invoice at request time, so it can never drift from the money it describes.
 * The admin calendar's day panel and the booking details panel both show it.
 *
 * Deliberately coarse. The point is "does this customer still owe us
 * something, and has anything been collected" — not a ledger. The invoice
 * pages keep the ledger.
 */

export type BookingPaymentStatus =
  /** Unpaid checkout: the customer has not paid the deposit yet. */
  | "deposit_due"
  /** A deposit was captured; the rest is billed after the cleaning. */
  | "deposit_paid"
  /** Nothing was collected up front, by design: billed in full after the cleaning. */
  | "pay_after_service"
  /** The job is done and its balance is waiting for the owner's approval. */
  | "balance_pending_approval"
  /** The balance invoice is out (link sent) and not yet paid. */
  | "balance_due"
  /** The job is done and no balance invoice exists yet. */
  | "unpaid"
  /** Settled online through Stripe. */
  | "paid"
  /** Settled with money taken outside Stripe and recorded by the owner. */
  | "paid_offline"
  /** Cancelled or expired — no money is expected. */
  | "released";

export interface PaymentStatusInput {
  status: string;
  depositAmount: number;
  depositAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
  /** The booking's balance invoice, when one exists. */
  invoice?: { status: string; paidVia?: string | null } | null;
}

export function derivePaymentStatus(booking: PaymentStatusInput): BookingPaymentStatus {
  if (booking.status === "cancelled" || booking.status === "expired") return "released";

  const invoice = booking.invoice ?? null;
  if (invoice && invoice.status !== "void") {
    if (invoice.status === "paid") return invoice.paidVia === "manual" ? "paid_offline" : "paid";
    if (invoice.status === "awaiting_approval") return "balance_pending_approval";
    return "balance_due";
  }

  if (booking.status === "completed") return "unpaid";

  const depositCents = booking.depositAmountCents ?? Math.round(booking.depositAmount * 100);
  if (booking.status === "pending_deposit") return depositCents > 0 ? "deposit_due" : "pay_after_service";
  // confirmed / in_progress: a captured deposit leaves a payment intent behind.
  if (booking.stripePaymentIntentId && depositCents > 0) return "deposit_paid";
  return "pay_after_service";
}

export const PAYMENT_STATUS_LABELS: Record<BookingPaymentStatus, string> = {
  deposit_due: "Deposit due",
  deposit_paid: "Deposit paid",
  pay_after_service: "Pay after cleaning",
  balance_pending_approval: "Balance to approve",
  balance_due: "Balance due",
  unpaid: "Unpaid",
  paid: "Paid",
  paid_offline: "Paid (recorded)",
  released: "—",
};
