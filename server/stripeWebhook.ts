import express, { type Express } from "express";
import Stripe from "stripe";
import { finalizeBooking } from "./routers/booking";
import { getStripe } from "./stripe";

/**
 * Stripe webhook endpoint. MUST be registered BEFORE express.json() so the
 * raw body is available for signature verification.
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
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
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
