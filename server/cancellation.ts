/**
 * What else happens when the owner cancels a booking.
 *
 * The status change itself is one write in Admin → Appointments, and the
 * calendar slot frees on that write (the generated slotKey goes NULL). This
 * module handles the two things that used to be left dangling:
 *
 *   1. Money. Any balance invoice for the job that has not been paid is voided,
 *      so the reminder sweep stops chasing a cleaning that is not happening and
 *      the approval queue does not hold it forever. Paid invoices are never
 *      touched — a paid invoice on a cancelled booking is a refund question
 *      for a person.
 *
 *   2. The customer. When the owner asks, a bilingual cancellation notice goes
 *      out and is logged like every other transactional email. A feed-created
 *      turnover tells the host which listing's clean came off, in the voice of
 *      the automatic notices.
 *
 * Every step is best-effort: a mail or Stripe hiccup must never undo or fail
 * the cancellation the owner just made.
 */
import { composeAddress } from "@shared/property";
import * as db from "./db";
import { sendBookingCancelledEmail } from "./emails";
import { SERVICE_NAMES } from "./routers/booking";
import { getStripe } from "./stripe";

export interface CancellationOptions {
  /** Email the customer (or host) that the booking is cancelled. */
  notifyCustomer: boolean;
  /** Optional short line from the owner, quoted in the email. */
  note?: string | null;
}

export interface CancellationOutcome {
  voidedInvoices: number;
  customerNotified: boolean;
}

export async function applyCancellationSideEffects(
  bookingId: number,
  options: CancellationOptions
): Promise<CancellationOutcome> {
  const outcome: CancellationOutcome = { voidedInvoices: 0, customerNotified: false };
  const booking = await db.getBookingById(bookingId);
  if (!booking) return outcome;

  // 1. Nothing left to collect.
  try {
    const voided = await db.voidUnpaidBalanceInvoicesForBooking(bookingId);
    outcome.voidedInvoices = voided.length;
    for (const invoice of voided) {
      if (!invoice.stripeSessionId) continue;
      // A still-open Checkout for a voided invoice must not be payable from an
      // old tab. Best-effort: the invoice status already blocks the pay route.
      try {
        await getStripe().checkout.sessions.expire(invoice.stripeSessionId);
      } catch (error) {
        console.warn(`[Cancellation] Could not expire session for invoice ${invoice.id}:`, error);
      }
    }
  } catch (error) {
    console.error(`[Cancellation] Could not void invoices for booking ${bookingId}:`, error);
  }

  // 2. The customer hears about it — when the owner asked.
  if (!options.notifyCustomer) return outcome;
  try {
    const customer = await db.getCustomerById(booking.customerId);
    if (!customer?.email) return outcome;
    const locale = (booking.locale as "en" | "es") ?? "en";
    const property =
      booking.kind === "ical_auto" && booking.propertyId
        ? await db.getConnectedPropertyById(booking.propertyId)
        : undefined;
    const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
    outcome.customerNotified = await sendBookingCancelledEmail(
      {
        reference: booking.reference,
        serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"]?.[locale] ?? (booking.serviceType ?? ""),
        date: booking.scheduledDate,
        time: booking.scheduledTime,
        customerName: customer.firstName,
        customerEmail: customer.email,
        locale,
        address: composeAddress(booking) || null,
        propertyLabel: property?.label ?? null,
        note: options.note ?? null,
        bizPhone,
      },
      { bookingId }
    );
  } catch (error) {
    console.error(`[Cancellation] Notice failed for booking ${bookingId}:`, error);
  }
  return outcome;
}

/** The wrapper the routers call: cancellation side effects never fail the status change. */
export async function applyCancellationSideEffectsSafely(
  bookingId: number,
  options: CancellationOptions
): Promise<CancellationOutcome> {
  try {
    return await applyCancellationSideEffects(bookingId, options);
  } catch (error) {
    console.error(`[Cancellation] Side effects failed for booking ${bookingId}:`, error);
    return { voidedInvoices: 0, customerNotified: false };
  }
}
