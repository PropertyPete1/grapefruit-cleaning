/**
 * The payment position of a booking, in one word the owner can scan.
 *
 * Derived, never stored: it is read off the booking row and its balance
 * invoice at request time, so it can never drift from the money it describes.
 * The admin calendar's day panel, the booking details panel and the
 * appointments list all show it.
 *
 * Deliberately coarse. The point is "does this customer still owe us
 * something, has anything been collected, and how are they paying" — not a
 * ledger. The invoice pages keep the ledger.
 */

export type BookingPaymentStatus =
  /** Unpaid checkout: the customer has not paid the deposit yet. */
  | "deposit_due"
  /** A deposit was captured; the rest is billed after the cleaning. */
  | "deposit_paid"
  /** Nothing was collected up front, by design: billed in full after the cleaning. */
  | "pay_after_service"
  /** The customer chose cash: nothing collected online, the owner collects and records it. */
  | "cash_pending"
  /** The job is done and its balance is waiting for the owner's approval. */
  | "balance_pending_approval"
  /** The balance invoice is out (link sent) and not yet paid. */
  | "balance_due"
  /** Nothing collected yet and nothing billed yet — an Airbnb job before its cleaning, or a finished job with no invoice. */
  | "unpaid"
  /** Settled online through Stripe. */
  | "paid"
  /** Settled in cash, recorded by the owner. */
  | "paid_cash"
  /** Settled with money taken outside Stripe by another method (Venmo, Zelle, check…). */
  | "paid_offline"
  /** Cancelled or expired — no money is expected. */
  | "released";

export interface PaymentStatusInput {
  status: string;
  depositAmount: number;
  depositAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
  /** "airbnb" bookings never take a deposit and read Unpaid until settled. */
  serviceType?: string | null;
  kind?: string | null;
  /** The customer's stated way of paying, when they stated one. */
  paymentPreference?: string | null;
  /** The booking's balance invoice, when one exists. */
  invoice?: {
    status: string;
    paidVia?: string | null;
    paidMethod?: string | null;
    paymentPreference?: string | null;
  } | null;
}

function isAirbnb(booking: PaymentStatusInput): boolean {
  return booking.serviceType === "airbnb" || booking.kind === "ical_auto";
}

export function derivePaymentStatus(booking: PaymentStatusInput): BookingPaymentStatus {
  if (booking.status === "cancelled" || booking.status === "expired") return "released";

  const invoice = booking.invoice ?? null;
  const cash = booking.paymentPreference === "cash" || invoice?.paymentPreference === "cash";
  if (invoice && invoice.status !== "void") {
    if (invoice.status === "paid") {
      if (invoice.paidVia === "manual") return invoice.paidMethod === "cash" ? "paid_cash" : "paid_offline";
      return "paid";
    }
    if (invoice.status === "awaiting_approval") return cash ? "cash_pending" : "balance_pending_approval";
    return cash ? "cash_pending" : "balance_due";
  }

  if (cash) return "cash_pending";
  if (booking.status === "completed") return "unpaid";

  const depositCents = booking.depositAmountCents ?? Math.round(booking.depositAmount * 100);
  if (booking.status === "pending_deposit") return depositCents > 0 ? "deposit_due" : "pay_after_service";
  // confirmed / in_progress: a captured deposit leaves a payment intent behind.
  if (booking.stripePaymentIntentId && depositCents > 0) return "deposit_paid";
  // An Airbnb job is one payment after the cleaning: until then it is simply unpaid.
  if (isAirbnb(booking)) return "unpaid";
  return "pay_after_service";
}

export const PAYMENT_STATUS_LABELS: Record<BookingPaymentStatus, string> = {
  deposit_due: "Deposit due",
  deposit_paid: "Deposit paid",
  pay_after_service: "Pay after cleaning",
  cash_pending: "Cash pending",
  balance_pending_approval: "Balance to approve",
  balance_due: "Balance due",
  unpaid: "Unpaid",
  paid: "Paid",
  paid_cash: "Paid in Cash",
  paid_offline: "Paid (recorded)",
  released: "—",
};

/** Statuses under which a completed job can still be settled by the owner in cash. */
export const CASH_SETTLEABLE_STATUSES: readonly BookingPaymentStatus[] = [
  "unpaid",
  "cash_pending",
  "balance_pending_approval",
  "balance_due",
  "pay_after_service",
];

export function canMarkPaidInCash(booking: { status: string; paymentStatus?: BookingPaymentStatus | null }): boolean {
  return booking.status === "completed" && booking.paymentStatus != null && CASH_SETTLEABLE_STATUSES.includes(booking.paymentStatus);
}

/**
 * The invoice-side position, for Admin → Invoices: the same words the booking
 * badge uses, read off an invoice row alone (a manual invoice has no booking).
 */
export type InvoicePaymentStatus = "paid" | "paid_cash" | "paid_offline" | "cash_pending" | "balance_pending_approval" | "balance_due" | "void" | "draft";

export function deriveInvoicePaymentStatus(invoice: {
  status: string;
  paidVia?: string | null;
  paidMethod?: string | null;
  paymentPreference?: string | null;
}): InvoicePaymentStatus {
  if (invoice.status === "paid") {
    if (invoice.paidVia === "manual") return invoice.paidMethod === "cash" ? "paid_cash" : "paid_offline";
    return "paid";
  }
  if (invoice.status === "void") return "void";
  if (invoice.paymentPreference === "cash") return "cash_pending";
  if (invoice.status === "awaiting_approval") return "balance_pending_approval";
  if (invoice.status === "draft") return "draft";
  return "balance_due";
}

export const INVOICE_PAYMENT_STATUS_LABELS: Record<InvoicePaymentStatus, string> = {
  paid: "Paid online",
  paid_cash: "Paid in Cash",
  paid_offline: "Paid (recorded)",
  cash_pending: "Cash pending",
  balance_pending_approval: "Awaiting approval",
  balance_due: "Unpaid",
  void: "Void",
  draft: "Draft",
};
