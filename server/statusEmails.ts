/**
 * Customer-facing job status emails: "we've started" and, for jobs with nothing
 * left to collect, "we're done, thank you".
 *
 * Both are best-effort in the same sense as issueBalanceSafely — a crew member
 * tapping Start job must never see an error because a mailbox was
 * misconfigured, and the booking's status must land regardless.
 *
 * Both are also once-per-booking, claimed through a conditional UPDATE before
 * anything is sent. Claiming first rather than after is deliberate, and matches
 * how the reminder cron marks a send even when delivery fell back to a log: the
 * failure mode of a lost email is one missing note, and the failure mode of an
 * unclaimed one is a customer emailed twice, or ten times by a dashboard being
 * clicked back and forth. The second is worse.
 */
import * as db from "./db";
import { sendJobCompleteEmail, sendJobStartedEmail, type JobStatusEmailData } from "./emails";
import { SERVICE_NAMES } from "./routers/booking";

/**
 * The public review form for a locale, or undefined when no public origin is
 * known — a relative link is useless in an inbox, so the review ask is simply
 * left out rather than rendered broken.
 */
export function reviewFormUrl(origin: string, locale: "en" | "es"): string | undefined {
  const base = origin.replace(/\/+$/, "");
  if (!base) return undefined;
  // Mirrors ROUTE_SLUGS.testimonials in client/src/i18n/types.ts.
  return `${base}/${locale}/${locale === "es" ? "testimonios" : "testimonials"}`;
}

/** Shared lookup: the booking, its customer, and the live business phone. */
async function loadJobStatusEmailData(
  bookingId: number
): Promise<Omit<JobStatusEmailData, "reviewUrl"> | null> {
  const booking = await db.getBookingById(bookingId);
  if (!booking) return null;
  // Auto-booked turnovers stay quiet unless the host opted into per-clean
  // notices — "we've started" for every guest checkout is inbox noise for a
  // host running every turnover through us.
  if (booking.kind === "ical_auto") {
    const property = booking.propertyId ? await db.getConnectedPropertyById(booking.propertyId) : undefined;
    if (!property?.perCleanEmails) return null;
  }
  const customer = await db.getCustomerById(booking.customerId);
  if (!customer) return null;
  const locale = booking.locale as "en" | "es";
  // Status emails fire on confirmed-and-beyond jobs, which paid their way
  // past the completeness gate — the fallbacks are for the type system.
  return {
    reference: booking.reference,
    serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
    date: booking.scheduledDate ?? "",
    customerName: customer.firstName,
    customerEmail: customer.email ?? "",
    locale,
    bizPhone: (await db.getSetting("business_phone"))?.trim() || undefined,
  };
}

/**
 * Tells the customer their crew has arrived. Call only on an actual
 * confirmed → in_progress transition; the claim below is what makes it safe to
 * call more than once anyway.
 */
export async function sendJobStartedEmailSafely(bookingId: number): Promise<void> {
  try {
    if (!(await db.claimJobStartedEmail(bookingId))) return;
    const data = await loadJobStatusEmailData(bookingId);
    if (!data) return;
    const delivered = await sendJobStartedEmail(data);
    console.log(`[StatusEmail] Booking ${bookingId} started → ${delivered ? "delivered" : "logged"}`);
  } catch (error) {
    console.error(`[StatusEmail] Failed to send job-started email for booking ${bookingId}:`, error);
  }
}

/**
 * Thanks the customer for a completed job. Only ever called for a zero-balance
 * booking: when there is a balance to collect, the approved-balance email is
 * the completion notice, and a second "you're done" would just be noise.
 */
export async function sendJobCompleteEmailSafely(bookingId: number, origin: string): Promise<void> {
  try {
    if (!(await db.claimJobCompletedEmail(bookingId))) return;
    const data = await loadJobStatusEmailData(bookingId);
    if (!data) return;
    const delivered = await sendJobCompleteEmail({
      ...data,
      reviewUrl: reviewFormUrl(origin, data.locale),
    });
    console.log(`[StatusEmail] Booking ${bookingId} complete → ${delivered ? "delivered" : "logged"}`);
  } catch (error) {
    console.error(`[StatusEmail] Failed to send job-complete email for booking ${bookingId}:`, error);
  }
}
