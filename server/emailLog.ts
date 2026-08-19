/**
 * Durable record of every outbound email attempt.
 *
 * Why this sits in its own module rather than calling db.ts straight from
 * emails.ts: thirty test files mock "./db" with an explicit object literal, so
 * importing db.ts into the email path makes every one of them fail on a
 * missing export — and would make every FUTURE email-adjacent test fail the
 * same way. That is a real design signal, not just a test annoyance: logging
 * is a side channel, and the send path should not gain a hard dependency on
 * the database module.
 *
 * The import is therefore dynamic and every failure is swallowed. An
 * observability write must never be able to break the delivery it observes:
 * an email that goes out unrecorded is a bad day, an email that fails BECAUSE
 * the log insert failed is a worse one.
 *
 * This module also raises the owner alert when a send fails. Two hazards make
 * that less trivial than it sounds, and both are handled below: the alert
 * itself travels by email (so it must never be able to trigger itself), and a
 * broken mailbox fails every send (so the alert is capped at one per hour,
 * with the swallowed failures still counted in the log).
 */

/** Minimum gap between two owner alerts about email failure. */
export const ALERT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Email types that must never raise an alert about themselves.
 *
 * `owner_alert` is the alert path itself: alerting about a failed alert is a
 * loop that ends in a full mailbox or a wedged process. `email_failure_alert`
 * is this feature's own message. When one of these fails, the failure is
 * logged and the console keeps the detail — which is the right place for it,
 * because if owner mail is failing there is no working channel to tell anyone
 * about it anyway.
 */
const NEVER_ALERT_ON = new Set(["owner_alert", "email_failure_alert"]);

export interface EmailAttempt {
  recipient: string | null;
  subject: string;
  emailType: string;
  outcome: "delivered" | "log_only" | "error" | "skipped";
  errorText?: string | null;
  smtpUser?: string | null;
  invoiceId?: number | null;
  bookingId?: number | null;
}

/**
 * Re-entrancy latch.
 *
 * The alert is sent through the ordinary email path, which logs its own
 * attempt, which lands back here. The type check above already stops the
 * common case, but this closes the window regardless of how the alert is
 * labelled — including a future caller that forgets to label it. Synchronous
 * set/clear around the send, so it cannot be interleaved.
 */
let _alerting = false;

export async function logEmailAttempt(attempt: EmailAttempt): Promise<void> {
  const failed = attempt.outcome === "error" || attempt.outcome === "log_only";
  try {
    const db = await import("./db");
    const id = await db.recordEmailAttemptReturningId({
      recipient: attempt.recipient,
      subject: attempt.subject.slice(0, 500),
      emailType: attempt.emailType.slice(0, 60),
      outcome: attempt.outcome,
      // varchar(500): a multi-line provider dump would otherwise fail the
      // insert and lose the very record that explains the failure.
      errorText: attempt.errorText ? attempt.errorText.slice(0, 500) : null,
      smtpUser: attempt.smtpUser ?? null,
      invoiceId: attempt.invoiceId ?? null,
      bookingId: attempt.bookingId ?? null,
    });
    if (failed) await maybeAlertOwner(attempt, id);
  } catch (error) {
    console.warn("[EmailLog] Could not record send attempt:", error);
  }
}

/**
 * Raises the owner alert for a failed send, unless something says not to.
 *
 * Order of the guards matters: recursion first (cheapest, and the only one
 * whose failure mode is unbounded), then the hourly cap.
 */
async function maybeAlertOwner(attempt: EmailAttempt, logId: number | null): Promise<void> {
  if (_alerting) return;
  if (NEVER_ALERT_ON.has(attempt.emailType)) return;

  const db = await import("./db");
  const now = new Date();
  const last = await db.lastEmailAlertAt();
  if (last && now.getTime() - last.getTime() < ALERT_INTERVAL_MS) {
    // Inside the quiet hour: record that this failure went unannounced, so the
    // next alert can say how many there were rather than implying it was one.
    if (logId !== null) await db.markEmailAlertSuppressed(logId);
    console.warn(`[EmailLog] Failure alert suppressed (within ${ALERT_INTERVAL_MS / 60000}m of the last one)`);
    return;
  }

  const suppressed = last ? await db.countSuppressedSince(last) : 0;
  _alerting = true;
  try {
    const { sendOwnerAlert } = await import("./emails");
    await sendOwnerAlert(...buildFailureAlert(attempt, suppressed, now));
    if (logId !== null) await db.markEmailAlertSent(logId, now);
  } catch (error) {
    console.error("[EmailLog] Could not raise the failure alert:", error);
  } finally {
    _alerting = false;
  }
}

/**
 * The alert's wording. Separated from the sending so it can be asserted
 * directly, and so the "and N more" line is provably tied to the count.
 */
export function buildFailureAlert(
  attempt: EmailAttempt,
  suppressedSinceLastAlert: number,
  now: Date = new Date()
): [title: string, content: string] {
  const logOnly = attempt.outcome === "log_only";
  const title = logOnly
    ? "[ACTION NEEDED] An email was not sent — no mailbox configured"
    : "[ACTION NEEDED] An email failed to send";
  const lines = [
    logOnly
      ? "The site tried to send an email but no SMTP credentials are configured, so the message was only written to the server log. The customer received nothing."
      : "The site tried to send an email and the mail server rejected it. The customer received nothing.",
    "",
    `To: ${attempt.recipient ?? "(no address)"}`,
    `Subject: ${attempt.subject}`,
    `Type: ${attempt.emailType}`,
    `When: ${now.toISOString()}`,
  ];
  if (attempt.errorText) lines.push("", `The mail server said: ${attempt.errorText}`);
  if (attempt.invoiceId != null) lines.push(`Invoice: #${attempt.invoiceId}`);
  if (attempt.bookingId != null) lines.push(`Booking: #${attempt.bookingId}`);
  if (suppressedSinceLastAlert > 0) {
    lines.push(
      "",
      `${suppressedSinceLastAlert} further email${suppressedSinceLastAlert === 1 ? "" : "s"} failed since the last alert and were not announced individually.`
    );
  }
  lines.push(
    "",
    "Full history is in Admin → Email log.",
    "Alerts are limited to one per hour, so this may represent more than one failure."
  );
  return [title, lines.join("\n")];
}
