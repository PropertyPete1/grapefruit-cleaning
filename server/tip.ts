/**
 * Crew tips: the settled-booking thank-you email and the /pay/tip/:token page
 * behind it.
 *
 * The email goes out at the moment the customer owes nothing — balance link
 * paid, invoice marked paid by hand, or a zero balance that auto-settled — and
 * it IS the completion thank-you from now on (the plain "cleaning complete"
 * note and this email share one claim, so a booking gets exactly one of the
 * two). The ask is warm and optional: three preset percentages of the job
 * total, a custom amount, and a clearly offered "no tip, just say thanks".
 *
 * Money follows the house rules: THE CLIENT NEVER SENDS AN AMOUNT it gets to
 * pick freely. It sends a preset id or a custom figure; the server clamps and
 * recomputes every dollar, mints the Stripe session for its own arithmetic,
 * and the webhook records the payment (kind "tip") at most once.
 */
import { randomBytes } from "node:crypto";
import * as db from "./db";
import {
  sendTipReceivedNotification,
  sendTipRequestEmail,
  type TipEmailData,
} from "./emails";
import { SERVICE_NAMES } from "./routers/booking";
import { reviewFormUrl, sendJobCompleteEmailSafely } from "./statusEmails";
import { getStripe } from "./stripe";
import type { Stripe } from "stripe";
import type { Booking } from "../drizzle/schema";

/** Metadata tag that marks a Checkout Session as a tip payment. */
export const TIP_PAYMENT_TYPE = "tip";

/** The preset percentages offered, in the order they are shown. */
export const TIP_PRESET_PERCENTS = [15, 20, 25] as const;

export type TipPresetPercent = (typeof TIP_PRESET_PERCENTS)[number];

/** A preset tip on a job total, in whole dollars — never below $1. */
export function tipPresetAmount(total: number, percent: number): number {
  return Math.max(1, Math.round((total * percent) / 100));
}

/** All presets for a total, precomputed server-side for the email and page. */
export function tipPresets(total: number): { percent: number; amount: number }[] {
  return TIP_PRESET_PERCENTS.map(percent => ({ percent, amount: tipPresetAmount(total, percent) }));
}

/**
 * A customer-typed tip, clamped to the allowed band: at least $1, at most
 * 100% of the job total. Whole dollars — fractions round to the nearest.
 * A tampered request can therefore never charge more than the job itself.
 */
export function clampTipAmount(amount: number, total: number): number {
  const whole = Math.round(amount);
  const max = Math.max(1, Math.round(total));
  return Math.min(max, Math.max(1, whole));
}

/** Customer-facing tip page for a booking token. */
export function tipPayUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/pay/tip/${token}`;
}

/** A tip-page token: 24 random bytes, the same strength as the other pay links. */
export function generateTipToken(): string {
  return randomBytes(24).toString("hex");
}

export type TipPageState = "open" | "paid" | "declined";

/** What the tip page should show for a booking, judged from the row alone. */
export function tipPageState(
  booking: Pick<Booking, "tipPaidAt" | "tipDeclinedAt">
): TipPageState {
  // Paid outranks declined: money that actually arrived is thanked as money,
  // even if a decline landed first from another tab.
  if (booking.tipPaidAt) return "paid";
  if (booking.tipDeclinedAt) return "declined";
  return "open";
}

/**
 * Sends the tip-request thank-you for a completed, fully settled booking, at
 * most once — and never for a cancelled one.
 *
 * Best-effort in the same sense as issueBalanceSafely: this rides along on
 * webhook handlers and admin mutations, and a mail problem must never fail
 * the payment or status change it follows.
 */
export async function sendTipRequestEmailSafely(bookingId: number, origin: string): Promise<void> {
  try {
    const booking = await db.getBookingById(bookingId);
    if (!booking) return;
    // Only a completed job is thanked; a cancelled booking's settled invoice
    // (refunded, voided out-of-band) must never produce a tip ask.
    if (booking.status !== "completed") return;
    // Auto-booked turnovers stay quiet unless the host opted into per-clean
    // notices — same rule as every other per-clean email.
    if (booking.kind === "ical_auto") {
      const property = booking.propertyId ? await db.getConnectedPropertyById(booking.propertyId) : undefined;
      if (!property?.perCleanEmails) return;
    }
    // No total means no presets to compute (a legacy or hand-adjusted row),
    // and no public origin means no tip link an inbox could follow — a
    // relative URL in an email goes nowhere. Either way the customer still
    // deserves their thank-you: the plain one, which shares the same
    // once-per-booking claim so the dedupe holds.
    if (booking.totalAmount <= 0 || !origin) {
      await sendJobCompleteEmailSafely(bookingId, origin);
      return;
    }
    const customer = await db.getCustomerById(booking.customerId);
    if (!customer) return;

    const token = booking.tipToken ?? generateTipToken();
    // The claim is the send decision: it only matches while neither this email
    // nor the plain thank-you has gone out, so double completion, webhook
    // redelivery, and the old email path can produce one thank-you between them.
    if (!(await db.claimTipRequestEmail(bookingId, token))) return;

    const locale = booking.locale as "en" | "es";
    const data: TipEmailData = {
      reference: booking.reference,
      serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
      date: booking.scheduledDate ?? "",
      customerName: customer.firstName,
      customerEmail: customer.email ?? "",
      locale,
      bizPhone: (await db.getSetting("business_phone"))?.trim() || undefined,
      total: booking.totalAmount,
      presets: tipPresets(booking.totalAmount),
      tipUrl: tipPayUrl(origin, token),
      reviewUrl: reviewFormUrl(origin, locale),
    };
    const delivered = await sendTipRequestEmail(data);
    console.log(`[Tip] Booking ${bookingId} settled → tip request ${delivered ? "delivered" : "logged"}`);
  } catch (error) {
    console.error(`[Tip] Failed to send tip request for booking ${bookingId}:`, error);
  }
}

/** Creates a Checkout Session for a tip whose amount the server computed. */
export async function createTipCheckoutSession(args: {
  booking: Pick<Booking, "id" | "reference" | "serviceType" | "locale" | "scheduledDate" | "tipToken">;
  amount: number;
  customerEmail: string | null;
  origin: string;
}): Promise<Stripe.Checkout.Session> {
  const { booking, amount, origin } = args;
  const locale = booking.locale as "en" | "es";
  const serviceName = SERVICE_NAMES[booking.serviceType ?? "residential"][locale];
  const pageUrl = tipPayUrl(origin, booking.tipToken ?? "");

  return getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: args.customerEmail ?? undefined,
    client_reference_id: String(booking.id),
    allow_promotion_codes: false,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amount * 100,
          product_data: {
            name: locale === "es" ? `Propina para su equipo — ${serviceName}` : `Tip for your crew — ${serviceName}`,
            description:
              locale === "es"
                ? `Reserva ${booking.reference} · Servicio del ${booking.scheduledDate}`
                : `Booking ${booking.reference} · Service on ${booking.scheduledDate}`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      payment_type: TIP_PAYMENT_TYPE,
      booking_id: String(booking.id),
      booking_reference: booking.reference,
      tip_amount: String(amount),
      locale,
    },
    success_url: `${pageUrl}?paid=1`,
    cancel_url: pageUrl,
  });
}

export type TipPaymentOutcome =
  | { outcome: "not_found" }
  | { outcome: "duplicate" }
  | { outcome: "paid" };

/**
 * Records a tip from a paid checkout.session.completed event, at most once.
 *
 * Same claim shape as applyBalancePayment: the conditional UPDATE decides, so
 * a redelivered event cannot record a second payment row or cheer the owner
 * twice. A payment with a DIFFERENT intent landing on an already-tipped
 * booking is real money and is still recorded — the extra row in
 * Admin → Payments is what tells the owner to refund it.
 */
export async function applyTipPayment(
  bookingId: number,
  amount: number,
  paymentIntentId: string | null
): Promise<TipPaymentOutcome> {
  const booking = await db.getBookingById(bookingId);
  if (!booking) return { outcome: "not_found" };

  const recordPayment = () =>
    db.createPayment({
      bookingId,
      customerId: booking.customerId,
      amount,
      kind: "tip",
      method: "card",
      stripePaymentIntentId: paymentIntentId ?? undefined,
      status: "succeeded",
    });

  const claimed = await db.claimTipPayment(bookingId, {
    amount,
    stripePaymentIntentId: paymentIntentId ?? undefined,
  });
  if (claimed) {
    await recordPayment();
    await notifyOwnerOfTip(booking, amount);
    return { outcome: "paid" };
  }

  // Already tipped. Re-read what the winner left behind: the same intent is a
  // redelivered event and a no-op; a DIFFERENT intent is real money arriving
  // twice, recorded so the books balance and the owner sees it to refund.
  const settled = await db.getBookingById(bookingId);
  const samePayment = paymentIntentId != null && settled?.tipStripePaymentIntentId === paymentIntentId;
  if (samePayment || paymentIntentId == null) return { outcome: "duplicate" };
  await recordPayment();
  return { outcome: "duplicate" };
}

/** Cheerful owner note — never allowed to fail the webhook. */
async function notifyOwnerOfTip(booking: Booking, amount: number): Promise<void> {
  try {
    const customer = await db.getCustomerById(booking.customerId);
    const locale = booking.locale as "en" | "es";
    await sendTipReceivedNotification({
      reference: booking.reference,
      customerName: customer?.firstName ?? "A customer",
      serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
      date: booking.scheduledDate ?? "",
      amount,
    });
  } catch (error) {
    console.error(`[Tip] Failed to notify owner for booking ${booking.id}:`, error);
  }
}
