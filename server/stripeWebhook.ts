import express, { type Express } from "express";
import Stripe from "stripe";
import {
  applyBalancePayment,
  BALANCE_PAYMENT_TYPE,
  clearBalancePaymentProcessing,
  markBalancePaymentProcessing,
} from "./balance";
import { finalizeBooking } from "./routers/booking";
import { getStripe } from "./stripe";
import { applyTipPayment, TIP_PAYMENT_TYPE } from "./tip";

/** The intent id off a session, whether Stripe sent it as an id or expanded. */
function intentIdOf(session: Pick<Stripe.Checkout.Session, "payment_intent">): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

/**
 * Balance and manual invoices, across the three Checkout events.
 *
 * A card settles on checkout.session.completed with payment_status "paid". A
 * delayed method (ACH, bank transfer) completes "unpaid": the invoice is
 * marked processing, and settles only on checkout.session.async_payment_
 * succeeded — or is cleared for a retry on async_payment_failed. Every path is
 * idempotent per payment intent, so redeliveries and the matching
 * payment_intent.* events below are no-ops.
 */
async function routeBalanceSessionEvent(type: string, session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  const invoiceId = Number(session.metadata?.invoice_id);
  if (!invoiceId) return;
  const intentId = intentIdOf(session);
  if (type === "checkout.session.completed") {
    if (session.payment_status === "paid") {
      const result = await applyBalancePayment(invoiceId, intentId, { method: "card" });
      console.log(`[Stripe Webhook] Invoice ${invoiceId} balance → ${result.outcome} (${eventId})`);
    } else if (session.payment_status === "unpaid" && intentId) {
      const result = await markBalancePaymentProcessing(invoiceId, intentId);
      console.log(`[Stripe Webhook] Invoice ${invoiceId} delayed payment ${intentId} → ${result.outcome} (${eventId})`);
    }
    return;
  }
  if (type === "checkout.session.async_payment_succeeded") {
    const result = await applyBalancePayment(invoiceId, intentId, { method: "bank" });
    console.log(`[Stripe Webhook] Invoice ${invoiceId} delayed payment succeeded → ${result.outcome} (${eventId})`);
    return;
  }
  if (type === "checkout.session.async_payment_failed" && intentId) {
    const result = await clearBalancePaymentProcessing(invoiceId, intentId);
    console.log(`[Stripe Webhook] Invoice ${invoiceId} delayed payment failed → ${result.outcome} (${eventId})`);
  }
}

/**
 * The same lifecycle reported on the PaymentIntent. Balance sessions copy
 * their routing keys onto the intent (payment_intent_data.metadata), so these
 * events can name the invoice; they are a second, independent signal in case
 * an endpoint is subscribed to one family and not the other. Intents from
 * sessions minted before that change carry no metadata and are ignored here —
 * the Checkout events above still cover them.
 */
async function routeBalanceIntentEvent(type: string, intent: Stripe.PaymentIntent, eventId: string): Promise<void> {
  const invoiceId = Number(intent.metadata?.invoice_id);
  if (!invoiceId) return;
  if (type === "payment_intent.processing") {
    const result = await markBalancePaymentProcessing(invoiceId, intent.id);
    console.log(`[Stripe Webhook] Invoice ${invoiceId} intent ${intent.id} processing → ${result.outcome} (${eventId})`);
  } else if (type === "payment_intent.succeeded") {
    const result = await applyBalancePayment(invoiceId, intent.id);
    console.log(`[Stripe Webhook] Invoice ${invoiceId} intent ${intent.id} succeeded → ${result.outcome} (${eventId})`);
  } else if (type === "payment_intent.payment_failed") {
    const result = await clearBalancePaymentProcessing(invoiceId, intent.id);
    console.log(`[Stripe Webhook] Invoice ${invoiceId} intent ${intent.id} failed → ${result.outcome} (${eventId})`);
  }
}

/**
 * Stripe webhook endpoint. MUST be registered BEFORE express.json() so the
 * raw body is available for signature verification.
 *
 * The endpoint must be subscribed (in the Stripe Dashboard) to
 * checkout.session.completed, checkout.session.async_payment_succeeded and
 * checkout.session.async_payment_failed — and, optionally, payment_intent.
 * processing / succeeded / payment_failed. Without the async events a bank
 * payment is marked processing and then only settles when the customer next
 * opens their link.
 */
export function registerStripeWebhook(app: Express): void {
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event: Stripe.Event;
    try {
      if (!signature || !webhookSecret) throw new Error("Missing signature or webhook secret");
      event = getStripe().webhooks.constructEvent(req.body, signature as string, webhookSecret);
    } catch (error) {
      console.error("[Stripe Webhook] Signature verification failed:", error);
      return res.status(400).json({ error: "Invalid signature" });
    }

    // Test events must return this exact verification response.
    if (event.id.startsWith("evt_test_")) {
      console.log("[Stripe Webhook] Test event detected, returning verification response");
      return res.json({ verified: true });
    }

    try {
      switch (event.type) {
        case "checkout.session.async_payment_succeeded":
        case "checkout.session.async_payment_failed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.metadata?.payment_type === BALANCE_PAYMENT_TYPE) {
            await routeBalanceSessionEvent(event.type, session, event.id);
          } else {
            // Tips and deposits do not handle delayed payments yet.
            console.log(`[Stripe Webhook] Unhandled ${event.type} for a non-invoice session ${session.id} (${event.id})`);
          }
          break;
        }
        case "payment_intent.processing":
        case "payment_intent.succeeded":
        case "payment_intent.payment_failed": {
          const intent = event.data.object as Stripe.PaymentIntent;
          if (intent.metadata?.payment_type === BALANCE_PAYMENT_TYPE) {
            await routeBalanceIntentEvent(event.type, intent, event.id);
          }
          break;
        }
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          // Balance payments carry payment_type in their metadata; deposit
          // sessions (which predate it) fall through to the original path.
          if (session.metadata?.payment_type === BALANCE_PAYMENT_TYPE) {
            await routeBalanceSessionEvent(event.type, session, event.id);
            break;
          }
          if (session.metadata?.payment_type === TIP_PAYMENT_TYPE) {
            const tipBookingId = Number(session.metadata?.booking_id);
            // What Stripe actually charged, in whole dollars — the session was
            // minted server-side for a server-computed figure, and this reads
            // that figure back rather than trusting any client input.
            const tipAmount = Math.round((session.amount_total ?? 0) / 100) || Number(session.metadata?.tip_amount);
            if (tipBookingId && tipAmount > 0 && session.payment_status === "paid") {
              const result = await applyTipPayment(tipBookingId, tipAmount, (session.payment_intent as string) ?? null);
              console.log(`[Stripe Webhook] Booking ${tipBookingId} tip → ${result.outcome} (${event.id})`);
            }
            break;
          }
          const bookingId = Number(session.metadata?.booking_id ?? session.client_reference_id);
          if (bookingId && session.payment_status === "paid") {
            await finalizeBooking(bookingId, (session.payment_intent as string) ?? null);
            console.log(`[Stripe Webhook] Booking ${bookingId} finalized (${event.id})`);
          }
          break;
        }
        default:
          console.log(`[Stripe Webhook] Unhandled event: ${event.type} (${event.id})`);
      }
      return res.json({ received: true });
    } catch (error) {
      console.error("[Stripe Webhook] Handler error:", error);
      return res.status(500).json({ error: "Webhook handler failed" });
    }
  });
}
