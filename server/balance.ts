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
import {
  balanceLinkExpiresAt,
  computeBalanceDue,
  isBalanceLinkPayable,
  stripeSessionExpiresAt,
} from "./balanceRules";
import * as db from "./db";
import {
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
  | { outcome: "customer_not_found" }
  | { outcome: "zero_balance"; invoiceId: number }
  | { outcome: "link_sent"; invoiceId: number; amount: number; emailed: boolean };

/**
 * Issues the remaining-balance invoice for a completed booking and emails the
 * customer their payment link. Idempotent: a booking that already has a balance
 * invoice is left alone, so re-marking it completed never bills twice.
 *
 * A zero balance (100% coupon, or a deposit that covered the total) skips the
 * link entirely and records the invoice as already paid.
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
      kind: "balance",
      status: "paid",
      paidAt: now,
    });
    return { outcome: "zero_balance", invoiceId };
  }

  const customer = await db.getCustomerById(booking.customerId);
  if (!customer) return { outcome: "customer_not_found" };

  const expiresAt = balanceLinkExpiresAt(now);
  const number = generateInvoiceNumber();
  const payToken = randomBytes(24).toString("hex");
  const invoiceId = await db.createInvoice({
    number,
    bookingId,
    customerId: booking.customerId,
    amount,
    kind: "balance",
    status: "sent",
    dueDate: expiresAt.toISOString().slice(0, 10),
    payToken,
    linkSentAt: now,
    linkExpiresAt: expiresAt,
  });

  const session = await createBalanceCheckoutSession({
    invoice: { id: invoiceId, number, amount, payToken },
    booking,
    customerEmail: customer.email,
    origin,
    now,
  });
  await db.updateInvoice(invoiceId, { stripeSessionId: session.id });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const emailed = await sendBalanceDueEmail(
    toBalanceEmailData(booking, customer, { number, amount }, balancePayUrl(origin, payToken), expiresAt, bizPhone)
  );

  return { outcome: "link_sent", invoiceId, amount, emailed };
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

export type ResendOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_a_balance_invoice" }
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
