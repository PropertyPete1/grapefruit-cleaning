/**
 * Recurring plans are for returning customers.
 *
 * A first-time customer sees one-time pricing only: no bi-weekly or monthly
 * option and no discount anywhere on the public site. The plans — and their
 * savings — unlock after the first cleaning, which is what the small note
 * under the price says. "Returning" has exactly one definition, shared by the
 * public booking form, by booking.create's server-side check (the UI hides the
 * options; this is what stops a crafted request), and by the review email that
 * tells a customer the plans are now theirs:
 *
 *   a customer is returning when their normalized email OR phone matches a
 *   customer row with at least one booking that is COMPLETED and PAID.
 *
 * "Paid" reads the same facts the admin's payment badge reads (see
 * shared/paymentStatus.ts): a paid invoice settles it; an open invoice means
 * not yet; and with no invoice at all, a captured deposit that covered the
 * whole job. A completed job nobody ever billed is not paid — and a cancelled
 * one, whatever was refunded, never counts.
 *
 * The owner is never gated: Admin → New booking can put anyone on a recurring
 * plan, and the deposit link then shows that plan as settled.
 */
import { contactMatchesCustomer } from "./priceLock";

/** The note first-time customers see wherever a recurring plan would have been offered. */
export const RECURRING_UNLOCK_NOTE = {
  en: "Recurring plans with savings unlock after your first cleaning.",
  es: "Los planes recurrentes con ahorros se desbloquean después de su primera limpieza.",
} as const;

/** The one refusal a crafted recurring request from a first-time customer sees. */
export const RECURRING_LOCKED_MESSAGE = {
  en: "Recurring plans with savings unlock after your first cleaning — please choose one-time pricing for this booking.",
  es: "Los planes recurrentes con ahorros se desbloquean después de su primera limpieza. Por favor elija el precio de una sola vez para esta reserva.",
} as const;

export function isRecurringFrequency(frequency: string | null | undefined): boolean {
  return Boolean(frequency) && frequency !== "onetime";
}

/** Whether a public booking may carry this frequency, given who is booking. */
export function frequencyAllowedFor(frequency: string | null | undefined, returning: boolean): boolean {
  return !isRecurringFrequency(frequency) || returning;
}

/** The booking facts the paid test reads — a subset of the row, so list queries can feed it. */
export interface PaidStateBooking {
  status: string;
  totalAmount: number;
  totalAmountCents?: number | null;
  depositAmount: number;
  depositAmountCents?: number | null;
  stripePaymentIntentId?: string | null;
}

export interface InvoiceState {
  status: string;
}

/** Whether one booking counts toward "returning": completed, and paid for. */
export function bookingCompletedAndPaid(booking: PaidStateBooking, invoices: readonly InvoiceState[]): boolean {
  if (booking.status !== "completed") return false;
  const live = invoices.filter(invoice => invoice.status !== "void");
  if (live.some(invoice => invoice.status === "paid")) return true;
  // An open invoice — sent, overdue, awaiting approval, even a draft — is
  // money still owed. Not paid, whatever the deposit covered.
  if (live.length > 0) return false;
  // No invoice at all: the deposit must have covered the job, and a deposit
  // counts only once Stripe captured it (the payment intent is the receipt).
  const totalCents = booking.totalAmountCents ?? Math.round(booking.totalAmount * 100);
  const depositCents = booking.stripePaymentIntentId
    ? (booking.depositAmountCents ?? Math.round(booking.depositAmount * 100))
    : 0;
  return totalCents > 0 && depositCents >= totalCents;
}

/** The customer rows these contact details identify — normalized email OR phone; blank details identify nobody. */
export function matchingCustomerIds<T extends { id: number; email: string | null; phone: string | null }>(
  customers: readonly T[],
  contact: { email?: string | null; phone?: string | null }
): number[] {
  return customers.filter(customer => contactMatchesCustomer(customer, contact)).map(customer => customer.id);
}

/**
 * The whole rule over rows already loaded: the customers a contact matched,
 * their completed bookings, and those bookings' invoices. Pure, so the tests
 * can walk every branch without a database and the server stays a thin
 * loader around it.
 */
export function isReturningFrom(args: {
  contact: { email?: string | null; phone?: string | null };
  customers: readonly { id: number; email: string | null; phone: string | null }[];
  bookings: readonly (PaidStateBooking & { id: number; customerId: number })[];
  invoices: readonly (InvoiceState & { bookingId: number | null })[];
}): boolean {
  const ids = new Set(matchingCustomerIds(args.customers, args.contact));
  if (ids.size === 0) return false;
  const invoicesByBooking = new Map<number, InvoiceState[]>();
  for (const invoice of args.invoices) {
    if (invoice.bookingId == null) continue;
    const list = invoicesByBooking.get(invoice.bookingId) ?? [];
    list.push(invoice);
    invoicesByBooking.set(invoice.bookingId, list);
  }
  return args.bookings.some(
    booking => ids.has(booking.customerId) && bookingCompletedAndPaid(booking, invoicesByBooking.get(booking.id) ?? [])
  );
}
