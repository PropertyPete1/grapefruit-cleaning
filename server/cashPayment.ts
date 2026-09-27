/**
 * Paid in Cash — the owner's one tap after a cleaning that was paid in person.
 *
 * Deliberately NOT a second payment system. The money is recorded through the
 * same atomic offline settlement Admin → Invoices uses (db.recordOfflineInvoicePayment):
 * invoice claimed, payment row written with method "cash", tip row when there
 * is one, booking completion — together or not at all. What this module adds
 * is the path from a BOOKING to that settlement: find the job's balance
 * invoice, issue it first if the completion never filed one (quietly — the
 * owner is the one tapping, so no "approve this balance" alert), and settle it
 * at its exact outstanding amount. Nothing is typed, so nothing can be typed
 * wrong.
 *
 * Also home to the post-settlement side effects both entry points share:
 * closing the open Stripe session, the receipt, and the tip ask.
 */
import { todayInBookingZone } from "@shared/leadTime";
import { centsToDollars, dollarsToCents } from "@shared/money";
import type { OfflinePaymentMethod } from "@shared/payments";
import type { Invoice } from "../drizzle/schema";
import { issueBalanceForCompletedBooking, sendPaymentReceiptSafely } from "./balance";
import { settlementKind } from "./balanceRules";
import * as db from "./db";
import { getStripe } from "./stripe";
import { sendTipRequestEmailSafely } from "./tip";

/**
 * Everything that follows a recorded offline payment, shared by the invoice
 * page's Record payment and the booking's Paid in Cash. Each step is
 * best-effort: the money is already recorded by the time this runs, so a mail
 * or Stripe hiccup must never fail the settlement that produced it.
 */
export async function finishOfflineSettlement(args: {
  invoice: Invoice;
  paidAt: Date;
  method: OfflinePaymentMethod;
  tipAmount: number;
  emailReceipt: boolean;
  origin: string;
}): Promise<{ receiptSent: boolean }> {
  const { invoice } = args;
  // Invoice status already blocks the public route; closing the session is a
  // courtesy so a stale tab cannot start a card payment for money already in
  // hand. A genuinely late Stripe settlement is still caught by the
  // refund-needed guard.
  if (invoice.stripeSessionId) {
    try {
      await getStripe().checkout.sessions.expire(invoice.stripeSessionId);
    } catch (error) {
      console.warn(`[OfflinePayment] Could not expire session for invoice ${invoice.id}:`, error);
    }
  }
  let receiptSent = false;
  if (args.emailReceipt) {
    await sendPaymentReceiptSafely({ ...invoice, paidAt: args.paidAt }, args.method, args.tipAmount);
    receiptSent = true;
  }
  // A tip recorded with the payment answers the tip question; otherwise the
  // settled customer gets the thank-you with the optional ask, exactly as a
  // card payment would trigger it.
  if (args.tipAmount === 0 && invoice.kind === "balance" && invoice.bookingId) {
    await sendTipRequestEmailSafely(invoice.bookingId, args.origin);
  }
  return { receiptSent };
}

export type PayInCashOutcome =
  | { outcome: "booking_not_found" }
  | { outcome: "not_completed"; status: string }
  | { outcome: "already_settled"; invoiceId: number; status: string; paidMethod: string | null }
  | { outcome: "nothing_due"; invoiceId: number }
  | { outcome: "tip_already_recorded"; invoiceId: number }
  | {
      outcome: "paid";
      invoiceId: number;
      invoiceNumber: string;
      amount: number;
      amountCents: number;
      tipAmount: number;
      paymentId: number;
      receiptSent: boolean;
    };

/**
 * Settles a completed booking's balance as paid in cash, at its exact
 * outstanding amount.
 *
 * Only a completed job: the button lives on completed bookings, and a cleaning
 * that has not happened has nothing to have been paid for. A job whose
 * completion never filed a balance (the completion side effect failed, or an
 * older row) gets one issued right here, quietly, and settled in the same
 * call — the owner should never have to know an invoice was missing.
 */
export async function payBookingInCash(args: {
  bookingId: number;
  tipAmount?: number;
  receivedOn?: string;
  note?: string;
  emailReceipt?: boolean;
  recordedByUserId: number;
  origin: string;
}): Promise<PayInCashOutcome> {
  const booking = await db.getBookingById(args.bookingId);
  if (!booking) return { outcome: "booking_not_found" };
  if (booking.status !== "completed") return { outcome: "not_completed", status: booking.status };

  let invoice = await db.getBalanceInvoiceForBooking(booking.id);
  if (!invoice) {
    const issued = await issueBalanceForCompletedBooking(booking.id, args.origin, { notifyOwner: false });
    if (issued.outcome === "zero_balance") return { outcome: "nothing_due", invoiceId: issued.invoiceId };
    if (issued.outcome !== "awaiting_approval" && issued.outcome !== "already_issued") {
      return { outcome: "booking_not_found" };
    }
    invoice = await db.getInvoiceById(issued.invoiceId);
    if (!invoice) return { outcome: "booking_not_found" };
  }
  if (invoice.status === "paid" || invoice.status === "void") {
    return { outcome: "already_settled", invoiceId: invoice.id, status: invoice.status, paidMethod: invoice.paidMethod ?? null };
  }

  const amountCents = invoice.amountCents ?? dollarsToCents(invoice.amount);
  if (amountCents <= 0) return { outcome: "nothing_due", invoiceId: invoice.id };
  const tipAmount = args.tipAmount ?? 0;

  const result = await db.recordOfflineInvoicePayment({
    invoiceId: invoice.id,
    amountCents,
    method: "cash",
    tipAmountCents: dollarsToCents(tipAmount),
    note: args.note,
    receivedOn: args.receivedOn ?? todayInBookingZone(),
    recordedByUserId: args.recordedByUserId,
    paymentKind: settlementKind(booking),
  });

  switch (result.outcome) {
    case "not_found":
      return { outcome: "booking_not_found" };
    case "already_settled":
      return { outcome: "already_settled", invoiceId: invoice.id, status: result.status, paidMethod: null };
    case "tip_already_recorded":
      return { outcome: "tip_already_recorded", invoiceId: invoice.id };
    case "amount_mismatch":
      // Unreachable: the amount is the invoice's own. Surface rather than guess.
      throw new Error(`Cash settlement amount mismatch on invoice ${invoice.id}`);
  }

  const { receiptSent } = await finishOfflineSettlement({
    invoice: result.invoice,
    paidAt: result.paidAt,
    method: "cash",
    tipAmount,
    emailReceipt: args.emailReceipt ?? true,
    origin: args.origin,
  });

  return {
    outcome: "paid",
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: centsToDollars(amountCents),
    amountCents,
    tipAmount,
    paymentId: result.paymentId,
    receiptSent,
  };
}
