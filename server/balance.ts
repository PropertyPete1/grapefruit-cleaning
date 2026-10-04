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
 * keeps the link working for the whole BALANCE_LINK_DAYS window — reopening
 * the invoice's one live session, and minting a replacement only once that
 * session has expired or its payment failed (invoiceCheckout.ts).
 *
 * Delayed payments (ACH) settle in two steps: Checkout completes "unpaid" and
 * the invoice is marked processing, then the async success settles it — or
 * the async failure clears it so the customer can pay again. Settlement is
 * idempotent per payment intent: a second payment for an invoice that is
 * already paid or processing is recorded as a duplicate, never applied, and
 * the owner is told which two payments collided.
 */
import { composeAddress } from "@shared/property";
import { serviceReference } from "@shared/invoiceReference";
import { randomBytes } from "node:crypto";
import type { Stripe } from "stripe";
import type { Booking, Customer, Invoice } from "../drizzle/schema";
import {
  BALANCE_LINK_DAYS,
  BALANCE_PAYMENT_TYPE,
  balanceLinkExpiresAt,
  balanceReminderAction,
  computeBalanceDue,
  depositCaptured,
  settlementKind,
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
  sendBankPaymentFailedEmail,
  sendOwnerAlert,
  lastEmailError,
  type DuplicatePaymentFacts,
  type BalanceEmailData,
  type ReceiptPaymentMethod,
} from "./emails";
import { EXTRA_NAMES, loadPricingConfig, SERVICE_NAMES } from "./routers/booking";
import type { CleaningType } from "@shared/pricing";
import { getStripe } from "./stripe";
import { sendTipRequestEmailSafely } from "./tip";
import { openInvoiceCheckout, readPaymentIntent, type CheckoutResolution, type LivePaymentIntent } from "./invoiceCheckout";
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
import { assertNoDuplicateAddons } from "./addonRules";
import { loadAddonCatalog, resolveSelectedAddons } from "./addonCatalog";
import type { ExtraId } from "@shared/pricing";

/** Metadata tag that marks a Checkout Session as a balance payment (defined with the pure rules). */
export { BALANCE_PAYMENT_TYPE };

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
 * Where the customer says "I'll pay in cash": the pay link plus /cash. Only
 * ever built from a real, absolute pay link — a receipt or an owner alert
 * passes an empty link and gets no cash link either.
 */
export function cashChoiceUrl(payUrl: string): string | undefined {
  return payUrl && payUrl.startsWith("http") ? `${payUrl}/cash` : undefined;
}

/**
 * The invoice facts every customer-facing email reads: the number (for the
 * owner's alerts — customers see the service reference), the money, the
 * items, and the three columns behind the customer-facing wording: their
 * payment preference and the service type and date the bill is named after.
 */
export type InvoiceEmailFacts = Pick<Invoice, "number" | "amount"> & {
  amountCents?: number | null;
  items?: InvoiceLineItem[];
  paymentPreference?: string | null;
  serviceType?: string | null;
  serviceDate?: string | null;
};

/** The facts off a stored invoice row, items parsed. */
export function invoiceFacts(
  invoice: Pick<Invoice, "number" | "amount" | "amountCents" | "lineItems" | "paymentPreference" | "serviceType" | "serviceDate">
): InvoiceEmailFacts {
  return {
    number: invoice.number,
    amount: invoice.amount,
    amountCents: invoice.amountCents,
    items: parseLineItems(invoice.lineItems),
    paymentPreference: invoice.paymentPreference,
    serviceType: invoice.serviceType,
    serviceDate: invoice.serviceDate,
  };
}

/** A manual invoice's service, from what the owner entered, or generic cleaning services. */
function manualServiceName(serviceType: string | null | undefined, locale: "en" | "es"): string {
  const named = serviceType ? SERVICE_NAMES[serviceType]?.[locale] : undefined;
  return named ?? (locale === "es" ? "Servicios de limpieza" : "Cleaning services");
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
  invoice: InvoiceEmailFacts,
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = booking.locale as "en" | "es";
  const serviceName = SERVICE_NAMES[booking.serviceType ?? "residential"][locale];
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
    serviceName,
    date: booking.scheduledDate ?? "",
    // What the customer sees this bill called: "Deep Cleaning — September 28, 2026".
    serviceReference: serviceReference(serviceName, booking.scheduledDate, locale),
    // The invoice's own record of the choice wins; the booking's is where it
    // started (a customer who booked with cash carries it onto the balance).
    paymentPreference: (invoice.paymentPreference ?? booking.paymentPreference ?? null) as "online" | "cash" | null,
    cashUrl: cashChoiceUrl(payUrl),
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
  invoice: InvoiceEmailFacts,
  payUrl: string,
  expiresOn: Date,
  bizPhone?: string
): BalanceEmailData {
  const locale = (customer.preferredLocale as "en" | "es") ?? "en";
  const items = invoice.items ?? [];
  const invoiceAmount = centsToDollars(invoice.amountCents ?? dollarsToCents(invoice.amount));
  // The owner may have named the service and its date on a manual invoice;
  // without them the bill is "Cleaning services" with no date — never a made-up one.
  const serviceName = manualServiceName(invoice.serviceType, locale);
  return {
    reference: "",
    invoiceNumber: invoice.number,
    serviceName,
    date: invoice.serviceDate ?? "",
    serviceReference: serviceReference(serviceName, invoice.serviceDate, locale),
    paymentPreference: (invoice.paymentPreference ?? null) as "online" | "cash" | null,
    cashUrl: cashChoiceUrl(payUrl),
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
  invoice: InvoiceEmailFacts,
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
  /**
   * True when this payment is the whole job — no deposit was captured (an
   * Airbnb turnover, a cash booking, a manual invoice). The line is then the
   * service itself, not a "remaining balance" that implies a deposit before it.
   */
  fullPayment?: boolean;
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
          name: args.fullPayment
            ? serviceName
            : locale === "es"
              ? `Saldo restante — ${serviceName}`
              : `Remaining balance — ${serviceName}`,
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
  customItems: { name: string; amount: number }[],
  /** The service the bill is for: an add-on it already includes is refused, never billed on top. */
  serviceType?: string | null
): Promise<InvoiceLineItem[]> {
  assertNoDuplicateAddons(serviceType, addonIds);
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
  invoice: Pick<Invoice, "id" | "number" | "amount" | "payToken"> & {
    amountCents?: number | null;
    items?: InvoiceLineItem[];
    serviceType?: string | null;
    serviceDate?: string | null;
  };
  /** Absent for a manual invoice, which has no job behind it. */
  booking?: Pick<Booking, "id" | "reference" | "serviceType" | "locale" | "scheduledDate"> &
    Partial<Pick<Booking, "depositAmount" | "depositAmountCents" | "stripePaymentIntentId">>;
  customerEmail: string;
  origin: string;
  now?: Date;
  /** Locale to bill in when there is no booking to take it from. */
  locale?: "en" | "es";
  /**
   * Stripe's expires_at, fixed by the minting attempt (invoiceCheckout.ts) so a
   * retried create sends byte-identical parameters. Defaults to 24h from now.
   */
  expiresAt?: Date;
  /** The minting attempt's Stripe idempotency key (checkoutIdempotencyKey). */
  idempotencyKey?: string;
  /** The claimed attempt, tagged on the session so it can be told from one the old per-visit code minted. */
  attempt?: number;
}): Promise<Stripe.Checkout.Session> {
  const { invoice, booking, customerEmail, origin } = args;
  const now = args.now ?? new Date();
  const locale = (booking?.locale as "en" | "es") ?? args.locale ?? "en";
  // Balance work happens on completed jobs, which paid their way past the
  // completeness gate — the fallback is for the type system. A manual invoice
  // bills what the owner named, or generic cleaning services.
  const serviceName = booking
    ? SERVICE_NAMES[booking.serviceType ?? "residential"][locale]
    : manualServiceName(invoice.serviceType, locale);
  // The customer's name for the bill on the Stripe page too — never the
  // invoice number, which rides only in the session metadata.
  const reference = serviceReference(serviceName, booking ? booking.scheduledDate : invoice.serviceDate, locale);
  // One payment for the whole job when no deposit was captured: an Airbnb
  // turnover, a cash booking, or any manual invoice.
  const fullPayment = !booking || booking.depositAmount === undefined || !depositCaptured({
    depositAmount: booking.depositAmount,
    depositAmountCents: booking.depositAmountCents,
    stripePaymentIntentId: booking.stripePaymentIntentId,
  });
  const payUrl = balancePayUrl(origin, invoice.payToken ?? "");

  return getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: customerEmail,
    client_reference_id: String(invoice.id),
    allow_promotion_codes: false,
    // A single Stripe session tops out at 24 hours; the emailed link keeps
    // working for the full 7-day window by reopening this session while it
    // lives and minting its replacement once it has died.
    expires_at: args.expiresAt ? Math.floor(args.expiresAt.getTime() / 1000) : stripeSessionExpiresAt(now),
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
      fullPayment,
      description: booking
        ? locale === "es"
          ? `${reference} · Reserva ${booking.reference}`
          : `${reference} · Booking ${booking.reference}`
        : reference,
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
      ...(args.attempt != null ? { checkout_attempt: String(args.attempt) } : {}),
    },
    // Session metadata does not reach the PaymentIntent on its own. Copying
    // the routing keys there makes payment_intent.* events (and Stripe-side
    // reconciliation) able to name the invoice. The number is internal and
    // allowed in metadata; it never reaches a Stripe line the customer sees.
    payment_intent_data: {
      metadata: {
        payment_type: BALANCE_PAYMENT_TYPE,
        invoice_id: String(invoice.id),
        invoice_number: invoice.number,
      },
    },
    success_url: `${payUrl}?paid=1`,
    // Marked, so backing out of Stripe lands on a "not completed" page with a
    // button rather than auto-redirecting into the same live session again.
    cancel_url: `${payUrl}?cancelled=1`,
  }, args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined);
}

/**
 * Opens checkout for a balance or manual invoice under the one-live-session
 * rule (invoiceCheckout.ts), with this module's settle and fail paths as its
 * hooks. Every way into checkout for an invoice comes through here: the pay
 * link, approval, resend and manual issue.
 *
 * `facts` override what the stored row says when the caller has not written
 * them yet — an approval mints before it stores the approved amount — and the
 * live session is reopened only if it charges exactly that amount.
 */
export async function openBalanceCheckout(args: {
  invoiceId: number;
  /** Absent for a manual invoice, which has no job behind it. */
  booking?: Parameters<typeof createBalanceCheckoutSession>[0]["booking"];
  customerEmail: string;
  origin: string;
  locale?: "en" | "es";
  facts?: {
    amount: number;
    amountCents: number;
    items: InvoiceLineItem[];
    payToken: string;
    serviceType?: string | null;
    serviceDate?: string | null;
  };
  /** False: look only (the customer back from Stripe) — never mint. */
  mint?: boolean;
}): Promise<CheckoutResolution> {
  const { facts } = args;
  return openInvoiceCheckout(
    args.invoiceId,
    {
      mint: ({ invoice, attempt, expiresAt, idempotencyKey }) =>
        createBalanceCheckoutSession({
          invoice: {
            id: invoice.id,
            number: invoice.number,
            amount: facts?.amount ?? invoice.amount,
            amountCents: facts?.amountCents ?? invoice.amountCents,
            payToken: facts?.payToken ?? invoice.payToken,
            // The stored snapshot, parsed: a reopened link bills exactly the
            // itemization that was approved and emailed.
            items: facts?.items ?? parseLineItems(invoice.lineItems),
            serviceType: facts?.serviceType !== undefined ? facts.serviceType : invoice.serviceType,
            serviceDate: facts?.serviceDate !== undefined ? facts.serviceDate : invoice.serviceDate,
          },
          booking: args.booking,
          customerEmail: args.customerEmail,
          origin: args.origin,
          locale: args.locale,
          expiresAt,
          idempotencyKey,
          attempt,
        }),
      onPaymentSucceeded: (invoiceId, paymentIntentId) => applyBalancePayment(invoiceId, paymentIntentId),
      onPaymentFailed: (invoiceId, paymentIntentId) => clearBalancePaymentProcessing(invoiceId, paymentIntentId),
      customerEmail: args.customerEmail || undefined,
      alertOwner: sendOwnerAlertSafely,
    },
    {
      mint: args.mint,
      ...(facts ? { expectedAmountCents: facts.amountCents } : {}),
    }
  );
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
export async function issueBalanceForCompletedBooking(
  bookingId: number,
  origin: string,
  options: {
    /**
     * False when the owner is the one acting (Paid in Cash issues the balance
     * and settles it in one tap): an "approve this balance" alert about money
     * already in hand is noise. Default true — the crew's completion tap
     * must still tell the owner there is a bill to review.
     */
    notifyOwner?: boolean;
  } = {}
): Promise<CompletionOutcome> {
  const booking = await db.getBookingById(bookingId);
  if (!booking) return { outcome: "booking_not_found" };
  if (booking.status !== "completed") return { outcome: "not_completed" };

  const existing = await db.getBalanceInvoiceForBooking(bookingId);
  if (existing) return { outcome: "already_issued", invoiceId: existing.id };

  const amount = balanceDueForBooking(booking);
  const amountCents = dollarsToCents(amount);
  const now = new Date();
  // What the customer will see this bill called, pinned now: a later edit to
  // the booking cannot rename an invoice already sent. The cash choice a
  // customer made at booking travels onto the bill too.
  const snapshot = {
    serviceType: booking.serviceType ?? null,
    serviceDate: booking.scheduledDate ?? null,
    paymentPreference: booking.paymentPreference ?? null,
    cashChosenAt: booking.cashChosenAt ?? null,
  };

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
      ...snapshot,
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
    ...snapshot,
  });

  // Tell the owner there is money waiting on them, so it can't sit forgotten.
  if (options.notifyOwner !== false) await notifyApprovalNeeded(invoiceId, booking, amount, amountCents);

  return { outcome: "awaiting_approval", invoiceId, amount };
}

/** Owner alert that a completed job is waiting for balance approval. */
async function notifyApprovalNeeded(invoiceId: number, booking: Booking, amount: number, amountCents: number): Promise<void> {
  try {
    const customer = await db.getCustomerById(booking.customerId);
    const invoice = await db.getInvoiceById(invoiceId);
    if (!customer || !invoice) return;
    await sendBalanceApprovalNeededAlert(
      toBalanceEmailData(booking, customer, { ...invoiceFacts(invoice), amount, amountCents }, "", new Date())
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
 * Opens the invoice's Stripe session (under the one-live-session rule) and
 * sends the payment email exactly as the pre-approval flow did.
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
  const items = await resolveLineItems(args.addonIds ?? [], args.customItems ?? [], booking.serviceType);
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
  // Minted before the approval is stored, so a Stripe failure leaves the
  // invoice awaiting approval and retryable. The session is stored on the
  // invoice by the open itself; a live one left by an earlier, failed attempt
  // at a different amount is closed and replaced, never reopened.
  const checkout = await openBalanceCheckout({
    invoiceId,
    booking,
    customerEmail: customer.email ?? "",
    origin,
    facts: { amount, amountCents, items, payToken },
  });
  if (checkout.kind === "paid") return { outcome: "not_awaiting_approval", status: "paid" };
  if (checkout.kind === "closed") return { outcome: "not_awaiting_approval", status: "void" };
  if (checkout.kind !== "redirect") {
    throw new Error(`Could not open checkout for invoice ${invoiceId} (${checkout.kind}) — try again in a moment.`);
  }

  await db.updateInvoice(invoiceId, {
    amount,
    amountCents,
    lineItems: serializeLineItems(items),
    status: "sent",
    approvedAt: now,
    approvedByUserId,
    dueDate: expiresAt.toISOString().slice(0, 10),
    payToken,
    linkSentAt: now,
    linkExpiresAt: expiresAt,
  });

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const emailed = await sendBalanceDueEmail(
    toBalanceEmailData(
      booking,
      customer,
      { ...invoiceFacts(invoice), amount, amountCents, items },
      balancePayUrl(origin, payToken),
      expiresAt,
      bizPhone
    ),
    { invoiceId, bookingId: booking.id }
  );

  return { outcome: "approved", invoiceId, amount, emailed, expiresOn: expiresAt.toISOString().slice(0, 10) };
}

export type SyncOutcome =
  | { outcome: "not_found" }
  | { outcome: "no_link" }
  /** paid / processing / open (a live checkout, nothing paid) / none (no checkout yet) / closed (void). */
  | { outcome: "checked"; state: "paid" | "processing" | "open" | "none" | "closed" | "busy" };

/**
 * "Check with Stripe" — the owner's sync for one invoice. Reads its payment
 * state from Stripe and records what it finds: a payment the webhook never
 * reported settles; a bank payment in flight marks the invoice processing; a
 * failed one reopens it (and the customer is told). For an invoice last
 * touched by the old per-visit code, every session of the customer's is read.
 * Never creates a checkout and never emails a payment link.
 */
export async function syncInvoiceWithStripe(invoiceId: number, origin: string): Promise<SyncOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  if (!invoice.payToken) return { outcome: "no_link" };
  const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
  const customer = await db.getCustomerById(invoice.customerId);
  const look = await openBalanceCheckout({
    invoiceId,
    booking,
    customerEmail: customer?.email ?? "",
    origin,
    mint: false,
  });
  return { outcome: "checked", state: look.kind === "redirect" ? "open" : look.kind };
}

export type ResendOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_a_balance_invoice" }
  | { outcome: "awaiting_approval" }
  | { outcome: "already_paid" }
  | { outcome: "voided" }
  | { outcome: "payment_processing" }
  | { outcome: "booking_not_found" }
  | { outcome: "customer_not_found" }
  | { outcome: "resent"; payUrl: string; emailed: boolean; expiresOn: string; emailError?: string };

/**
 * Re-sends a balance payment link, reopening the 7-day window from now. Works
 * for links that have expired as well as ones still outstanding; a paid or
 * voided invoice is refused, and so is one whose bank payment is processing —
 * re-sending a pay link to a customer who has paid is how a second debit
 * happens. The invoice's live session is reopened, not replaced.
 */
export async function resendBalanceLink(invoiceId: number, origin: string): Promise<ResendOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  // Nothing to resend before an admin has approved the amount.
  if (invoice.status === "awaiting_approval") return { outcome: "awaiting_approval" };
  if (invoice.status === "paid") return { outcome: "already_paid" };
  if (invoice.status === "void") return { outcome: "voided" };
  // A payment marked processing is NOT refused here: the open below asks
  // Stripe first. Still processing → refused; settled since → "already paid"
  // (and recorded); failed since → reopened and the link goes out. That makes
  // Resend the owner's way to sync an invoice whose bank answer the webhook
  // missed.
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
  // approved, whatever the catalog says today. A session still live is
  // reopened rather than replaced; Stripe is asked first whether a payment
  // has started since the row was read.
  const items = parseLineItems(invoice.lineItems);
  const facts = invoiceFacts(invoice);
  const checkout = await openBalanceCheckout({
    invoiceId: invoice.id,
    booking,
    customerEmail: customer.email ?? "",
    origin,
    locale: (customer.preferredLocale as "en" | "es") ?? "en",
    facts: {
      amount: facts.amount,
      amountCents: facts.amountCents ?? Math.round(facts.amount * 100),
      items,
      payToken,
      serviceType: invoice.serviceType,
      serviceDate: invoice.serviceDate,
    },
  });
  if (checkout.kind === "paid") return { outcome: "already_paid" };
  if (checkout.kind === "closed") return { outcome: "voided" };
  if (checkout.kind === "processing") return { outcome: "payment_processing" };
  if (checkout.kind !== "redirect") {
    throw new Error(`Could not open checkout for invoice ${invoice.id} (${checkout.kind}) — try again in a moment.`);
  }

  await db.updateInvoice(invoice.id, {
    status: "sent",
    payToken,
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
    toInvoiceEmailData(booking, customer, invoiceFacts(invoice), payUrl, expiresAt, bizPhone),
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
  /** A redelivery of a payment already on file — nothing to do. */
  | { outcome: "duplicate" }
  /** Stripe shows this payment fully refunded: no money is held, so nothing is applied or recorded. */
  | { outcome: "refunded" }
  /** A second real payment: recorded as a duplicate, never applied, owner alerted. */
  | { outcome: "refund_needed" }
  | { outcome: "paid" };

/** How the money moved, as the ledger and the receipt name it. */
export type StripeSettlementMethod = "card" | "bank";

/**
 * Settles a balance invoice from a successful Stripe payment: a paid
 * checkout.session.completed (card), a checkout.session.async_payment_succeeded
 * (ACH), a payment_intent.succeeded, or the pay route seeing Stripe report the
 * session paid before the webhook did.
 *
 * Idempotent per payment intent. A redelivered event for the payment already
 * on file is a no-op. Any OTHER payment for an invoice that is already settled
 * (collected in person, voided, paid once already) or whose own payment is
 * still processing is real money arriving twice: recorded as a duplicate,
 * never applied — the invoice, its amount and its settling intent are left
 * exactly as they were — and the owner is told both payment ids so a refund
 * can go out at once.
 */
export async function applyBalancePayment(
  invoiceId: number,
  paymentIntentId: string | null,
  options: { method?: StripeSettlementMethod } = {}
): Promise<BalancePaymentOutcome> {
  // Stripe's own record of this payment, read once: a payment the owner has
  // already refunded in full holds no money and is never applied — a late
  // event, or a session that still reads "paid" after its refund, must not
  // settle an invoice with money that went back.
  let live: LivePaymentIntent | null = null;
  if (paymentIntentId) {
    try {
      live = await readPaymentIntent(paymentIntentId);
    } catch {
      // Unreadable: go on what the event says.
    }
  }
  if (live?.fullyRefunded) {
    console.warn(`[Balance] Invoice ${invoiceId}: ignoring ${paymentIntentId} — Stripe shows it fully refunded`);
    return { outcome: "refunded" };
  }

  // Bounded retries: each failed claim re-reads what the winner left behind.
  for (let round = 0; round < 3; round += 1) {
    const invoice = await db.getInvoiceById(invoiceId);
    if (!invoice) return { outcome: "not_found" };
    if (invoice.status === "paid" || invoice.status === "void") {
      return settleAgainstPaidInvoice(invoice, paymentIntentId, options.method, live);
    }
    // Already in this invoice's ledger (a recorded duplicate, or one since
    // refunded): it never settles the invoice by the back door. A held
    // duplicate pays only through the Stripe-checked promotion.
    if (paymentIntentId && (await db.findInvoicePaymentByIntent(invoiceId, paymentIntentId))) return { outcome: "duplicate" };

    const inFlight = invoice.paymentProcessingIntentId;
    const method = settlementMethod(live, options.method, Boolean(inFlight && inFlight === paymentIntentId));
    if (inFlight && inFlight !== paymentIntentId) {
      // Another payment is already processing on this invoice. That one owns
      // it; this one is the second.
      return recordDuplicatePayment(invoice, paymentIntentId, method);
    }

    // Claim the invoice before recording anything. The read above is a fast
    // path only — Stripe redelivers events, and a card payment's session and
    // intent both report success — so two callers can both see it unsettled.
    // This UPDATE matches only while it still is, and only for the payment in
    // flight if there is one, which is what stops a second payment row and a
    // second owner notification.
    const paidAt = new Date();
    const claimed = await db.settleUnpaidInvoice(invoiceId, {
      paidAt,
      paidVia: "stripe",
      paidMethod: method,
      stripePaymentIntentId: paymentIntentId ?? undefined,
    });
    if (!claimed) continue;

    // One full payment when no deposit was captured (an Airbnb turnover, a
    // manual invoice); the balance of a deposit otherwise.
    const paidBooking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    await db.createPayment({
      bookingId: invoice.bookingId,
      invoiceId,
      customerId: invoice.customerId,
      amount: invoice.amount,
      amountCents: invoice.amountCents ?? undefined,
      kind: settlementKind(paidBooking),
      method,
      source: "stripe",
      stripePaymentIntentId: paymentIntentId ?? undefined,
      status: "succeeded",
    });
    await notifyOwnerOfBalance(invoice, sendBalancePaidNotification);
    // Every settled invoice earns a receipt — balance or manual, in the
    // customer's language. Sent before the tip ask so the proof of payment
    // lands first and the optional ask follows it.
    await sendPaymentReceiptSafely({ ...invoice, paidAt }, method);
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
    // Duplicates set aside while this payment processed, with the owner told
    // to wait. This payment has cleared: now is the time to refund each one
    // Stripe still shows unrefunded.
    if (invoice.refundNeeded) {
      await sendRefundNowAlerts(invoice, { kind: "settled", intentId: paymentIntentId, method });
    }
    return { outcome: "paid" };
  }
  // Three lost claims in a row: whatever won has recorded this payment or
  // will. Report it as handled rather than risk a second row.
  console.warn(`[Balance] Invoice ${invoiceId}: payment ${paymentIntentId ?? "(no intent)"} lost the settle claim three times`);
  return { outcome: "duplicate" };
}

/**
 * A payment landing on an invoice that is already settled — collected in
 * person, voided, or paid by an earlier delivery of this same event.
 *
 * A redelivery of the payment already on file is a no-op. Anything else is
 * real money arriving twice.
 */
async function settleAgainstPaidInvoice(
  invoice: Invoice,
  paymentIntentId: string | null,
  hint: StripeSettlementMethod | undefined,
  live: LivePaymentIntent | null
): Promise<BalancePaymentOutcome> {
  const samePayment = paymentIntentId != null && invoice.stripePaymentIntentId === paymentIntentId;
  // A paid session with no intent id predates intent tracking; only a
  // Stripe settlement could have produced it, so it is that settlement again.
  const untrackedStripePayment = paymentIntentId == null && invoice.paidVia === "stripe";
  if (samePayment || untrackedStripePayment) return { outcome: "duplicate" };
  return recordDuplicatePayment(invoice, paymentIntentId, settlementMethod(live, hint, false));
}

/**
 * How the money moved, from Stripe's own record of the charge whenever it can
 * be read — never guessed from which event happened to report it, since an
 * ACH success can arrive as payment_intent.succeeded or be seen first by the
 * pay link. A payment that went through processing is a bank payment; a
 * failed read falls back to the event's hint, then to "card".
 */
function settlementMethod(
  live: LivePaymentIntent | null,
  hint: StripeSettlementMethod | undefined,
  wentThroughProcessing: boolean
): StripeSettlementMethod {
  if (hint === "bank" || wentThroughProcessing) return "bank";
  if (live?.method) return live.method;
  return hint ?? "card";
}

/**
 * Tells the owner to refund each duplicate still held on an invoice — every
 * one in its ledger, not only the newest — after first asking Stripe, so an
 * instruction already carried out is not repeated (a refunded one is marked).
 */
async function sendRefundNowAlerts(invoice: Invoice, original: DuplicatePaymentFacts["original"]): Promise<void> {
  for (const held of await db.listHeldDuplicatePayments(invoice.id)) {
    if (!held.stripePaymentIntentId) continue;
    try {
      if ((await readPaymentIntent(held.stripePaymentIntentId)).fullyRefunded) {
        await db.markDuplicatePaymentRefunded(invoice.id, held.stripePaymentIntentId);
        continue;
      }
    } catch {
      // Unreadable: better a repeated reminder than a forgotten refund.
    }
    await notifyOwnerOfBalance(invoice, data =>
      sendRefundNeededAlert(data, {
        duplicateIntentId: held.stripePaymentIntentId,
        duplicateMethod: held.method === "bank" ? "bank" : "card",
        original,
      })
    );
  }
}

/**
 * Records a second payment against an invoice: flagged for refund, written to
 * the ledger as a duplicate so the books show the money, never applied to the
 * invoice, and announced to the owner with both payment ids.
 *
 * At most once per payment intent — the intent already on file as this
 * invoice's last duplicate, or already in its ledger, is a redelivery — but
 * every DISTINCT extra payment is recorded and alerted: a third payment is
 * not swallowed because the invoice already needed one refund.
 */
async function recordDuplicatePayment(
  invoice: Invoice,
  paymentIntentId: string | null,
  method: StripeSettlementMethod
): Promise<BalancePaymentOutcome> {
  if (paymentIntentId != null) {
    if (paymentIntentId === invoice.stripePaymentIntentId || paymentIntentId === invoice.lastDuplicateIntentId) {
      return { outcome: "duplicate" };
    }
    if (await db.findInvoicePaymentByIntent(invoice.id, paymentIntentId)) return { outcome: "duplicate" };
  }
  // Conditional, for the same reason as the settle: two deliveries of the
  // same duplicate must not raise two alerts.
  const flagged = await db.flagInvoiceDuplicatePayment(invoice.id, paymentIntentId);
  if (!flagged) return { outcome: "duplicate" };

  const paidBooking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
  await db.createPayment({
    bookingId: invoice.bookingId,
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    amount: invoice.amount,
    amountCents: invoice.amountCents ?? undefined,
    kind: settlementKind(paidBooking),
    method,
    source: "stripe",
    stripePaymentIntentId: paymentIntentId ?? undefined,
    status: "succeeded",
    duplicate: true,
  });
  await notifyOwnerOfBalance(invoice, data =>
    sendRefundNeededAlert(data, {
      duplicateIntentId: paymentIntentId,
      duplicateMethod: method,
      original: originalPaymentOf(invoice),
    })
  );
  return { outcome: "refund_needed" };
}

/** What the duplicate collided with, as the owner's alert names it. */
function originalPaymentOf(invoice: Invoice): DuplicatePaymentFacts["original"] {
  if (invoice.status === "void") return { kind: "void" };
  if (invoice.status === "paid") {
    if (invoice.paidVia === "manual") return { kind: "settled_by_hand", method: invoice.paidMethod ?? null };
    if (invoice.paidVia === "stripe") {
      return { kind: "settled", intentId: invoice.stripePaymentIntentId ?? null, method: invoice.paidMethod ?? null };
    }
    return { kind: "settled_without_payment" };
  }
  return { kind: "processing", intentId: invoice.paymentProcessingIntentId ?? null };
}

export type BalanceProcessingOutcome =
  | { outcome: "not_found" }
  /** This payment now owns the invoice: the link refuses a new checkout and reminders stop. */
  | { outcome: "processing" }
  /** Already recorded as processing — a redelivery. */
  | { outcome: "already_processing" }
  /** The invoice is settled already; if this payment lands it is recorded as a duplicate then. */
  | { outcome: "settled" }
  /** Another payment is already processing; if this one lands too it is the duplicate. */
  | { outcome: "second_payment" }
  /** A stale event: Stripe says this payment has already succeeded, so it was settled instead. */
  | { outcome: "already_succeeded" }
  /** A stale event: Stripe says this payment has already failed, so nothing was marked. */
  | { outcome: "already_failed" };

/**
 * A delayed payment (ACH, bank transfer) has started: Checkout completed with
 * payment_status "unpaid", or payment_intent.processing arrived. The invoice is
 * marked processing so the pay link says so and refuses a second checkout,
 * and the reminder sweep leaves the customer alone until the bank answers.
 *
 * Stripe neither orders nor promptly redelivers events, so the payment's LIVE
 * status decides, not the event's snapshot: a late "processing" for a payment
 * that has since succeeded settles it, and one that has since failed marks
 * nothing. If Stripe cannot be read, the event is trusted — marking processing
 * is the safe direction (it refuses a checkout; it never takes money).
 */
export async function markBalancePaymentProcessing(
  invoiceId: number,
  paymentIntentId: string
): Promise<BalanceProcessingOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  if (invoice.paymentProcessingIntentId === paymentIntentId) return { outcome: "already_processing" };
  let live: LivePaymentIntent | null = null;
  try {
    live = await readPaymentIntent(paymentIntentId);
  } catch (error) {
    console.warn(`[Balance] Could not read ${paymentIntentId}; trusting the processing event:`, error);
  }
  if (live?.state === "succeeded") {
    await applyBalancePayment(invoiceId, paymentIntentId, { method: live.method ?? "bank" });
    return { outcome: "already_succeeded" };
  }
  if (live?.state === "failed") {
    console.warn(`[Balance] Invoice ${invoiceId}: ignoring a stale processing event — ${paymentIntentId} has already failed`);
    return { outcome: "already_failed" };
  }
  if (invoice.status === "paid" || invoice.status === "void") {
    if (invoice.stripePaymentIntentId === paymentIntentId) return { outcome: "already_processing" };
    console.warn(`[Balance] Invoice ${invoiceId} is ${invoice.status} but payment ${paymentIntentId} started processing — it will be recorded as a duplicate if it lands`);
    return { outcome: "settled" };
  }
  if (invoice.paymentProcessingIntentId) {
    console.warn(
      `[Balance] Invoice ${invoiceId}: payment ${paymentIntentId} started processing while ${invoice.paymentProcessingIntentId} is in flight — a second payment`
    );
    return { outcome: "second_payment" };
  }
  if (await db.markInvoicePaymentProcessing(invoiceId, paymentIntentId)) return { outcome: "processing" };
  // Lost a race: report on what won.
  const after = await db.getInvoiceById(invoiceId);
  if (after?.paymentProcessingIntentId === paymentIntentId) return { outcome: "already_processing" };
  if (after && (after.status === "paid" || after.status === "void")) return { outcome: "settled" };
  return { outcome: "second_payment" };
}

export type BalanceProcessingFailureOutcome =
  | { outcome: "not_found" }
  /** Not the payment the invoice is waiting on — a failed duplicate, or a card declined mid-checkout. */
  | { outcome: "not_processing" }
  /** A stale failure event: Stripe says the payment is still processing (or has since succeeded and was settled). */
  | { outcome: "still_processing" }
  | { outcome: "succeeded" }
  /** Cleared: the link works again, the customer has been told, and the reminders restart. */
  | { outcome: "cleared" }
  /** A duplicate that had already succeeded (and was not refunded) now pays the invoice. */
  | { outcome: "duplicate_promoted" };

/**
 * The processing payment failed (checkout.session.async_payment_failed or
 * payment_intent.payment_failed, or the pay link seeing it fail on Stripe).
 *
 * The payment's LIVE status decides — a declined card and the ACH payment that
 * follows it in one Checkout share a PaymentIntent, and a late "failed" for
 * the decline must not reopen the live bank payment. If Stripe cannot be read
 * this throws: the webhook answers 500 and Stripe retries, rather than reopen
 * an invoice whose money may still be on its way.
 *
 * Once the failure is real, one of three things happens:
 *   - the invoice was settled by hand or voided meanwhile: nothing reopens;
 *   - a second payment, set aside as a duplicate while this one processed,
 *     already succeeded and Stripe shows it unrefunded: it pays the invoice,
 *     in the same write that clears the processing state;
 *   - otherwise the invoice reopens: the window renews for the full seven
 *     days, the reminder sequence restarts, and the customer is emailed that
 *     the payment did not go through, with their link.
 */
export async function clearBalancePaymentProcessing(
  invoiceId: number,
  paymentIntentId: string
): Promise<BalanceProcessingFailureOutcome> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) return { outcome: "not_found" };
  if (invoice.paymentProcessingIntentId !== paymentIntentId) return { outcome: "not_processing" };

  const live = await readPaymentIntent(paymentIntentId);
  if (live.state === "succeeded") {
    await applyBalancePayment(invoiceId, paymentIntentId, { method: live.method ?? "bank" });
    return { outcome: "succeeded" };
  }
  if (live.state !== "failed") {
    console.warn(`[Balance] Invoice ${invoiceId}: ignoring a stale failure event — ${paymentIntentId} is ${live.state} on Stripe`);
    return { outcome: "still_processing" };
  }
  const now = new Date();

  // Settled some other way while the bank payment was in flight — voided, or
  // (from before offline settlement refused) recorded by hand. Nothing
  // reopens; the owner hears that the Stripe payment did not go through, and
  // about any duplicate still held, which now plainly needs refunding.
  if (invoice.status === "paid" || invoice.status === "void") {
    const window = { linkExpiresAt: invoice.linkExpiresAt ?? now, dueDate: invoice.dueDate ?? now.toISOString().slice(0, 10) };
    if (!(await db.clearInvoicePaymentProcessing(invoiceId, paymentIntentId, window))) return { outcome: "not_processing" };
    const held = (await db.listHeldDuplicatePayments(invoiceId)).flatMap(row => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
    await sendOwnerAlertSafely(
      `Bank payment failed on a settled invoice — ${invoice.number}`,
      [
        `The customer's bank payment ${paymentIntentId} on invoice ${invoice.number} failed.`,
        invoice.status === "void"
          ? `The invoice had already been voided, so nothing is owed and nothing reopens.`
          : `The invoice had already been recorded as paid by hand${invoice.paidMethod ? ` (${invoice.paidMethod})` : ""}, so it stays paid and nothing reopens. If that record was made because of this bank payment rather than money in hand, the customer has not actually paid.`,
        ...(held.length > 0 ? [``, `Refund now (held duplicates on this invoice): ${held.join(", ")}`] : []),
      ].join("\n")
    );
    return { outcome: "cleared" };
  }

  // Does a duplicate already hold the customer's money? Every one set aside on
  // this invoice is checked on Stripe — not the ledger, which never learns of
  // refunds by itself. The first that succeeded with nothing refunded and no
  // dispute pays the invoice, in the same write that clears the processing
  // state. Fully refunded ones are marked; a partial refund or a dispute is
  // left to the owner, since then neither "paid" nor "owes everything" is true.
  const refundedDuplicates: string[] = [];
  const unclear: string[] = [];
  for (const held of await db.listHeldDuplicatePayments(invoiceId)) {
    const duplicateId = held.stripePaymentIntentId;
    if (!duplicateId) continue;
    const duplicate = await readPaymentIntent(duplicateId);
    if (duplicate.state === "succeeded" && !duplicate.refunded && !duplicate.disputed) {
      const method: StripeSettlementMethod = duplicate.method ?? (held.method === "bank" ? "bank" : "card");
      if (await db.promoteDuplicatePayment(invoiceId, duplicateId, paymentIntentId, { paidAt: now, paidMethod: method })) {
        await sendOwnerAlertSafely(
          `Payment failed, duplicate now pays — DO NOT refund ${duplicateId} (${invoice.number})`,
          [
            `The bank payment ${paymentIntentId} on invoice ${invoice.number} failed.`,
            `The payment ${duplicateId}, which had been set aside as a duplicate, succeeded and has not been refunded — it now settles this invoice.`,
            ``,
            `Do NOT refund ${duplicateId}: it is now the customer's payment.`,
          ].join("\n")
        );
        await sendPaymentReceiptSafely({ ...invoice, paidAt: now }, method);
        if (invoice.kind === "balance" && invoice.bookingId) {
          await sendTipRequestEmailSafely(invoice.bookingId, publicOrigin(undefined));
        }
        // Any other duplicate still held now needs refunding outright.
        const promoted = await db.getInvoiceById(invoiceId);
        if (promoted?.refundNeeded) await sendRefundNowAlerts(promoted, { kind: "settled", intentId: duplicateId, method });
        return { outcome: "duplicate_promoted" };
      }
      // Lost a race to something that settled or reopened the invoice — re-read on the next event or visit.
      return { outcome: "not_processing" };
    }
    if (duplicate.fullyRefunded) {
      await db.markDuplicatePaymentRefunded(invoiceId, duplicateId);
      refundedDuplicates.push(duplicateId);
    } else if (duplicate.state === "succeeded") {
      unclear.push(duplicateId);
    }
  }

  const expiresAt = balanceLinkExpiresAt(now);
  const cleared = await db.clearInvoicePaymentProcessing(invoiceId, paymentIntentId, {
    linkExpiresAt: expiresAt,
    dueDate: expiresAt.toISOString().slice(0, 10),
  });
  if (!cleared) return { outcome: "not_processing" };

  // Money may still be held (part-refunded or disputed duplicates): the owner
  // decides; the customer is not told to pay again.
  if (unclear.length > 0) {
    await sendOwnerAlertSafely(
      `Bank payment failed — check the duplicate by hand (${invoice.number})`,
      [
        `The customer's bank payment ${paymentIntentId} on invoice ${invoice.number} failed.`,
        `A duplicate payment on this invoice is partly refunded or disputed on Stripe (${unclear.join(", ")}), so the app cannot tell what the customer still owes.`,
        `The invoice is open again but the customer was NOT emailed. Settle it by hand once you have checked Stripe.`,
      ].join("\n")
    );
    return { outcome: "cleared" };
  }

  // A pre-deploy invoice may have another payment of the customer's in flight
  // or landed on a session it no longer points at: ask Stripe before telling
  // the customer to pay again.
  if (invoice.checkoutAttempt === 0 && invoice.stripeSessionId) {
    const look = await openBalanceCheckout({
      invoiceId,
      customerEmail: (await db.getCustomerById(invoice.customerId))?.email ?? "",
      origin: publicOrigin(undefined),
      mint: false,
    });
    if (look.kind === "paid" || look.kind === "processing") {
      await sendOwnerAlertSafely(
        `Bank payment failed, another payment covers it — ${invoice.number}`,
        [
          `The customer's bank payment ${paymentIntentId} on invoice ${invoice.number} failed, but another payment of theirs on this invoice ${look.kind === "paid" ? "has already landed and now settles it" : "is still processing and now owns it"}.`,
          `The customer was not asked to pay again.`,
        ].join("\n")
      );
      return { outcome: "cleared" };
    }
  }

  await db.restartBalanceReminders(invoiceId, now);
  // The customer was told their payment was processing and there was nothing
  // else to do. They hear that it did not go through, with their link.
  const emailed = await sendBankPaymentFailedSafely(invoice, expiresAt);

  await sendOwnerAlertSafely(
    `Bank payment failed — ${invoice.number}`,
    [
      `The customer's bank payment ${paymentIntentId} on invoice ${invoice.number} failed (declined, returned, or bank verification did not complete).`,
      ...(refundedDuplicates.length > 0
        ? [`The duplicate payment ${refundedDuplicates.join(", ")} had already been refunded, so the customer has now paid nothing on this invoice.`]
        : []),
      emailed
        ? `The customer has been emailed that it did not go through, with their payment link (it works for another ${BALANCE_LINK_DAYS} days). The automatic reminders restart from today.`
        : `The customer could NOT be emailed (no email on file, or no public site address configured) — resend the invoice from Admin → Invoices. The automatic reminders restart from today.`,
    ].join("\n")
  );
  return { outcome: "cleared" };
}

/** The customer's "your bank payment didn't go through" email. Never throws; true when it went out. */
async function sendBankPaymentFailedSafely(invoice: Invoice, expiresAt: Date): Promise<boolean> {
  try {
    const origin = publicOrigin(undefined);
    if (!origin || !invoice.payToken) return false;
    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer?.email) return false;
    const data = toInvoiceEmailData(
      booking,
      customer,
      invoiceFacts(invoice),
      balancePayUrl(origin, invoice.payToken),
      expiresAt,
      (await db.getSetting("business_phone"))?.trim() || undefined
    );
    return await sendBankPaymentFailedEmail(data, { invoiceId: invoice.id, bookingId: invoice.bookingId ?? null });
  } catch (error) {
    console.error(`[Balance] Could not email the bank-payment failure for invoice ${invoice.id}:`, error);
    return false;
  }
}

/** An owner alert that can never fail the payment path that raised it. */
async function sendOwnerAlertSafely(title: string, content: string): Promise<void> {
  try {
    await sendOwnerAlert(title, content);
  } catch (error) {
    console.error(`[Balance] Owner alert failed (${title}):`, error);
  }
}

/**
 * Daily sweep over unpaid balance links: a polite reminder at 3 days, one more
 * at 7, then a single owner alert instead of any further customer email.
 *
 * Every send goes through a conditional claim, so overlapping cron firings can
 * never double-email — and a payment landing at any point flips the invoice
 * out of "sent" (or marks it processing), which halts the sequence wherever it
 * stood. Each reminder renews the link's validity window in the same claim, so
 * the URL it carries always works; no Stripe session is minted here, because
 * the pay route opens one when the customer actually arrives.
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
    // A customer who said they will pay in cash is not chased for a card
    // payment: the owner collects and records it. (A payment landing online
    // anyway still settles the invoice through the usual path.)
    if (invoice.paymentPreference === "cash") {
      details.push(`${invoice.number}: skipped — customer chose to pay in cash`);
      continue;
    }
    // A customer whose bank payment is processing has paid. The worklist
    // query already leaves them out; this holds even if a row slips through.
    if (invoice.paymentProcessingAt) {
      details.push(`${invoice.number}: skipped — bank payment processing`);
      continue;
    }
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
          invoiceFacts(invoice),
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
        invoiceFacts(invoice),
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
        invoiceFacts(invoice),
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
  paidVia: ReceiptPaymentMethod,
  tipAmount = 0
): Promise<void> {
  try {
    const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
    const customer = await db.getCustomerById(invoice.customerId);
    if (!customer?.email) return;
    const data = toInvoiceEmailData(
      booking,
      customer,
      invoiceFacts(invoice),
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
        tipAmount,
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
  /** What the customer will see the bill called: "Deep Cleaning — September 28, 2026". Either may be left out. */
  serviceType?: CleaningType;
  serviceDate?: string;
  origin: string;
  now?: Date;
}): Promise<ManualInvoiceOutcome> {
  const customer = await db.getCustomerById(args.customerId);
  if (!customer) return { outcome: "customer_not_found" };
  // A payment link nobody can be sent is not an invoice. Refuse before writing
  // a row, rather than leaving an unsendable one behind.
  if (!customer.email) return { outcome: "customer_has_no_email" };

  const now = args.now ?? new Date();
  const items = await resolveLineItems(args.addonIds ?? [], args.customItems ?? [], args.serviceType ?? null);
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
    serviceType: args.serviceType ?? null,
    serviceDate: args.serviceDate ?? null,
  });

  const facts: InvoiceEmailFacts = {
    number,
    amount,
    amountCents,
    items,
    serviceType: args.serviceType ?? null,
    serviceDate: args.serviceDate ?? null,
  };
  // Opened through the same one-live-session path as every other invoice,
  // which stores the session on the row itself.
  const checkout = await openBalanceCheckout({
    invoiceId,
    customerEmail: customer.email,
    origin: args.origin,
    locale: (customer.preferredLocale as "en" | "es") ?? "en",
    facts: {
      amount,
      amountCents,
      items,
      payToken,
      serviceType: args.serviceType ?? null,
      serviceDate: args.serviceDate ?? null,
    },
  });
  if (checkout.kind !== "redirect") {
    throw new Error(`Could not open checkout for new invoice ${invoiceId} (${checkout.kind}).`);
  }

  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  const emailed = await sendBalanceDueEmail(
    toInvoiceEmailData(undefined, customer, facts, balancePayUrl(args.origin, payToken), expiresAt, bizPhone),
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
