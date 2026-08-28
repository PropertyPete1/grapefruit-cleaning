/**
 * The email log exists to answer "did the customer get it?" after the
 * production console logs have rolled off, and to raise the alarm when the
 * answer is no. Four properties matter and are pinned here: every attempt is
 * recorded with its true outcome, a logging failure never propagates into the
 * send path, a failure alerts the owner, and the alert can neither recurse nor
 * flood.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordEmailAttempt = vi.fn();
const mockLastEmailAlertAt = vi.fn();
const mockMarkAlertSent = vi.fn();
const mockMarkAlertSuppressed = vi.fn();
const mockCountSuppressed = vi.fn();
const mockSendOwnerAlert = vi.fn();

vi.mock("./db", () => ({
  recordEmailAttemptReturningId: (...args: unknown[]) => mockRecordEmailAttempt(...args),
  lastEmailAlertAt: (...args: unknown[]) => mockLastEmailAlertAt(...args),
  markEmailAlertSent: (...args: unknown[]) => mockMarkAlertSent(...args),
  markEmailAlertSuppressed: (...args: unknown[]) => mockMarkAlertSuppressed(...args),
  countSuppressedSince: (...args: unknown[]) => mockCountSuppressed(...args),
}));

vi.mock("./emails", () => ({
  sendOwnerAlert: (...args: unknown[]) => mockSendOwnerAlert(...args),
}));

import { ALERT_INTERVAL_MS, buildFailureAlert, logEmailAttempt } from "./emailLog";

beforeEach(() => {
  for (const m of [
    mockRecordEmailAttempt,
    mockLastEmailAlertAt,
    mockMarkAlertSent,
    mockMarkAlertSuppressed,
    mockCountSuppressed,
    mockSendOwnerAlert,
  ]) {
    m.mockReset();
  }
  mockRecordEmailAttempt.mockResolvedValue(101);
  mockLastEmailAlertAt.mockResolvedValue(null);
  mockMarkAlertSent.mockResolvedValue(undefined);
  mockMarkAlertSuppressed.mockResolvedValue(undefined);
  mockCountSuppressed.mockResolvedValue(0);
  mockSendOwnerAlert.mockResolvedValue({
    delivered: true,
    platformDelivered: true,
    emailDelivered: false,
    emailRecipient: null,
  });
});

const attempt = (over: Partial<Parameters<typeof logEmailAttempt>[0]> = {}) => ({
  recipient: "steven@example.com",
  subject: "Your remaining balance",
  emailType: "balance_due",
  outcome: "delivered" as const,
  ...over,
});

describe("logEmailAttempt — recording", () => {
  it("records a delivery with its recipient, type, and sending mailbox", async () => {
    await logEmailAttempt(attempt({ smtpUser: "biz@example.com", invoiceId: 42, bookingId: 7 }));
    expect(mockRecordEmailAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: "steven@example.com",
        emailType: "balance_due",
        outcome: "delivered",
        smtpUser: "biz@example.com",
        invoiceId: 42,
        bookingId: 7,
      })
    );
  });

  it("records a transport failure with the mail server's own words", async () => {
    await logEmailAttempt(attempt({ outcome: "error", errorText: "535 5.7.139 Authentication unsuccessful" }));
    expect(mockRecordEmailAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", errorText: "535 5.7.139 Authentication unsuccessful" })
    );
  });

  it("distinguishes a log-only fallback from a real delivery", async () => {
    await logEmailAttempt(attempt({ outcome: "log_only" }));
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({ outcome: "log_only" });
  });

  it("records a skipped send for a customer with no address", async () => {
    await logEmailAttempt(attempt({ recipient: null, outcome: "skipped" }));
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({ recipient: null, outcome: "skipped" });
  });

  it("truncates an oversized provider dump instead of failing the insert", async () => {
    await logEmailAttempt(attempt({ subject: "x".repeat(900), outcome: "error", errorText: "y".repeat(900) }));
    const row = mockRecordEmailAttempt.mock.calls[0]![0] as { subject: string; errorText: string };
    expect(row.subject).toHaveLength(500);
    expect(row.errorText).toHaveLength(500);
  });

  it("swallows a logging failure — observability must not break the send", async () => {
    mockRecordEmailAttempt.mockRejectedValue(new Error("database is down"));
    await expect(logEmailAttempt(attempt())).resolves.toBeUndefined();
  });

  it("defaults the relations to null rather than omitting them", async () => {
    await logEmailAttempt(attempt());
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({
      invoiceId: null,
      bookingId: null,
      errorText: null,
    });
  });
});

describe("logEmailAttempt — owner alert", () => {
  it("alerts the owner when a send fails", async () => {
    await logEmailAttempt(attempt({ outcome: "error", errorText: "535 auth failed" }));
    expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
    const [title, content] = mockSendOwnerAlert.mock.calls[0]!;
    expect(title).toContain("ACTION NEEDED");
    expect(content).toContain("535 auth failed");
  });

  it("alerts when no mailbox is configured and the message was only logged", async () => {
    await logEmailAttempt(attempt({ outcome: "log_only" }));
    expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOwnerAlert.mock.calls[0]![0]).toContain("no mailbox configured");
  });

  it("stays quiet for a successful send", async () => {
    await logEmailAttempt(attempt({ outcome: "delivered" }));
    expect(mockSendOwnerAlert).not.toHaveBeenCalled();
  });

  it("stays quiet when there was simply no address on file", async () => {
    // Not a fault: a phone-only lead has nothing to send to, and alerting on
    // it would cry wolf on every ordinary admin-entered booking.
    await logEmailAttempt(attempt({ recipient: null, outcome: "skipped" }));
    expect(mockSendOwnerAlert).not.toHaveBeenCalled();
  });

  it("marks the log row as the one that raised the alert", async () => {
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockMarkAlertSent).toHaveBeenCalledWith(101, expect.any(Date));
  });

  it("does not mark alertSentAt when every owner channel rejects the alert", async () => {
    mockSendOwnerAlert.mockResolvedValue({
      delivered: false,
      platformDelivered: false,
      emailDelivered: false,
      emailRecipient: "owner@example.com",
    });
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockMarkAlertSent).not.toHaveBeenCalled();
  });

  it("never alerts about a failed owner alert — that is the loop", async () => {
    await logEmailAttempt(attempt({ emailType: "owner_alert", outcome: "error" }));
    expect(mockSendOwnerAlert).not.toHaveBeenCalled();
  });

  it("never alerts about a failed failure-alert either", async () => {
    await logEmailAttempt(attempt({ emailType: "email_failure_alert", outcome: "error" }));
    expect(mockSendOwnerAlert).not.toHaveBeenCalled();
  });

  it("does not re-enter when the alert's own send logs a failure", async () => {
    // The realistic loop: the alert goes out through deliverEmail, which logs
    // its attempt, which lands back in this module. One alert, not two.
    mockSendOwnerAlert.mockImplementation(async () => {
      await logEmailAttempt(attempt({ emailType: "some_other_type", outcome: "error" }));
      return {
        delivered: false,
        platformDelivered: false,
        emailDelivered: false,
        emailRecipient: null,
      };
    });
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second alert inside the quiet hour", async () => {
    mockLastEmailAlertAt.mockResolvedValue(new Date(Date.now() - 60_000));
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockSendOwnerAlert).not.toHaveBeenCalled();
    expect(mockMarkAlertSuppressed).toHaveBeenCalledWith(101);
  });

  it("alerts again once the quiet hour has passed", async () => {
    mockLastEmailAlertAt.mockResolvedValue(new Date(Date.now() - ALERT_INTERVAL_MS - 1_000));
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
  });

  it("reports how many failures the cap swallowed since the last alert", async () => {
    mockLastEmailAlertAt.mockResolvedValue(new Date(Date.now() - ALERT_INTERVAL_MS - 1_000));
    mockCountSuppressed.mockResolvedValue(12);
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockSendOwnerAlert.mock.calls[0]![1]).toContain("12 further emails failed");
  });

  it("still records the attempt when the alert itself throws", async () => {
    mockSendOwnerAlert.mockRejectedValue(new Error("smtp down"));
    await expect(logEmailAttempt(attempt({ outcome: "error" }))).resolves.toBeUndefined();
    expect(mockRecordEmailAttempt).toHaveBeenCalled();
  });

  it("releases the re-entrancy latch after a throwing alert", async () => {
    // A latch left stuck would silence every future alert — worse than the
    // flood it guards against, because it fails closed and invisibly.
    mockSendOwnerAlert.mockRejectedValueOnce(new Error("smtp down"));
    await logEmailAttempt(attempt({ outcome: "error" }));
    mockSendOwnerAlert.mockResolvedValue({
      delivered: true,
      platformDelivered: true,
      emailDelivered: false,
      emailRecipient: null,
    });
    await logEmailAttempt(attempt({ outcome: "error" }));
    expect(mockSendOwnerAlert).toHaveBeenCalledTimes(2);
  });
});

describe("buildFailureAlert", () => {
  it("leads with the customer impact, not the stack trace", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error" }), 0);
    expect(content).toContain("The customer received nothing");
  });

  it("names the recipient and subject so the owner can follow up by hand", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error" }), 0);
    expect(content).toContain("steven@example.com");
    expect(content).toContain("Your remaining balance");
  });

  it("includes the invoice and booking when the send belonged to one", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error", invoiceId: 42, bookingId: 7 }), 0);
    expect(content).toContain("Invoice: #42");
    expect(content).toContain("Booking: #7");
  });

  it("omits the suppression line when nothing was suppressed", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error" }), 0);
    expect(content).not.toContain("further email");
  });

  it("uses the singular for exactly one suppressed failure", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error" }), 1);
    expect(content).toContain("1 further email failed");
  });

  it("says plainly that alerts are capped, so silence is not read as health", () => {
    const [, content] = buildFailureAlert(attempt({ outcome: "error" }), 0);
    expect(content).toContain("one per hour");
  });

  it("handles a missing address without printing null", () => {
    const [, content] = buildFailureAlert(attempt({ recipient: null, outcome: "error" }), 0);
    expect(content).toContain("(no address)");
    expect(content).not.toContain("null");
  });
});
