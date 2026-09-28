/**
 * The review request: "how did we do?" the day after a completed and paid
 * cleaning, pointing at the Google review link from Admin → Settings (or the
 * site's own review form until one is set).
 *
 * Runs on the daily cron beat, after the transactional reminders. Once per
 * job: the send is claimed in a conditional UPDATE on the booking before the
 * email leaves, so a crash mid-run loses an ask rather than repeating one, and
 * two sweeps racing produce one email between them. Respects the marketing
 * unsubscribe — this is an ask, not an invoice — and carries the same one-click
 * unsubscribe link the nudges do. Auto-booked Airbnb turnovers are never asked:
 * a host running every checkout through us would get one per guest.
 *
 * On a customer's first completed job the email also says the recurring plans
 * are now theirs, with the booking link — the moment they become "returning".
 */
import { randomBytes } from "node:crypto";
import { bookingCompletedAndPaid, type InvoiceState } from "@shared/returningCustomer";
import {
  REVIEW_REQUEST_WINDOW_DAYS,
  REVIEW_URL_SETTING_KEY,
  normalizeReviewUrl,
  reviewRequestDue,
} from "@shared/reviewRequest";
import * as db from "./db";
import { sendReviewRequestEmail } from "./emails";
import { bookUrlFor, unsubscribeUrlFor } from "./marketing";
import { SERVICE_NAMES } from "./routers/booking";
import { reviewFormUrl } from "./statusEmails";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewSweepSummary {
  scanned: number;
  sent: number;
  skipped: Record<string, number>;
  details: string[];
}

type Candidate = Awaited<ReturnType<typeof db.listReviewRequestCandidates>>[number];

/**
 * The moment the customer owed nothing: the paid invoice's paidAt, or — for a
 * job the deposit covered outright, which never has an invoice — the
 * completion thank-you's timestamp. Null when neither is known, and a job
 * whose settlement cannot be dated is not asked.
 */
export function settledAtOf(
  booking: Pick<Candidate, "completedEmailSentAt" | "tipEmailSentAt">,
  invoices: readonly (InvoiceState & { paidAt?: Date | null })[]
): Date | null {
  const paid = invoices
    .filter(invoice => invoice.status === "paid" && invoice.paidAt)
    .map(invoice => new Date(invoice.paidAt as Date).getTime());
  if (paid.length > 0) return new Date(Math.max(...paid));
  return booking.completedEmailSentAt ?? booking.tipEmailSentAt ?? null;
}

/**
 * Sends every review request that is due.
 *
 * Without a public origin nothing is sent at all — the unsubscribe link and
 * the fallback review form would both be relative, and an email nobody can act
 * on is worse than none. Same rule as the re-booking nudges.
 */
export async function sendDueReviewRequests(origin: string, now: Date = new Date()): Promise<ReviewSweepSummary> {
  const summary: ReviewSweepSummary = { scanned: 0, sent: 0, skipped: {}, details: [] };
  if (!origin) {
    summary.details.push("no public origin configured — nothing sent");
    return summary;
  }
  const note = (reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  // Scan a little wider than the window so a job settled on its last eligible
  // day is still seen; the timing rule below draws the real line.
  const since = new Date(now.getTime() - (REVIEW_REQUEST_WINDOW_DAYS + 2) * DAY_MS);
  const rows = await db.listReviewRequestCandidates(since);
  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  const invoices = await db.listInvoiceStatesForBookings(rows.map(row => row.bookingId));
  const invoicesByBooking = new Map<number, typeof invoices>();
  for (const invoice of invoices) {
    if (invoice.bookingId == null) continue;
    const list = invoicesByBooking.get(invoice.bookingId) ?? [];
    list.push(invoice);
    invoicesByBooking.set(invoice.bookingId, list);
  }

  const configuredUrl = normalizeReviewUrl(await db.getSetting(REVIEW_URL_SETTING_KEY));
  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;

  for (const row of rows) {
    const rowInvoices = invoicesByBooking.get(row.bookingId) ?? [];
    // Completed AND paid — the same test that makes a customer "returning".
    if (!bookingCompletedAndPaid(row, rowInvoices)) {
      note("unpaid");
      continue;
    }
    const due = reviewRequestDue(settledAtOf(row, rowInvoices), now);
    if (due !== "due") {
      note(due);
      continue;
    }
    if (!row.customerEmail) {
      note("no_email");
      continue;
    }
    // An unsubscribe is honoured here exactly as for the nudges: the ask is
    // skipped, and left unclaimed — the window ages it out on its own.
    if (row.marketingUnsubscribedAt) {
      note("unsubscribed");
      continue;
    }
    const locale = (row.locale as "en" | "es") ?? "en";
    const reviewUrl = configuredUrl ?? reviewFormUrl(origin, locale);
    if (!reviewUrl) {
      note("no_review_url");
      continue;
    }
    // Minted once and kept forever, like the nudges' token: the unsubscribe
    // link in an old email must keep working.
    const token = await db.ensureMarketingToken(row.customerId, randomBytes(24).toString("hex"));
    if (!token) {
      note("no_token");
      continue;
    }
    // Their first completed job — and not already on a plan the owner set —
    // is the moment the recurring plans become theirs to choose.
    const firstJob = (await db.countCompletedBookingsForCustomer(row.customerId)) <= 1 && row.frequency === "onetime";

    // Claim BEFORE sending. See the module comment: a lost ask beats a repeated one.
    if (!(await db.claimReviewRequestEmail(row.bookingId, now))) {
      note("already_claimed");
      continue;
    }

    const sent = await sendReviewRequestEmail({
      bookingId: row.bookingId,
      reference: row.reference,
      serviceName: SERVICE_NAMES[row.serviceType ?? "residential"][locale],
      date: row.scheduledDate ?? "",
      customerName: row.customerFirstName,
      customerEmail: row.customerEmail,
      locale,
      bizPhone,
      reviewUrl,
      googleReview: configuredUrl != null,
      recurringInvite: firstJob ? { bookUrl: bookUrlFor(origin, locale) } : undefined,
      unsubscribeUrl: unsubscribeUrlFor(origin, token),
    });
    if (sent) {
      summary.sent += 1;
      summary.details.push(`${row.reference}${firstJob ? " (first job — recurring plans unlocked)" : ""}`);
    } else {
      note("send_failed");
    }
  }

  return summary;
}
