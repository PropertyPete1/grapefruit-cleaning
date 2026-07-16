/**
 * Heartbeat cron callback: sends due booking reminder emails.
 * Trigger: platform-managed cron POSTs to /api/scheduled/sendReminders daily.
 * Auth: sdk.authenticateRequest → user.isCron must be true.
 * Idempotent: reminders are tracked per booking (weekReminderSentAt / dayReminderSentAt).
 */
import type { Express, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { sendDueReminders } from "./reminders";

async function sendRemindersHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      return res.status(403).json({ error: "cron-only endpoint" });
    }
    const summary = await sendDueReminders();
    console.log(
      `[Reminders] Scanned ${summary.scanned} upcoming bookings, sent ${summary.sent} reminder(s).`,
      summary.details.join(" | ") || "none due"
    );
    return res.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[Reminders] Handler error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

export function registerScheduledRoutes(app: Express): void {
  app.post("/api/scheduled/sendReminders", sendRemindersHandler);
}
