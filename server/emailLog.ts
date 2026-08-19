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
 */

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

export async function logEmailAttempt(attempt: EmailAttempt): Promise<void> {
  try {
    const { recordEmailAttempt } = await import("./db");
    await recordEmailAttempt({
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
  } catch (error) {
    console.warn("[EmailLog] Could not record send attempt:", error);
  }
}
