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
import { composeAddress } from "@shared/property";
import { randomBytes } from "node:crypto";
import type { Stripe } from "stripe";
import type { Booking, Customer, Invoice } from "../drizzle/schema";
import {
  balanceLinkExpiresAt,
  balanceReminderAction,
  computeBalanceDue,
  stripeSessionExpiresAt,
} from "./balanceRules";
import * as db from "./db";
import { publicOrigin, type OriginRequest } from "./publicOrigin";
import {
  sendBalanceApprovalNeededAlert,
  sendBalanceDueEmail,
  sendBalancePaidNotification,
  sendBalanceReminderEmail,
  sendBalanceReminderExhaustedAlert,
  sendRefundNeededAlert,
  lastEmailError,
  type BalanceEmailData,
} from "./emails";
import { EXTRA_NAMES, loadPricingConfig, SERVICE_NAMES } from "./routers/booking";
import { getStripe } from "./stripe";
import { sendTipRequestEmailSafely } from "./tip";
import {
  baseAmountOf,
  lineItemsTotal,
  parseLineItems,
  serializeLineItems,
  type CustomLineItem,
  type InvoiceLineItem,
} from "@shared/invoiceItems";
import type { ExtraId } from "@shared/pricing";

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
 * that approved the balance (same approach as the deposit checkout). Internal
 * callers without a real request fall back to PUBLIC_BASE_URL.
 */
export function originFromRequest(req: OriginRequest | undefined): string {
  return publicOrigin(req);
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
  invoice: Pick<Invoice, "number" | "amount"> & { items?: InvoiceLineItem[] },
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = booking.locale as "en" | "es";
  // Balances exist for completed jobs, which paid their way past the
  // completeness gate — the fallbacks are for the type system.
  return {
    reference: booking.reference,
    invoiceNumber: invoice.number,
    serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
    date: booking.scheduledDate ?? "",
    total: booking.totalAmount,
    deposit: booking.stripePaymentIntentId ? booking.depositAmount : 0,
    balance: invoice.amount,
    // The itemization, when this invoice has one: the base service line plus
    // each named charge, exactly as approved — names already in the
    // customer's language. The email renders these so the total is never a
    // mystery.
    baseAmount: baseAmountOf(invoice.amount, invoice.items ?? []),
    items: (invoice.items ?? []).map(item => ({
      name: lineItemLabel(item, locale),
      amount: item.amount,
    })),
    customerName: customer.firstName,
    customerEmail: customer.email ?? "",
    customerPhone: customer.phone ?? undefined,
    address: composeAddress(booking),
    payUrl,
    expiresOn: expiresOn.toISOString().slice(0, 10),
    locale,
    bizPhone,
  };
}

/**
 * The Stripe line items for an invoice: the base service (when any remains
 * after itemized charges) plus one line per named item, add-ons labeled in
 * the customer's language. Sums to `amount` exactly — the base line is the
 * remainder by definition, and lineItemsTotal never exceeds it because the
 * approval computed amount = base + items.
 */
export function buildStripeLineItems(args: {
  amount: number;
  items: InvoiceLineItem[];
  serviceName: string;
  locale: "en" | "es";
  description: string;
}): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const { amount, items, serviceName, locale, description } = args;
  const base = baseAmountOf(amount, items);
  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  if (base > 0 || items.length === 0) {
    lines.push({
      price_data: {
        currency: "usd",
        unit_amount: base * 100,
        product_data: {
          name: locale === "es" ? `Saldo restante — ${serviceName}` : `Remaining balance — ${serviceName}`,
          description,
        },
      },
      quantity: 1,
    });
  }
  for (const item of items) {
    lines.push({
      price_data: {
        currency: "usd",
        unit_amount: item.amount * 100,
        product_data: { name: lineItemLabel(item, locale) },
      },
      quantity: 1,
    });
  }
  return lines;
}

/** An item's customer-facing label: add-ons localize, custom names verbatim. */
export function lineItemLabel(item: InvoiceLineItem, locale: "en" | "es"): string {
  if (item.kind === "addon") return EXTRA_NAMES[item.id]?.[locale] ?? item.name;
  return item.name;
}

/**
 * Resolve the admin's picked add-on ids and custom lines into the snapshot the
 * invoice stores: names and prices pinned NOW, from the live catalog — an
 * add-on chosen on-site is billed at today's price, and a catalog edit
 * tomorrow cannot rewrite it.
 */
export async function resolveLineItems(
  addonIds: ExtraId[],
  customItems: { name: string; amount: number }[]
): Promise<InvoiceLineItem[]> {
  const pricing = await loadPricingConfig();
  const addons: InvoiceLineItem[] = addonIds.map(id => ({
    kind: "addon",
    id,
    name: EXTRA_NAMES[id]?.en ?? id,
    amount: Math.max(1, Math.round(pricing.extras[id] ?? 0)),
  }));
  const customs: CustomLineItem[] = customItems.map(item => ({
    kind: "custom",
    name: item.name.trim(),
    amount: Math.round(item.amount),
  }));
  return [...addons, ...customs];
}

/** Creates a Checkout Session for an outstanding balance invoice. */
export async function createBalanceCheckoutSession(args: {
  invoice: Pick<Invoice, "id" | "number" | "amount" | "payToken"> & { items?: InvoiceLineItem[] };
  booking: Pick<Booking, "id" | "reference" | "serviceType" | "locale" | "scheduledDate">;
  customerEmail: string;
  origin: string;
  now?: Date;
}): Promise<Stripe.Checkout.Session> {
  const { invoice, booking, customerEmail, origin } = args;
  const now = args.now ?? new Date();
  const locale = booking.locale as "en" | "es";
  // Balance work happens on completed jobs, which paid their way past the
  // completeness gate — the fallback is for the type system.
  const serviceName = SERVICE_NAMES[booking.serviceType ?? "residential"][locale];
  const payUrl = balancePayUrl(origin, invoice.payToken ?? "");

  return getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail,
    client_reference_id: String(invoice.id),
    allow_promotion_codes: false,
    // A single Stripe session tops out at 24 hours; the emailed link keeps
    // working for the full 7-day window by minting a new one on each visit.
    expires_at: stripeSessionExpiresAt(now),
    // One Stripe line per named charge, so the checkout page itemizes exactly
    // what the email itemized: base service, each add-on by name, any custom
    // item. The unit amounts sum to invoice.amount by construction — the base
    // line is defined as the remainder — and old un-itemized invoices keep
    // their single-line shape.
    line_items: buildStripeLineItems({
      amount: invoice.amount,
      items: invoice.items ?? [],
      serviceName,
      locale,
      description:
        locale === "es"
          ? `Reserva ${booking.reference} · Servicio del ${booking.scheduledDate} · Factura ${invoice.number}`
          : `Booking ${booking.reference} · Service on ${booking.scheduledDate} · Invoice ${invoice.number}`,
    }),
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
    // Nothing to collect means the customer is settled the moment the job
    // completes — that is the thank-you-with-tip-ask moment. (The tip flow
    // falls back to the plain thank-you itself when a tip makes no sense.)
    if (result.outcome === "zero_balance") {
      await sendTipRequestEmailSafely(bookingId, origin);
    }
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
  /** Base-service correction only — itemized charges ride in the two lists. */
  adjustedAmount?: number;
  /** Catalog add-ons chosen on-site, priced from the live config at approval. */
  addonIds?: ExtraId[];
  /** One-off named charges. Names are required non-empty — enforced at the
   * API edge and again in resolveLineItems — because an unlabeled amount is
   * the mystery charge this feature exists to kill. */
  customItems?: { name: string; amount: number }[];
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

  // The final amount is built, not typed: the (possibly corrected) base plus
  // every named item. Items are snapshotted here — name and price as of this
  // moment — so a catalog edit tomorrow cannot rewrite what was billed.
  const items = await resolveLineItems(args.addonIds ?? [], args.customItems ?? []);
  const base = args.adjustedAmount ?? invoice.amount;
  const amount = base + lineItemsTotal(items);
  const now = new Date();

  // An admin can zero out the balance (goodwill, or the deposit turned out to
  // cover it). Settle it outright rather than emailing a $0 payment link.
  if (amount <= 0) {
    await db.updateInvoice(invoiceId, {
      amount: 0,
      lineItems: null,
      status: "paid",
      paidAt: now,
      approvedAt: now,
      approvedByUserId,
    });
    // Zeroing the balance settles the customer right here — their thank-you
    // (with the tip ask) goes out now or never.
    await sendTipRequestEmailSafely(booking.id, origin);
    return { outcome: "settled_without_link", invoiceId };
  }

  const expiresAt = balanceLinkExpiresAt(now);
  const payToken = invoice.payToken ?? randomBytes(24).toString("hex");
  const session = await createBalanceCheckoutSession({
    invoice: { id: invoiceId, number: invoice.number, amount, payToken, items },
    booking,
    customerEmail: customer.email ?? "",
    origin,
    now,
  });

  await db.updateInvoice(invoiceId, {
    amount,
    lineItems: serializeLineItems(items),
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
      { number: invoice.number, amount, items },
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
  | { outcome: "resent"; payUrl: string; emailed: boolean; expiresOn: string; emailError?: string };

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

  // The stored snapshot, untouched: a resend re-bills exactly what was
  // approved, whatever the catalog says today.
  const items = parseLineItems(invoice.lineItems);
  const session = await createBalanceCheckoutSession({
    invoice: { id: invoice.id, number: invoice.number, amount: invoice.amount, payToken, items },
    booking,
    customerEmail: customer.email ?? "",
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
    // A manual resend restarts the automatic follow-up sequence from scratch:
    // the clock re-anchors to this linkSentAt, both reminders come back, and
    // the owner alert re-arms.
    reminderCount: 0,
    lastReminderAt: null,
    reminderExhaustedAlertAt: null,
  });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const payUrl = balancePayUrl(origin, payToken);
  const emailed = await sendBalanceDueEmail(
    toBalanceEmailData(
      booking,
      customer,
      { number: invoice.number, amount: invoice.amount, items: parseLineItems(invoice.lineItems) },
      payUrl,
      expiresAt,
      bizPhone
    )
  );

  return {
    outcome: "resent",
    payUrl,
    emailed,
    expiresOn: expiresAt.toISOString().slice(0, 10),
    // On failure, hand back what the mail server actually said so the admin UI
    // can show the real reason rather than a generic "not configured".
    ...(emailed ? {} : { emailError: lastEmailError() ?? undefined }),
  };
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
  if (!alreadySettled) {
    // Claim the invoice before recording anything. The status read above is a
    // fast path only — Stripe redelivers events, so two callers can both see it
    // unsettled. This UPDATE matches only while it still is, which is what
    // stops a second payment row and a second owner notification.
    const claimed = await db.settleUnpaidInvoice(invoiceId, {
      paidAt: new Date(),
      paidVia: "stripe",
      stripePaymentIntentId: paymentIntentId ?? undefined,
    });
    if (claimed) {
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
      // The balance landing is the moment the customer owes nothing — time
      // for the thank-you with the tip ask. Claimed once inside; a webhook
      // redelivery loses the settle claim above and never reaches this line.
      if (invoice.bookingId) {
        await sendTipRequestEmailSafely(invoice.bookingId, publicOrigin(undefined));
      }
      return { outcome: "paid" };
    }
    // Lost the race. Re-read and fall through on what the winner actually left
    // behind, so an identical redelivery still reports "duplicate" and a
    // genuinely different second payment still raises the refund alert.
    const settled = await db.getInvoiceById(invoiceId);
    if (!settled) return { outcome: "not_found" };
    return settleAgainstPaidInvoice(settled, paymentIntentId);
  }

  return settleAgainstPaidInvoice(invoice, paymentIntentId);
}

/**
 * A payment landing on an invoice that is already settled — collected in
 * person, voided, or paid by an earlier delivery of this same event.
 *
 * A redelivery of the payment already on file is a no-op. Anything else is real
 * money arriving twice: it is recorded so the books balance, and the invoice is
 * flagged for refund with an owner alert.
 */
async function settleAgainstPaidInvoice(
  invoice: Invoice,
  paymentIntentId: string | null
): Promise<BalancePaymentOutcome> {
  const samePayment = paymentIntentId != null && invoice.stripePaymentIntentId === paymentIntentId;
  const untrackedStripePayment = paymentIntentId == null && invoice.paidVia === "stripe";
  if (samePayment || untrackedStripePayment || invoice.refundNeeded) return { outcome: "duplicate" };

  // Conditional for the same reason as the settle above: two duplicate
  // deliveries must not raise two refund alerts.
  const flagged = await db.flagInvoiceRefundNeeded(invoice.id, paymentIntentId ?? undefined);
  if (!flagged) return { outcome: "duplicate" };

  // The money did arrive — record it so the books balance against the refund.
  await db.createPayment({
    bookingId: invoice.bookingId,
    invoiceId: invoice.id,
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

/**
 * Daily sweep over unpaid balance links: a polite reminder at 3 days, one more
 * at 7, then a single owner alert instead of any further customer email.
 *
 * Every send goes through a conditional claim, so overlapping cron firings can
 * never double-email — and a payment landing at any point flips the invoice
 * out of "sent", which halts the sequence wherever it stood. Each reminder
 * renews the link's validity window in the same claim, so the URL it carries
 * always works; no new Stripe session is needed because the pay route mints
 * one per visit.
 */
export async function sendDueBalanceReminders(
  origin: string,
  now: Date = new Date()
): Promise<{ scanned: number; reminded: number; alerted: number; details: string[] }> {
  const open = await db.listSentBalanceInvoices();
  const details: string[] = [];
  let reminded = 0;
  let alerted = 0;
  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;

  for (const invoice of open) {
    const due = balanceReminderAction(invoice, now);
    if (!due) continue;
    if (!invoice.bookingId) continue;
    const booking = await db.getBookingById(invoice.bookingId);
    const customer = booking ? await db.getCustomerById(invoice.customerId) : undefined;
    if (!booking || !customer) continue;

    if (due.action === "owner_alert") {
      if (!(await db.claimBalanceReminderExhaustedAlert(invoice.id, now))) continue;
      await sendBalanceReminderExhaustedAlert(
        toBalanceEmailData(
          booking,
          customer,
          { number: invoice.number, amount: invoice.amount, items: parseLineItems(invoice.lineItems) },
          balancePayUrl(origin, invoice.payToken ?? ""),
          invoice.linkExpiresAt ? new Date(invoice.linkExpiresAt) : now,
          bizPhone
        )
      );
      alerted += 1;
      details.push(`${invoice.number}: owner alert — 2 reminders exhausted`);
      continue;
    }

    // No public origin means no absolute pay link to put in an inbox. Skip
    // WITHOUT claiming, so the reminder goes out on the next run once
    // PUBLIC_BASE_URL is configured, rather than burning its one send on a
    // broken relative URL.
    if (!origin) {
      details.push(`${invoice.number}: skipped — no public origin configured`);
      continue;
    }

    const expiresAt = balanceLinkExpiresAt(now);
    const claimed = await db.claimBalanceReminder(
      invoice.id,
      due.reminderNumber - 1,
      { linkExpiresAt: expiresAt, dueDate: expiresAt.toISOString().slice(0, 10) },
      now
    );
    if (!claimed) continue;

    const delivered = await sendBalanceReminderEmail(
      toBalanceEmailData(
        booking,
        customer,
        { number: invoice.number, amount: invoice.amount, items: parseLineItems(invoice.lineItems) },
        balancePayUrl(origin, invoice.payToken ?? ""),
        expiresAt,
        bizPhone
      ),
      due.reminderNumber
    );
    reminded += 1;
    details.push(
      `${invoice.number}: reminder ${due.reminderNumber} → ${customer.email} (${delivered ? "delivered" : "logged"})`
    );
  }

  return { scanned: open.length, reminded, alerted, details };
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
        { number: invoice.number, amount: invoice.amount, items: parseLineItems(invoice.lineItems) },
        balancePayUrl("", invoice.payToken ?? ""),
        invoice.linkExpiresAt ? new Date(invoice.linkExpiresAt) : new Date()
      )
    );
  } catch (error) {
    console.error(`[Balance] Failed to notify owner for invoice ${invoice.id}:`, error);
  }
}
