/**
 * The email log exists to answer "did the customer actually get it?" after the
 * production console logs have rolled off. Two properties matter and are
 * pinned here: every attempt is recorded with its true outcome, and a logging
 * failure never propagates into the send path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordEmailAttempt = vi.fn();

vi.mock("./db", () => ({
  recordEmailAttempt: (...args: unknown[]) => mockRecordEmailAttempt(...args),
}));

import { logEmailAttempt } from "./emailLog";

beforeEach(() => {
  mockRecordEmailAttempt.mockReset();
  mockRecordEmailAttempt.mockResolvedValue(undefined);
});

describe("logEmailAttempt", () => {
  it("records a delivery with its recipient, type, and sending mailbox", async () => {
    await logEmailAttempt({
      recipient: "steven@example.com",
      subject: "Your remaining balance",
      emailType: "balance_due",
      outcome: "delivered",
      smtpUser: "biz@example.com",
      invoiceId: 42,
      bookingId: 7,
    });
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
    await logEmailAttempt({
      recipient: "steven@example.com",
      subject: "Your remaining balance",
      emailType: "balance_due",
      outcome: "error",
      errorText: "535 5.7.139 Authentication unsuccessful",
    });
    expect(mockRecordEmailAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorText: "535 5.7.139 Authentication unsuccessful",
      })
    );
  });

  it("distinguishes a log-only fallback from a real delivery", async () => {
    await logEmailAttempt({
      recipient: "steven@example.com",
      subject: "Booking confirmed",
      emailType: "booking_confirmation",
      outcome: "log_only",
    });
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({ outcome: "log_only" });
  });

  it("records a skipped send for a customer with no address", async () => {
    await logEmailAttempt({
      recipient: null,
      subject: "Booking confirmed",
      emailType: "booking_confirmation",
      outcome: "skipped",
    });
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({ recipient: null, outcome: "skipped" });
  });

  it("truncates an oversized provider dump instead of failing the insert", async () => {
    await logEmailAttempt({
      recipient: "steven@example.com",
      subject: "x".repeat(900),
      emailType: "balance_due",
      outcome: "error",
      errorText: "y".repeat(900),
    });
    const row = mockRecordEmailAttempt.mock.calls[0]![0] as { subject: string; errorText: string };
    expect(row.subject).toHaveLength(500);
    expect(row.errorText).toHaveLength(500);
  });

  it("swallows a logging failure — observability must not break the send", async () => {
    mockRecordEmailAttempt.mockRejectedValue(new Error("database is down"));
    await expect(
      logEmailAttempt({
        recipient: "steven@example.com",
        subject: "Your remaining balance",
        emailType: "balance_due",
        outcome: "delivered",
      })
    ).resolves.toBeUndefined();
  });

  it("defaults the relations to null rather than omitting them", async () => {
    await logEmailAttempt({
      recipient: "a@b.com",
      subject: "Hello",
      emailType: "other",
      outcome: "delivered",
    });
    expect(mockRecordEmailAttempt.mock.calls[0]![0]).toMatchObject({
      invoiceId: null,
      bookingId: null,
      errorText: null,
    });
  });
});
