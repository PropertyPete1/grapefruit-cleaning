/**
 * Heartbeat cron callback: sends due booking reminder emails.
 * Trigger: platform-managed cron POSTs to /api/scheduled/sendReminders daily.
 * Auth: sdk.authenticateRequest → user.isCron must be true.
 * Idempotent: reminders are tracked per booking (weekReminderSentAt / dayReminderSentAt).
 */
import type { Express, Request, Response } from "express";
import { sendDueBalanceReminders } from "./balance";
import { sdk } from "./_core/sdk";
import { syncAllProperties } from "./icalSync";
import { publicOrigin } from "./publicOrigin";
import { sendDueReminders } from "./reminders";

async function sendRemindersHandler(req: Request, res: Response) {
  // Authenticate first, and on its own: a bad/absent session makes
  // authenticateRequest throw, which is a 403 for this endpoint — not a server
  // error, and not something to report back in detail to an anonymous caller.
  let isCron = false;
  try {
    isCron = (await sdk.authenticateRequest(req)).isCron === true;
  } catch {
    isCron = false;
  }
  if (!isCron) {
    return res.status(403).json({ error: "cron-only endpoint" });
  }

  try {
    const summary = await sendDueReminders();
    console.log(
      `[Reminders] Scanned ${summary.scanned} upcoming bookings, sent ${summary.sent} reminder(s).`,
      summary.details.join(" | ") || "none due"
    );
    // Same daily beat chases unpaid balance links: reminders at 3 and 7 days,
    // then one owner alert. PUBLIC_BASE_URL (via publicOrigin) is what keeps
    // the emailed pay links on the public domain — the cron's own request
    // arrives on the internal hostname.
    const balances = await sendDueBalanceReminders(publicOrigin(req));
    console.log(
      `[BalanceReminders] Scanned ${balances.scanned} open balance link(s), sent ${balances.reminded}, alerted owner on ${balances.alerted}.`,
      balances.details.join(" | ") || "none due"
    );
    return res.json({ ok: true, ...summary, balanceReminders: balances });
  } catch (error) {
    // Stack traces stay in the server log; the response carries only the
    // message, so the endpoint can't be used to map the filesystem.
    console.error("[Reminders] Handler error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Hourly cron: poll every active property's Airbnb/VRBO feed and reconcile
 * bookings. Same auth posture as the reminders endpoint; idempotent by
 * reservation UID, so an extra or repeated firing changes nothing.
 */
async function icalSyncHandler(req: Request, res: Response) {
  let isCron = false;
  try {
    isCron = (await sdk.authenticateRequest(req)).isCron === true;
  } catch {
    isCron = false;
  }
  if (!isCron) {
    return res.status(403).json({ error: "cron-only endpoint" });
  }
  try {
    const summaries = await syncAllProperties();
    const line = summaries
      .map(s => `#${s.propertyId}:${s.ok ? "ok" : "FAIL"} +${s.created} →${s.moved} ✕${s.cancelled}${s.unplaced ? ` ?${s.unplaced}` : ""}`)
      .join(" | ");
    console.log(`[iCalSync] ${summaries.length} propert${summaries.length === 1 ? "y" : "ies"}: ${line || "none active"}`);
    return res.json({ ok: true, summaries });
  } catch (error) {
    console.error("[iCalSync] Handler error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export function registerScheduledRoutes(app: Express): void {
  app.post("/api/scheduled/sendReminders", sendRemindersHandler);
  app.post("/api/scheduled/icalSync", icalSyncHandler);
}
