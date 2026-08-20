/**
 * Re-booking nudges: inviting past customers back, on the daily cron.
 *
 * This is the only marketing the system sends, and it is built to be
 * conservative by construction — the eligibility rules live in
 * shared/marketingRules.ts as pure functions, every skip is logged with its
 * reason, and an unsubscribe is permanent. The sweep sends at most one email
 * per customer per run and stamps the clock before it sends, so a crash
 * mid-run can lose a nudge but can never repeat one.
 */
import { randomBytes } from "node:crypto";
import {
  MARKETING_COOLDOWN_DAYS,
  nudgeDecision,
  type NudgeCandidate,
  type NudgeSkipReason,
} from "@shared/marketingRules";
import * as db from "./db";
import { sendRebookingNudgeEmail } from "./emails";

/** The booking page, in the customer's language. */
export function bookUrlFor(origin: string, locale: "en" | "es"): string {
  return `${origin}/${locale}/${locale === "es" ? "reservar" : "book"}`;
}

/** The one-click unsubscribe URL carried by every nudge. */
export function unsubscribeUrlFor(origin: string, token: string): string {
  return `${origin}/unsubscribe/${token}`;
}

/** Whole months between two dates, for the copy. */
function monthsSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / (30 * 24 * 60 * 60 * 1000)));
}

export interface NudgeSweepSummary {
  scanned: number;
  sent: number;
  skipped: Record<string, number>;
  details: string[];
}

/**
 * Sends every nudge that is due.
 *
 * Without a public origin nothing is sent at all: a marketing email whose
 * booking link and — more importantly — whose unsubscribe link are relative is
 * worse than no email, because the recipient cannot act on either.
 */
export async function sendDueRebookingNudges(origin: string): Promise<NudgeSweepSummary> {
  const summary: NudgeSweepSummary = { scanned: 0, sent: 0, skipped: {}, details: [] };
  if (!origin) {
    summary.details.push("no public origin configured — nothing sent");
    return summary;
  }

  const note = (reason: NudgeSkipReason | string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  const rows = await db.listNudgeCandidates();
  summary.scanned = rows.length;
  const now = new Date();
  const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;

  for (const row of rows) {
    const candidate: NudgeCandidate = {
      customerId: row.customerId,
      email: row.email,
      lastCompletedAt: row.lastCompletedDate ? new Date(`${row.lastCompletedDate}T12:00:00Z`) : null,
      hasUpcomingBooking: Number(row.upcomingCount) > 0,
      hasOpenInvoice: Number(row.openInvoiceCount) > 0,
      marketingUnsubscribedAt: row.marketingUnsubscribedAt ? new Date(row.marketingUnsubscribedAt) : null,
      lastMarketingEmailAt: row.lastMarketingEmailAt ? new Date(row.lastMarketingEmailAt) : null,
      marketingEmailCount: Number(row.marketingEmailCount),
    };

    const decision = nudgeDecision(candidate, now);
    if (!decision.send) {
      note(decision.reason);
      continue;
    }

    // Minted once and kept forever: an unsubscribe link in a two-year-old email
    // must still work, so the token is never rotated.
    const token = row.marketingToken ?? randomBytes(24).toString("hex");
    const locale = (row.preferredLocale as "en" | "es") ?? "en";

    // Stamp BEFORE sending. If the send throws or the process dies, the worst
    // outcome is one nudge never sent — strictly better than a customer
    // receiving the same marketing twice because the record never landed.
    await db.recordMarketingEmailSent(row.customerId, token, now);

    const sent = await sendRebookingNudgeEmail(
      {
        customerName: row.firstName,
        customerEmail: row.email!,
        lastServiceDate: row.lastCompletedDate ?? "",
        monthsSince: candidate.lastCompletedAt ? monthsSince(candidate.lastCompletedAt, now) : 0,
        bookUrl: bookUrlFor(origin, locale),
        unsubscribeUrl: unsubscribeUrlFor(origin, token),
        locale,
        bizPhone,
      },
      decision.nudgeNumber
    );

    if (sent) {
      summary.sent += 1;
      summary.details.push(`#${row.customerId} nudge ${decision.nudgeNumber}`);
    } else {
      note("send_failed");
    }
  }

  return summary;
}

export const MARKETING_MIN_GAP_DAYS = MARKETING_COOLDOWN_DAYS;
