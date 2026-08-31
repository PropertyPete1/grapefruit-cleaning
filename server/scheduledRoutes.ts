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
import { sendDueRebookingNudges } from "./marketing";
import { healthProblemCount, runDailyHealthCheck, sendWeeklyDigest } from "./ownerDigest";
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
    // Marketing rides the same daily beat and runs LAST on purpose: a
    // transactional reminder must never be delayed or dropped because a
    // promotional sweep ahead of it was slow or threw. Its own failure is
    // caught here for the same reason — no nudge is worth a 500 on the cron.
    let nudges;
    try {
      nudges = await sendDueRebookingNudges(publicOrigin(req));
      console.log(
        `[Marketing] Scanned ${nudges.scanned} customer(s), sent ${nudges.sent} nudge(s).`,
        Object.entries(nudges.skipped)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(" ") || "no skips"
      );
    } catch (error) {
      console.error("[Marketing] Nudge sweep failed:", error);
    }

    // The system reporting on itself. Runs after all the sending work so the
    // digest describes a settled state, and inside its own try/catch for the
    // same reason marketing is: a reporting failure must never turn the
    // reminders cron into a 500 and cost a customer their reminder tomorrow.
    let health;
    let digestSent = false;
    try {
      health = await runDailyHealthCheck();
      const problems = healthProblemCount(health);
      console.log(
        `[HealthCheck] ${problems} problem(s); ${health.customersWithoutEmail.length} customer(s) without email.`
      );

      // Monday, in the owner's timezone rather than UTC — the cron fires at
      // 14:00 UTC, which is still Sunday evening nowhere in Texas, but reading
      // the day in America/Chicago keeps "Monday" meaning Monday to him even
      // if the schedule is moved earlier later on.
      const localDay = new Date().toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        weekday: "short",
      });
      if (localDay === "Mon") {
        await sendWeeklyDigest();
        digestSent = true;
        console.log("[Digest] Weekly owner report sent.");
      }
    } catch (error) {
      console.error("[Digest] Reporting failed:", error);
    }

    return res.json({ ok: true, ...summary, balanceReminders: balances, nudges, health, digestSent });
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

/**
 * Sends the weekly owner report on demand.
 *
 * The digest normally rides the daily reminders beat and only fires on a
 * Monday. This endpoint exists so the report can be produced deliberately —
 * after a deploy, or whenever the owner wants the current picture — without
 * waiting for the calendar or hand-running the whole reminders sweep, which
 * would also send real customer email as a side effect.
 */
async function weeklyDigestHandler(req: Request, res: Response) {
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
    const data = await sendWeeklyDigest();
    console.log(
      `[Digest] Sent on demand: ${data.totalSent} email(s) this week, ${data.failures.length} failure(s), ` +
        `${data.nudges.length} nudge(s) due, ${healthProblemCount(data.health)} problem(s).`
    );
    return res.json({
      ok: true,
      emailsThisWeek: data.totalSent,
      failures: data.failures.length,
      quietFailures: data.quietFailures,
      upcomingNudges: data.nudges.length,
      problems: healthProblemCount(data.health),
      totals: data.totals,
    });
  } catch (error) {
    console.error("[Digest] Handler error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export function registerScheduledRoutes(app: Express): void {
  app.post("/api/scheduled/sendReminders", sendRemindersHandler);
  app.post("/api/scheduled/icalSync", icalSyncHandler);
  app.post("/api/scheduled/weeklyDigest", weeklyDigestHandler);
}
