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
  sendPaymentReceiptEmail,
  sendRefundNeededAlert,
  lastEmailError,
  type BalanceEmailData,
} from "./emails";
import { EXTRA_NAMES, loadPricingConfig, SERVICE_NAMES } from "./routers/booking";
import { getStripe } from "./stripe";
import { sendTipRequestEmailSafely } from "./tip";
import {
  baseAmountOf,
  isV2LineItem,
  lineItemAmountCents,
  lineItemName,
  lineItemsTotal,
  lineItemsTotalCents,
  parseLineItems,
  serializeLineItems,
  type InvoiceLineItem,
} from "@shared/invoiceItems";
import { centsToDollars, dollarsToCents } from "@shared/money";
import { loadAddonCatalog, resolveSelectedAddons } from "./addonCatalog";
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
export function balanceDueForBooking(
  booking: Pick<Booking, "totalAmount" | "totalAmountCents" | "depositAmount" | "depositAmountCents" | "stripePaymentIntentId">
): number {
  const totalCents = booking.totalAmountCents ?? dollarsToCents(booking.totalAmount);
  const depositCents = booking.stripePaymentIntentId
    ? booking.depositAmountCents ?? dollarsToCents(booking.depositAmount)
    : 0;
  return centsToDollars(Math.max(0, totalCents - depositCents));
}

function toBalanceEmailData(
  booking: Booking,
  customer: Customer,
  invoice: Pick<Invoice, "number" | "amount"> & { amountCents?: number | null; items?: InvoiceLineItem[] },
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = booking.locale as "en" | "es";
  const invoiceAmount = centsToDollars(invoice.amountCents ?? dollarsToCents(invoice.amount));
  const bookingTotal = centsToDollars(booking.totalAmountCents ?? dollarsToCents(booking.totalAmount));
  const bookingDeposit = booking.stripePaymentIntentId
    ? centsToDollars(booking.depositAmountCents ?? dollarsToCents(booking.depositAmount))
    : 0;
  // Balances exist for completed jobs, which paid their way past the
  // completeness gate — the fallbacks are for the type system.
  return {
    reference: booking.reference,
    invoiceNumber: invoice.number,
    serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
    date: booking.scheduledDate ?? "",
    total: bookingTotal,
    deposit: bookingDeposit,
    balance: invoiceAmount,
    // The itemization, when this invoice has one: the base service line plus
    // each named charge, exactly as approved — names already in the
    // customer's language. The email renders these so the total is never a
    // mystery.
    baseAmount: baseAmountOf(invoiceAmount, invoice.items ?? []),
    items: (invoice.items ?? []).map(item => ({
      name: lineItemLabel(item, locale),
      amount: centsToDollars(lineItemAmountCents(item)),
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
 * The same email payload for an invoice with NO booking behind it — the manual
 * invoices an owner raises by hand.
 *
 * Manual invoices are billable on identical terms, but the booking-derived
 * fields simply do not exist: there is no reference, no service date, no
 * address, and above all no deposit. Rather than invent placeholders, the
 * fields that would be fiction are left empty and `deposit` is zero with
 * `total` equal to the amount owed — so the templates' "Total − deposit =
 * balance" arithmetic stays true (X − 0 = X) instead of implying a credit the
 * customer never paid. The email builders already omit blank lines.
 *
 * Locale follows the customer's own preference, since no booking carries one.
 */
function toManualEmailData(
  customer: Customer,
  invoice: Pick<Invoice, "number" | "amount"> & { amountCents?: number | null; items?: InvoiceLineItem[] },
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = (customer.preferredLocale as "en" | "es") ?? "en";
  const items = invoice.items ?? [];
  const invoiceAmount = centsToDollars(invoice.amountCents ?? dollarsToCents(invoice.amount));
  return {
    reference: "",
    invoiceNumber: invoice.number,
    serviceName: locale === "es" ? "Servicios de limpieza" : "Cleaning services",
    date: "",
    total: invoiceAmount,
    deposit: 0,
    balance: invoiceAmount,
    baseAmount: baseAmountOf(invoiceAmount, items),
    items: items.map(item => ({ name: lineItemLabel(item, locale), amount: centsToDollars(lineItemAmountCents(item)) })),
    customerName: customer.firstName,
    customerEmail: customer.email ?? "",
    customerPhone: customer.phone ?? undefined,
    payUrl,
    expiresOn: expiresOn.toISOString().slice(0, 10),
    locale,
    bizPhone,
  };
}

/**
 * Email payload for any invoice, with or without a booking. One call site for
 * both kinds keeps the manual flow on exactly the templates, itemization and
 * transport the balance flow uses — the point of reusing the machinery rather
 * than forking it.
 */
export function toInvoiceEmailData(
  booking: Booking | undefined,
  customer: Customer,
  invoice: Pick<Invoice, "number" | "amount"> & { amountCents?: number | null; items?: InvoiceLineItem[] },
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  return booking
    ? toBalanceEmailData(booking, customer, invoice, payUrl, expiresOn, bizPhone)
    : toManualEmailData(customer, invoice, payUrl, expiresOn, bizPhone);
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
  amountCents?: number;
  items: InvoiceLineItem[];
  serviceName: string;
  locale: "en" | "es";
  description: string;
}): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const { amount, items, serviceName, locale, description } = args;
  const totalCents = args.amountCents ?? dollarsToCents(amount);
  const baseCents = Math.max(0, totalCents - lineItemsTotalCents(items));
  const lines: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  if (baseCents > 0 || items.length === 0) {
    lines.push({
      price_data: {
        currency: "usd",
        unit_amount: baseCents,
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
        unit_amount: lineItemAmountCents(item),
        product_data: { name: lineItemLabel(item, locale) },
      },
      quantity: 1,
    });
  }
  return lines;
}

/** An item's customer-facing label: add-ons localize, custom names verbatim. */
export function lineItemLabel(item: InvoiceLineItem, locale: "en" | "es"): string {
  if (isV2LineItem(item)) return lineItemName(item, locale);
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
  addonIds: string[],
  customItems: { name: string; amount: number }[]
): Promise<InvoiceLineItem[]> {
  const catalog = await loadAddonCatalog(false);
  if (catalog.enabled) {
    const selected = await resolveSelectedAddons(addonIds);
    const addons: InvoiceLineItem[] = selected.addons.map(addon => ({
      version: 2,
      kind: "addon",
      catalogKey: addon.key,
      nameEn: addon.nameEn,
      nameEs: addon.nameEs,
      amountCents: addon.startingPriceCents,
      priceMode: addon.priceMode,
      source: "approval",
    }));
    const customs: InvoiceLineItem[] = customItems.map(item => ({
      version: 2,
      kind: "custom",
      nameEn: item.name.trim(),
      nameEs: item.name.trim(),
      amountCents: dollarsToCents(item.amount),
      source: "approval",
    }));
    return [...addons, ...customs];
  }
  const pricing = await loadPricingConfig();
  const addons: InvoiceLineItem[] = addonIds.map(id => ({
    kind: "addon",
    id: id as never,
    name: EXTRA_NAMES[id]?.en ?? id,
    amount: Math.max(1, Math.round(pricing.extras[id as ExtraId] ?? 0)),
  }));
  const customs: InvoiceLineItem[] = customItems.map(item => ({
    kind: "custom",
    name: item.name.trim(),
    amount: Math.round(item.amount),
  }));
  return [...addons, ...customs];
}

/** Creates a Checkout Session for an outstanding balance invoice. */
export async function createBalanceCheckoutSession(args: {
  invoice: Pick<Invoice, "id" | "number" | "amount" | "payToken"> & { amountCents?: number | null; items?: InvoiceLineItem[] };
  /** Absent for a manual invoice, which has no job behind it. */
  booking?: Pick<Booking, "id" | "reference" | "serviceType" | "locale" | "scheduledDate">;
  customerEmail: string;
  origin: string;
  now?: Date;
  /** Locale to bill in when there is no booking to take it from. */
  locale?: "en" | "es";
}): Promise<Stripe.Checkout.Session> {
  const { invoice, booking, customerEmail, origin } = args;
  const now = args.now ?? new Date();
  const locale = (booking?.locale as "en" | "es") ?? args.locale ?? "en";
  // Balance work happens on completed jobs, which paid their way past the
  // completeness gate — the fallback is for the type system. A manual invoice
  // bills generic cleaning services, since no job defines the service.
  const serviceName = booking
    ? SERVICE_NAMES[booking.serviceType ?? "residential"][locale]
    : locale === "es"
      ? "Servicios de limpieza"
      : "Cleaning services";
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
      amountCents: invoice.amountCents ?? undefined,
      items: invoice.items ?? [],
      serviceName,
      locale,
      description: booking
        ? locale === "es"
          ? `Reserva ${booking.reference} · Servicio del ${booking.scheduledDate} · Factura ${invoice.number}`
          : `Booking ${booking.reference} · Service on ${booking.scheduledDate} · Invoice ${invoice.number}`
        : locale === "es"
          ? `Factura ${invoice.number}`
          : `Invoice ${invoice.number}`,
    }),
    // payment_type stays "balance" for both kinds: it is what the webhook
    // switches on to route the settlement, and a manual invoice settles
    // through exactly the same path. The booking_* keys are omitted rather
    // than stubbed when there is no booking.
    metadata: {
      payment_type: BALANCE_PAYMENT_TYPE,
      invoice_id: String(invoice.id),
      invoice_number: invoice.number,
      ...(booking ? { booking_id: String(booking.id), booking_reference: booking.reference } : {}),
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
  const amountCents = dollarsToCents(amount);
  const now = new Date();

  if (amount <= 0) {
    // Nothing left to collect — record a settled invoice so the job still shows
    // up as paid in Admin → Invoices, and send no payment link.
    const invoiceId = await db.createInvoice({
      number: generateInvoiceNumber(),
      bookingId,
      customerId: booking.customerId,
      amount: 0,
      amountCents: 0,
      computedAmount: 0,
      computedAmountCents: 0,
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
    amountCents,
    computedAmount: amount,
    computedAmountCents: amountCents,
    kind: "balance",
    status: "awaiting_approval",
  });

  // Tell the owner there is money waiting on them, so it can't sit forgotten.
  await notifyApprovalNeeded(invoiceId, booking, amount, amountCents);

  return { outcome: "awaiting_approval", invoiceId, amount };
}

/** Owner alert that a completed job is waiting for balance approval. */
async function notifyApprovalNeeded(invoiceId: number, booking: Booking, amount: number, amountCents: number): Promise<void> {
  try {
    const customer = await db.getCustomerById(booking.customerId);
    const invoice = await db.getInvoiceById(invoiceId);
    if (!customer || !invoice) return;
    await sendBalanceApprovalNeededAlert(
      toBalanceEmailData(booking, customer, { number: invoice.number, amount, amountCents }, "", new Date())
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
  addonIds?: string[];
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
  const baseCents = args.adjustedAmount !== undefined
    ? dollarsToCents(args.adjustedAmount)
    : invoice.amountCents ?? dollarsToCents(invoice.amount);
  const amountCents = baseCents + lineItemsTotalCents(items);
  const amount = centsToDollars(amountCents);
  const now = new Date();

  // An admin can zero out the balance (goodwill, or the deposit turned out to
  // cover it). Settle it outright rather than emailing a $0 payment link.
  if (amount <= 0) {
    await db.updateInvoice(invoiceId, {
      amount: 0,
      amountCents: 0,
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
    invoice: { id: invoiceId, number: invoice.number, amount, amountCents, payToken, items },
    booking,
    customerEmail: customer.email ?? "",
    origin,
    now,
  });

  await db.updateInvoice(invoiceId, {
    amount,
    amountCents,
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
    ),
    { invoiceId, bookingId: booking.id }
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
  // Nothing to resend before an admin has approved the amount.
  if (invoice.status === "awaiting_approval") return { outcome: "awaiting_approval" };
  if (invoice.status === "paid") return { outcome: "already_paid" };
  if (invoice.status === "void") return { outcome: "voided" };
  // A manual invoice legitimately has no booking; a balance invoice that lost
  // its booking is a broken row and still refuses.
  const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
  if (invoice.kind === "balance" && !booking) return { outcome: "booking_not_found" };
  // Pre-feature manual invoices were never issued a link and have no items,
  // amount history or customer email path behind them; there is nothing to
  // re-send, as opposed to a link to renew.
  if (invoice.kind !== "balance" && !invoice.payToken) return { outcome: "not_a_balance_invoice" };
  const customer = await db.getCustomerById(invoice.customerId);
  if (!customer) return { outcome: "customer_not_found" };

  const now = new Date();
  const expiresAt = balanceLinkExpiresAt(now);
  const payToken = invoice.payToken ?? randomBytes(24).toString("hex");

  // The stored snapshot, untouched: a resend re-bills exactly what was
  // approved, whatever the catalog says today.
  const items = parseLineItems(invoice.lineItems);
  const session = await createBalanceCheckoutSession({
    invoice: { id: invoice.id, number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, payToken, items },
    booking,
    customerEmail: customer.email ?? "",
    origin,
    now,
    locale: (customer.preferredLocale as "en" | "es") ?? "en",
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
    toInvoiceEmailData(
      booking,
      customer,
      { number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, items: parseLineItems(invoice.lineItems) },
      payUrl,
      expiresAt,
      bizPhone
    ),
    { invoiceId: invoice.id, bookingId: booking?.id }
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
      // Every settled invoice earns a receipt — balance or manual, in the
      // customer's language. Sent before the tip ask so the proof of payment
      // lands first and the optional ask follows it.
      await sendPaymentReceiptSafely({ ...invoice, paidAt: new Date() }, "card");
      // The balance landing is the moment the customer owes nothing — time
      // for the thank-you with the tip ask. Claimed once inside; a webhook
      // redelivery loses the settle claim above and never reaches this line.
      //
      // Balance invoices only: a tip asks the customer to reward the crew for
      // a job just finished. A manual invoice has no completed job behind it,
      // so the ask would be meaningless (and the kind check is belt-and-braces
      // over bookingId, which a manual invoice never has).
      if (invoice.kind === "balance" && invoice.bookingId) {
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
    // A manual invoice has no booking by design; a balance invoice missing its
    // booking is a broken row and is skipped rather than emailed half-blank.
    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    if (invoice.kind === "balance" && !booking) continue;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer) continue;

    if (due.action === "owner_alert") {
      if (!(await db.claimBalanceReminderExhaustedAlert(invoice.id, now))) continue;
      await sendBalanceReminderExhaustedAlert(
        toInvoiceEmailData(
          booking,
          customer,
          { number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, items: parseLineItems(invoice.lineItems) },
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
      toInvoiceEmailData(
        booking,
        customer,
        { number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, items: parseLineItems(invoice.lineItems) },
        balancePayUrl(origin, invoice.payToken ?? ""),
        expiresAt,
        bizPhone
      ),
      due.reminderNumber,
      { invoiceId: invoice.id, bookingId: booking?.id }
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
    // A manual invoice has no booking; only a missing customer makes the
    // notification unbuildable.
    if (!customer) return;
    await send(
      toInvoiceEmailData(
        booking,
        customer,
        { number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, items: parseLineItems(invoice.lineItems) },
        balancePayUrl("", invoice.payToken ?? ""),
        invoice.linkExpiresAt ? new Date(invoice.linkExpiresAt) : new Date()
      )
    );
  } catch (error) {
    console.error(`[Balance] Failed to notify owner for invoice ${invoice.id}:`, error);
  }
}

/**
 * Sends the customer their receipt for a settled invoice.
 *
 * Every paid invoice earns one, balance or manual, in the customer's language.
 * Best-effort throughout: the money has already moved by the time this runs, so
 * a mail problem must never fail the settlement that produced it.
 *
 * Kept separate from the tip ask on purpose — see buildPaymentReceiptEmail.
 */
export async function sendPaymentReceiptSafely(
  invoice: Invoice,
  paidVia: "card" | "manual"
): Promise<void> {
  try {
    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer?.email) return;
    const data = toInvoiceEmailData(
      booking,
      customer,
      { number: invoice.number, amount: invoice.amount, amountCents: invoice.amountCents, items: parseLineItems(invoice.lineItems) },
      // A receipt carries no payment link: the invoice is settled, and a live
      // "pay now" URL on a receipt invites a second payment.
      "",
      new Date(),
      (await db.getSetting("business_phone"))?.trim() || undefined
    );
    await sendPaymentReceiptEmail(
      {
        ...data,
        paidOn: (invoice.paidAt ? new Date(invoice.paidAt) : new Date()).toISOString().slice(0, 10),
        paidVia,
      },
      { invoiceId: invoice.id, bookingId: invoice.bookingId ?? null }
    );
  } catch (error) {
    console.error(`[Balance] Failed to send receipt for invoice ${invoice.id}:`, error);
  }
}

export type ManualInvoiceOutcome =
  | { outcome: "customer_not_found" }
  | { outcome: "customer_has_no_email" }
  | {
      outcome: "issued";
      invoiceId: number;
      number: string;
      amount: number;
      emailed: boolean;
      expiresOn: string;
      emailError?: string;
    };

/**
 * Raises a manual invoice and bills it — the owner-initiated counterpart to a
 * balance invoice, for work with no booking behind it.
 *
 * Everything downstream of creation is the balance machinery unchanged: the
 * same token, the same /api/pay/balance/:token route, the same Stripe session
 * builder and itemization, the same email template and transport, and the same
 * reminder schedule. The only difference is the absence of a booking, which
 * the email and session builders handle explicitly rather than by faking one.
 *
 * The entered amount is the SERVICE line; itemized charges add on top, so the
 * admin's previewed total and the billed total are the same arithmetic.
 */
export async function issueManualInvoice(args: {
  customerId: number;
  amount: number;
  dueDate?: string;
  addonIds?: string[];
  customItems?: { name: string; amount: number }[];
  origin: string;
  now?: Date;
}): Promise<ManualInvoiceOutcome> {
  const customer = await db.getCustomerById(args.customerId);
  if (!customer) return { outcome: "customer_not_found" };
  // A payment link nobody can be sent is not an invoice. Refuse before writing
  // a row, rather than leaving an unsendable one behind.
  if (!customer.email) return { outcome: "customer_has_no_email" };

  const now = args.now ?? new Date();
  const items = await resolveLineItems(args.addonIds ?? [], args.customItems ?? []);
  const amountCents = dollarsToCents(args.amount) + lineItemsTotalCents(items);
  const amount = centsToDollars(amountCents);
  const expiresAt = balanceLinkExpiresAt(now);
  const payToken = randomBytes(24).toString("hex");
  const number = generateInvoiceNumber();

  const invoiceId = await db.createInvoice({
    number,
    customerId: args.customerId,
    amount,
    amountCents,
    kind: "manual",
    status: "sent",
    lineItems: serializeLineItems(items),
    // The owner's chosen due date wins; otherwise the link's own window is the
    // due date, exactly as a balance invoice does it.
    dueDate: args.dueDate || expiresAt.toISOString().slice(0, 10),
    payToken,
    linkSentAt: now,
    linkExpiresAt: expiresAt,
  });

  const session = await createBalanceCheckoutSession({
    invoice: { id: invoiceId, number, amount, amountCents, payToken, items },
    customerEmail: customer.email,
    origin: args.origin,
    now,
    locale: (customer.preferredLocale as "en" | "es") ?? "en",
  });
  await db.updateInvoice(invoiceId, { stripeSessionId: session.id });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const emailed = await sendBalanceDueEmail(
    toInvoiceEmailData(
      undefined,
      customer,
      { number, amount, amountCents, items },
      balancePayUrl(args.origin, payToken),
      expiresAt,
      bizPhone
    ),
    { invoiceId }
  );

  return {
    outcome: "issued",
    invoiceId,
    number,
    amount,
    emailed,
    expiresOn: expiresAt.toISOString().slice(0, 10),
    // Same contract as resend: on failure hand back what the mail server said,
    // so the admin sees the real reason rather than "not configured".
    ...(emailed ? {} : { emailError: lastEmailError() ?? undefined }),
  };
}
