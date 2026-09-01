import * as db from "./db";
import { getStripe } from "./stripe";

export type PaidCheckoutFinalizer = (bookingId: number, paymentIntentId: string | null) => Promise<void>;

export interface CheckoutHoldSweep {
  scanned: number;
  released: number;
  recoveredPaid: number;
  skipped: number;
  errors: Array<{ bookingId: number; reference: string; error: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Close elapsed public checkout sessions before freeing their booking rows.
 *
 * Stripe's minimum Checkout expiry is 30 minutes, while the customer-facing
 * slot hold is 15 minutes. Closing Stripe first prevents an old tab from
 * paying after the slot has been released and rebooked. A paid session is
 * finalized instead; a provider/network error leaves the hold untouched so a
 * still-payable session can never be silently separated from its slot.
 */
export async function releaseExpiredCheckoutHolds(
  now: Date = new Date(),
  finalizePaid?: PaidCheckoutFinalizer
): Promise<CheckoutHoldSweep> {
  const rows = await db.listElapsedDepositBookings(now);
  const summary: CheckoutHoldSweep = {
    scanned: rows.length,
    released: 0,
    recoveredPaid: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of rows) {
    try {
      if (row.stripeSessionId) {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(row.stripeSessionId);
        if (session.payment_status === "paid") {
          if (!finalizePaid) {
            summary.skipped += 1;
            continue;
          }
          await finalizePaid(row.id, (session.payment_intent as string | null) ?? null);
          summary.recoveredPaid += 1;
          continue;
        }
        if (session.status === "open") {
          await stripe.checkout.sessions.expire(row.stripeSessionId);
        } else if (session.status !== "expired") {
          summary.skipped += 1;
          continue;
        }
      }

      if (await db.expireElapsedDepositBooking(row.id, now)) summary.released += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.errors.push({ bookingId: row.id, reference: row.reference, error: errorText(error) });
    }
  }

  return summary;
}
