/**
 * Automated remaining-balance collection.
 *
 * When a booking is marked completed (by an admin or by staff), the remaining
 * balance is computed server-side from the amounts stored on the booking, an
 * invoice is issued, and the customer is emailed a payment link in their own
 * language. Payment settles through the same Stripe integration and webhook as
 * the deposit — balance sessions are tagged with metadata.payment_type so the
 * webhook can tell the two apart.
 *
 * The emailed link points at /api/pay/balance/:token rather than straight at
 * Stripe: a Stripe Checkout Session may live at most 24 hours, so the route
 * mints a fresh session per visit for the whole BALANCE_LINK_DAYS window.
 */
import { randomBytes } from "node:crypto";
import type { Stripe } from "stripe";
import type { Booking, Customer, Invoice } from "../drizzle/schema";
import { balanceLinkExpiresAt, computeBalanceDue, stripeSessionExpiresAt } from "./balanceRules";
import * as db from "./db";
import {
  sendBalanceApprovalNeededAlert,
  sendBalanceDueEmail,
  sendBalancePaidNotification,
  sendRefundNeededAlert,
  type BalanceEmailData,
} from "./emails";
import { SERVICE_NAMES } from "./routers/booking";
import { getStripe } from "./stripe";

/** Metadata tag that marks a Checkout Session as a balance payment. */
export const BALANCE_PAYMENT_TYPE = "balance";

/**
 * Invoice numbers follow the existing INV-<base36 timestamp> shape, with a
 * random suffix so completing several bookings in the same millisecond can't
 * collide on the unique `number` column.
 */
export function generateInvoiceNumber(): string {
  return `INV-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

/** Customer-facing payment link for an invoice token. */
export function balancePayUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/api/pay/balance/${token}`;
}

/**
 * Origin to build customer-facing links from, taken off the admin/staff request
 * that marked the booking completed (same approach as the deposit checkout).
 * Falls back to PUBLIC_BASE_URL for internal callers without a real request.
 */
export function originFromRequest(req: { protocol?: string; headers?: Record<string, unknown> } | undefined): string {
  const origin = req?.headers?.origin;
  if (typeof origin === "string" && origin.length > 0) return origin;
  const host = req?.headers?.host;
  if (typeof host === "string" && host.length > 0) return `${req?.protocol ?? "https"}://${host}`;
  return process.env.PUBLIC_BASE_URL ?? "";
}

/**
 * Deposit only counts against the balance when it was actually captured. An
 * admin can move a booking straight from pending_deposit to completed (a job
 * booked by phone, say), in which case nothing has been collected yet and the
 * full total is due.
 */
export function balanceDueForBooking(booking: Pick<Booking, "totalAmount" | "depositAmount" | "stripePaymentIntentId">): number {
  const depositPaid = booking.stripePaymentIntentId ? booking.depositAmount : 0;
  return computeBalanceDue({ totalAmount: booking.totalAmount, depositAmount: depositPaid });
}

function toBalanceEmailData(
  booking: Booking,
  customer: Customer,
  invoice: Pick<Invoice, "number" | "amount">,
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = booking.locale as "en" | "es";
  return {
    reference: booking.reference,
    invoiceNumber: invoice.number,
    serviceName: SERVICE_NAMES[booking.serviceType][locale],
    date: booking.scheduledDate,
    total: booking.totalAmount,
    deposit: booking.stripePaymentIntentId ? booking.depositAmount : 0,
    balance: invoice.amount,
    customerName: customer.firstName,
    customerEmail: customer.email,
    customerPhone: customer.phone ?? undefined,
    address: [booking.addressLine, booking.city, booking.zip].filter(Boolean).join(", "),
    payUrl,
    expiresOn: expiresOn.toISOString().slice(0, 10),
    locale,
    bizPhone,
  };
}

/** Creates a Checkout Session for an outstanding balance invoice. */
export async function createBalanceCheckoutSession(args: {
  invoice: Pick<Invoice, "id" | "number" | "amount" | "payToken">;
  booking: Pick<Booking, "id" | "reference" | "serviceType" | "locale" | "scheduledDate">;
  customerEmail: string;
  origin: string;
  now?: Date;
}): Promise<Stripe.Checkout.Session> {
  const { invoice, booking, customerEmail, origin } = args;
  const now = args.now ?? new Date();
  const locale = booking.locale as "en" | "es";
  const serviceName = SERVICE_NAMES[booking.serviceType][locale];
  const payUrl = balancePayUrl(origin, invoice.payToken ?? "");

  return getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail,
    client_reference_id: String(invoice.id),
    allow_promotion_codes: false,
    // A single Stripe session tops out at 24 hours; the emailed link keeps
    // working for the full 7-day window by minting a new one on each visit.
    expires_at: stripeSessionExpiresAt(now),
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: invoice.amount * 100,
          product_data: {
            name: locale === "es" ? `Saldo restante — ${serviceName}` : `Remaining balance — ${serviceName}`,
            description:
              locale === "es"
                ? `Reserva ${booking.reference} · Servicio del ${booking.scheduledDate} · Factura ${invoice.number}`
                : `Booking ${booking.reference} · Service on ${booking.scheduledDate} · Invoice ${invoice.number}`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      payment_type: BALANCE_PAYMENT_TYPE,
      invoice_id: String(invoice.id),
      invoice_number: invoice.number,
      booking_id: String(booking.id),
      booking_reference: booking.reference,
      customer_email: customerEmail,
      locale,
    },
    success_url: `${payUrl}?paid=1`,
    cancel_url: payUrl,
  });
}

export type CompletionOutcome =
  | { outcome: "booking_not_found" }
  | { outcome: "not_completed" }
  | { outcome: "already_issued"; invoiceId: number }
  | { outcome: "zero_balance"; invoiceId: number }
  | { outcome: "awaiting_approval"; invoiceId: number; amount: number };

/**
 * Computes the remaining balance for a completed booking and files it for
 * approval. Nothing reaches the customer here: no Stripe session and no email
 * until an admin reviews the amount, because the crew regularly finds on site
 * that the home is bigger (or the job smaller) than what was booked.
 *
 * Idempotent: a booking that already has a balance invoice is left alone, so
 * re-marking it completed never bills twice.
 *
 * A zero balance (100% coupon, or a deposit that covered the total) still
 * auto-settles — there is nothing to review or collect.
 */
export async function issueBalanceForCompletedBooking(bookingId: number, origin: string): Promise<CompletionOutcome> {
  const booking = await db.getBookingById(bookingId);
  if (!booking) return { outcome: "booking_not_found" };
  if (booking.status !== "completed") return { outcome: "not_completed" };

  const existing = await db.getBalanceInvoiceForBooking(bookingId);
  if (existing) return { outcome: "already_issued", invoiceId: existing.id };

  const amount = balanceDueForBooking(booking);
  const now = new Date();

  if (amount <= 0) {
    // Nothing left to collect — record a settled invoice so the job still shows
    // up as paid in Admin → Invoices, and send no payment link.
    const invoiceId = await db.createInvoice({
      number: generateInvoiceNumber(),
      bookingId,
      customerId: booking.customerId,
      amount: 0,
      computedAmount: 0,
      kind: "balance",
      status: "paid",
      paidAt: now,
    });
    return { outcome: "zero_balance", invoiceId };
  }

  const invoiceId = await db.createInvoice({
    number: generateInvoiceNumber(),
    bookingId,
    customerId: booking.customerId,
    amount,
    computedAmount: amount,
    kind: "balance",
    status: "awaiting_approval",
  });

  // Tell the owner there is money waiting on them, so it can't sit forgotten.
  await notifyApprovalNeeded(invoiceId, booking, amount);

  return { outcome: "awaiting_approval", invoiceId, amount };
}

/** Owner alert that a completed job is waiting for balance approval. */
async function notifyApprovalNeeded(invoiceId: number, booking: Booking, amount: number): Promise<void> {
  try {
    const customer = await db.getCustomerById(booking.customerId);
    const invoice = await db.getInvoiceById(invoiceId);
    if (!customer || !invoice) return;
    await sendBalanceApprovalNeededAlert(
      toBalanceEmailData(booking, customer, { number: invoice.number, amount }, "", new Date())
    );
  } catch (error) {
    console.error(`[Balance] Failed to send approval alert for invoice ${invoiceId}:`, error);
  }
}

/**
 * Best-effort wrapper used by the admin/staff "mark completed" mutations:
 * balance collection must never make the status update itself fail.
 */
export async function issueBalanceSafely(bookingId: number, origin: string): Promise<void> {
  try {
    const result = await issueBalanceForCompletedBooking(bookingId, origin);
    console.log(`[Balance] Booking ${bookingId} completed → ${result.outcome}`);
  } catch (error) {
    console.error(`[Balance] Failed to issue balance for booking ${bookingId}:`, error);
  }
}

export type ApprovalOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_a_balance_invoice" }
  | { outcome: "not_awaiting_approval"; status: string }
  | { outcome: "booking_not_found" }
  | { outcome: "customer_not_found" }
  | { outcome: "settled_without_link"; invoiceId: number }
  | { outcome: "approved"; invoiceId: number; amount: number; emailed: boolean; expiresOn: string };

/**
 * Approves a pending balance — the point where the customer is finally billed.
 * Mints the Stripe session and sends the payment email exactly as the
 * pre-approval flow did.
 *
 * `adjustedAmount` lets an admin correct the total (bigger home than booked,
 * say). It is applied server-side and drives the Stripe amount; the originally
 * computed figure is kept on the invoice for the audit trail.
 */
export async function approveBalanceInvoice(args: {
  invoiceId: number;
  approvedByUserId: number;
  origin: string;
  adjustedAmount?: number;
}): Promise<ApprovalOutcome> {
  const { invoiceId, approvedByUserId, origin } = args;
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  if (invoice.kind !== "balance") return { outcome: "not_a_balance_invoice" };
  // Idempotent: only a pending invoice can be approved. An invoice already sent
  // or settled (including collected in person) is never re-billed here.
  if (invoice.status !== "awaiting_approval") return { outcome: "not_awaiting_approval", status: invoice.status };
  if (!invoice.bookingId) return { outcome: "booking_not_found" };

  const booking = await db.getBookingById(invoice.bookingId);
  if (!booking) return { outcome: "booking_not_found" };
  const customer = await db.getCustomerById(invoice.customerId);
  if (!customer) return { outcome: "customer_not_found" };

  const amount = args.adjustedAmount ?? invoice.amount;
  const now = new Date();

  // An admin can zero out the balance (goodwill, or the deposit turned out to
  // cover it). Settle it outright rather than emailing a $0 payment link.
  if (amount <= 0) {
    await db.updateInvoice(invoiceId, {
      amount: 0,
      status: "paid",
      paidAt: now,
      approvedAt: now,
      approvedByUserId,
    });
    return { outcome: "settled_without_link", invoiceId };
  }

  const expiresAt = balanceLinkExpiresAt(now);
  const payToken = invoice.payToken ?? randomBytes(24).toString("hex");
  const session = await createBalanceCheckoutSession({
    invoice: { id: invoiceId, number: invoice.number, amount, payToken },
    booking,
    customerEmail: customer.email,
    origin,
    now,
  });

  await db.updateInvoice(invoiceId, {
    amount,
    status: "sent",
    approvedAt: now,
    approvedByUserId,
    dueDate: expiresAt.toISOString().slice(0, 10),
    payToken,
    stripeSessionId: session.id,
    linkSentAt: now,
    linkExpiresAt: expiresAt,
  });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const emailed = await sendBalanceDueEmail(
    toBalanceEmailData(
      booking,
      customer,
      { number: invoice.number, amount },
      balancePayUrl(origin, payToken),
      expiresAt,
      bizPhone
    )
  );

  return { outcome: "approved", invoiceId, amount, emailed, expiresOn: expiresAt.toISOString().slice(0, 10) };
}

export type ResendOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_a_balance_invoice" }
  | { outcome: "awaiting_approval" }
  | { outcome: "already_paid" }
  | { outcome: "voided" }
  | { outcome: "booking_not_found" }
  | { outcome: "customer_not_found" }
  | { outcome: "resent"; payUrl: string; emailed: boolean; expiresOn: string };

/**
 * Re-sends a balance payment link, reopening the 7-day window from now. Works
 * for links that have expired as well as ones still outstanding; a paid or
 * voided invoice is refused.
 */
export async function resendBalanceLink(invoiceId: number, origin: string): Promise<ResendOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  if (invoice.kind !== "balance") return { outcome: "not_a_balance_invoice" };
  // Nothing to resend before an admin has approved the amount.
  if (invoice.status === "awaiting_approval") return { outcome: "awaiting_approval" };
  if (invoice.status === "paid") return { outcome: "already_paid" };
  if (invoice.status === "void") return { outcome: "voided" };
  if (!invoice.bookingId) return { outcome: "booking_not_found" };

  const booking = await db.getBookingById(invoice.bookingId);
  if (!booking) return { outcome: "booking_not_found" };
  const customer = await db.getCustomerById(invoice.customerId);
  if (!customer) return { outcome: "customer_not_found" };

  const now = new Date();
  const expiresAt = balanceLinkExpiresAt(now);
  const payToken = invoice.payToken ?? randomBytes(24).toString("hex");

  const session = await createBalanceCheckoutSession({
    invoice: { id: invoice.id, number: invoice.number, amount: invoice.amount, payToken },
    booking,
    customerEmail: customer.email,
    origin,
    now,
  });

  await db.updateInvoice(invoice.id, {
    status: "sent",
    payToken,
    stripeSessionId: session.id,
    linkSentAt: now,
    linkExpiresAt: expiresAt,
    dueDate: expiresAt.toISOString().slice(0, 10),
  });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const payUrl = balancePayUrl(origin, payToken);
  const emailed = await sendBalanceDueEmail(
    toBalanceEmailData(
      booking,
      customer,
      { number: invoice.number, amount: invoice.amount },
      payUrl,
      expiresAt,
      bizPhone
    )
  );

  return { outcome: "resent", payUrl, emailed, expiresOn: expiresAt.toISOString().slice(0, 10) };
}

export type BalancePaymentOutcome =
  | { outcome: "not_found" }
  | { outcome: "duplicate" }
  | { outcome: "refund_needed" }
  | { outcome: "paid" };

/**
 * Settles a balance invoice from a paid checkout.session.completed event.
 *
 * Idempotent in the same spirit as finalizeBooking: a redelivered event for a
 * payment already recorded is a no-op. A payment that arrives for an invoice
 * settled some other way — collected in person, or an accidental second card
 * payment — never double-marks it paid; the earlier settlement stands and the
 * invoice is flagged refundNeeded with an owner alert.
 */
export async function applyBalancePayment(
  invoiceId: number,
  paymentIntentId: string | null
): Promise<BalancePaymentOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };

  const alreadySettled = invoice.status === "paid" || invoice.status === "void";
  if (alreadySettled) {
    const samePayment = paymentIntentId != null && invoice.stripePaymentIntentId === paymentIntentId;
    const untrackedStripePayment = paymentIntentId == null && invoice.paidVia === "stripe";
    if (samePayment || untrackedStripePayment || invoice.refundNeeded) return { outcome: "duplicate" };

    await db.updateInvoice(invoiceId, {
      refundNeeded: true,
      stripePaymentIntentId: paymentIntentId ?? undefined,
    });
    // The money did arrive — record it so the books balance against the refund.
    await db.createPayment({
      bookingId: invoice.bookingId,
      invoiceId,
      customerId: invoice.customerId,
      amount: invoice.amount,
      kind: "balance",
      method: "card",
      stripePaymentIntentId: paymentIntentId ?? undefined,
      status: "succeeded",
    });
    await notifyOwnerOfBalance(invoice, sendRefundNeededAlert);
    return { outcome: "refund_needed" };
  }

  await db.updateInvoice(invoiceId, {
    status: "paid",
    paidAt: new Date(),
    paidVia: "stripe",
    stripePaymentIntentId: paymentIntentId ?? undefined,
  });
  await db.createPayment({
    bookingId: invoice.bookingId,
    invoiceId,
    customerId: invoice.customerId,
    amount: invoice.amount,
    kind: "balance",
    method: "card",
    stripePaymentIntentId: paymentIntentId ?? undefined,
    status: "succeeded",
  });
  await notifyOwnerOfBalance(invoice, sendBalancePaidNotification);
  return { outcome: "paid" };
}

/**
 * Builds the owner notification for an invoice and hands it to `send`.
 * Notification failures never fail the webhook — the payment is already
 * recorded by the time this runs.
 */
async function notifyOwnerOfBalance(
  invoice: Invoice,
  send: (data: BalanceEmailData) => Promise<void>
): Promise<void> {
  try {
    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!booking || !customer) return;
    await send(
      toBalanceEmailData(
        booking,
        customer,
        { number: invoice.number, amount: invoice.amount },
        balancePayUrl("", invoice.payToken ?? ""),
        invoice.linkExpiresAt ? new Date(invoice.linkExpiresAt) : new Date()
      )
    );
  } catch (error) {
    console.error(`[Balance] Failed to notify owner for invoice ${invoice.id}:`, error);
  }
}
