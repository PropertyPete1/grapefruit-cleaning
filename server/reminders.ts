/**
 * Scheduled reminder emails: "coming soon" 7 days before the cleaning (when the
 * booking was made at least a week out) and a final reminder 1 day before.
 * Triggered by a Heartbeat cron hitting /api/scheduled/sendReminders.
 * Idempotent: each send is recorded on the booking row (weekReminderSentAt /
 * dayReminderSentAt) so retries never double-send.
 */
import type { Booking, Customer } from "../drizzle/schema";
import * as db from "./db";
import { buildReminderEmail, deliverEmail, type BookingEmailData } from "./emails";
import { EXTRA_NAMES, FREQUENCY_NAMES, SERVICE_NAMES } from "./routers/booking";

/** Days between two YYYY-MM-DD dates (b - a), using UTC to avoid TZ drift. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const utcA = Date.UTC(ay!, (am ?? 1) - 1, ad ?? 1);
  const utcB = Date.UTC(by!, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((utcB - utcA) / 86_400_000);
}

export type ReminderKind = "week" | "day";

/**
 * Decides which reminder (if any) is due for a booking as of `today` (YYYY-MM-DD).
 * - "day": 1 day (or 0 days, as catch-up) before the cleaning, not yet sent.
 * - "week": 6–7 days before the cleaning, not yet sent, and only when the
 *   booking was created at least 7 days before the cleaning date (booked a week out).
 */
export function dueReminderKind(
  booking: Pick<Booking, "scheduledDate" | "status" | "weekReminderSentAt" | "dayReminderSentAt" | "createdAt">,
  today: string,
): ReminderKind | null {
  if (booking.status !== "confirmed" && booking.status !== "in_progress") return null;
  const daysUntil = daysBetween(today, booking.scheduledDate);
  if (daysUntil < 0) return null;
  if (!booking.dayReminderSentAt && daysUntil <= 1) return "day";
  if (!booking.weekReminderSentAt && daysUntil >= 2 && daysUntil <= 7) {
    const createdDate = new Date(booking.createdAt).toISOString().slice(0, 10);
    const leadDays = daysBetween(createdDate, booking.scheduledDate);
    if (leadDays >= 7) return "week";
  }
  return null;
}

function toEmailData(booking: Booking, customer: Customer, bizPhone?: string): BookingEmailData {
  const locale = booking.locale as "en" | "es";
  const extras: string[] = JSON.parse(booking.extras ?? "[]");
  return {
    reference: booking.reference,
    serviceName: SERVICE_NAMES[booking.serviceType][locale],
    date: booking.scheduledDate,
    time: booking.scheduledTime,
    frequencyLabel: FREQUENCY_NAMES[booking.frequency][locale],
    extras: extras.map(e => EXTRA_NAMES[e]?.[locale] ?? e),
    total: booking.totalAmount,
    deposit: booking.depositAmount,
    customerName: customer.firstName,
    customerEmail: customer.email,
    customerPhone: customer.phone ?? undefined,
    address: [booking.addressLine, booking.city, booking.zip].filter(Boolean).join(", "),
    locale,
    bizPhone,
  };
}

/**
 * Scans upcoming bookings and sends any due reminders. Also expires stale
 * unpaid (pending_deposit) checkouts so they release their calendar slots.
 * Returns a summary.
 */
export async function sendDueReminders(
  today?: string
): Promise<{ scanned: number; sent: number; expired: number; details: string[] }> {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const expired = await db.expireStaleDepositBookings();
  const bookings = await db.listUpcomingConfirmedBookings(todayStr);
  const details: string[] = [];
  let sent = 0;
  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
  for (const booking of bookings) {
    const kind = dueReminderKind(booking, todayStr);
    if (!kind) continue;
    const customer = await db.getCustomerById(booking.customerId);
    if (!customer) continue;
    const email = buildReminderEmail(toEmailData(booking, customer, bizPhone), kind);
    const delivered = await deliverEmail(customer.email, email.subject, email.body);
    // Mark as sent even on fallback-log so a misconfigured mailbox can't spam customers later.
    await db.markReminderSent(booking.id, kind);
    sent += 1;
    details.push(`${booking.reference}: ${kind} reminder → ${customer.email} (${delivered ? "delivered" : "logged"})`);
  }
  return { scanned: bookings.length, sent, expired, details };
}
