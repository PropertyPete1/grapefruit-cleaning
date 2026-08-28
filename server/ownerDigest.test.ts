/**
 * The system reporting on itself.
 *
 * What this file pins:
 *   - the daily check alerts ONLY when something needs a human, and stays
 *     silent otherwise (an alert every day is an alert nobody reads);
 *   - customers without an email are reported but never raise an alert — a
 *     phone lead is a customer, not a fault;
 *   - the Daniel shape (paid invoice, unfinished booking) is caught;
 *   - upcoming nudges are projected by replaying the REAL cadence rules, so
 *     the digest can't promise a nudge the sweep won't send;
 *   - failures the hourly cap swallowed are surfaced in the digest, since
 *     those are precisely the ones the owner has never seen;
 *   - the digest reads correctly when everything is quiet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPaidOnOpen = vi.fn();
const mockDeadLinks = vi.fn();
const mockNoEmail = vi.fn();
const mockStats = vi.fn();
const mockFailures = vi.fn();
const mockTotals = vi.fn();
const mockCandidates = vi.fn();
const mockOwnerAlert = vi.fn();
const mockGetSetting = vi.fn();
const mockSmtpUser = vi.fn();

vi.mock("./db", () => ({
  findPaidInvoicesOnOpenBookings: () => mockPaidOnOpen(),
  findInvoicesWithDeadLinks: (...a: unknown[]) => mockDeadLinks(...a),
  findCustomersWithoutEmail: () => mockNoEmail(),
  emailStatsSince: (...a: unknown[]) => mockStats(...a),
  emailFailuresSince: (...a: unknown[]) => mockFailures(...a),
  ownerTotals: () => mockTotals(),
  listNudgeCandidates: () => mockCandidates(),
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
}));

vi.mock("./emails", () => ({
  sendOwnerAlert: (...a: unknown[]) => mockOwnerAlert(...a),
  smtpUser: () => mockSmtpUser(),
}));

import {
  collectDigest,
  formatDigest,
  formatHealthFindings,
  runDailyHealthCheck,
  runHealthCheck,
  upcomingNudges,
} from "./ownerDigest";

const NOW = new Date("2026-08-24T14:00:00Z"); // a Monday

beforeEach(() => {
  vi.clearAllMocks();
  mockPaidOnOpen.mockResolvedValue([]);
  mockDeadLinks.mockResolvedValue([]);
  mockNoEmail.mockResolvedValue([]);
  mockStats.mockResolvedValue([]);
  mockFailures.mockResolvedValue([]);
  mockCandidates.mockResolvedValue([]);
  mockGetSetting.mockResolvedValue("grapefruitcleaningc@gmail.com");
  mockSmtpUser.mockReturnValue("grapefruitcleaningc@gmail.com");
  mockTotals.mockResolvedValue({
    bookings: 5,
    upcomingBookings: 1,
    unpaidInvoices: 2,
    unpaidTotal: 250,
    customers: 4,
  });
});

// ---------------------------------------------------------------------------

describe("the daily health check", () => {
  it("stays silent when nothing is wrong", async () => {
    const findings = await runDailyHealthCheck(NOW);
    expect(findings.hasProblems).toBe(false);
    expect(mockOwnerAlert).not.toHaveBeenCalled();
  });

  it("catches the Daniel shape: money taken on a job still marked open", async () => {
    mockPaidOnOpen.mockResolvedValue([
      { invoiceNumber: "INV-MT0LDYJ6-7D0D", reference: "GFC-WH33YS", bookingStatus: "confirmed", amount: 170 },
    ]);
    const findings = await runDailyHealthCheck(NOW);
    expect(findings.hasProblems).toBe(true);
    expect(mockOwnerAlert).toHaveBeenCalledOnce();
    const [subject, body] = mockOwnerAlert.mock.calls[0]!;
    expect(subject).toContain("1 item needs your attention");
    expect(body).toContain("INV-MT0LDYJ6-7D0D");
    expect(body).toContain("GFC-WH33YS");
    expect(body).toContain("confirmed");
  });

  it("flags an unpaid invoice whose payment link has died", async () => {
    mockDeadLinks.mockResolvedValue([
      { invoiceNumber: "INV-DEAD-0001", amount: 90, linkExpiresAt: new Date("2026-08-01T00:00:00Z") },
    ]);
    const findings = await runDailyHealthCheck(NOW);
    expect(findings.hasProblems).toBe(true);
    expect(mockOwnerAlert.mock.calls[0]![1]).toContain("INV-DEAD-0001");
    expect(mockOwnerAlert.mock.calls[0]![1]).toContain("2026-08-01");
  });

  it("reports customers with no email but does NOT alert about them", async () => {
    mockNoEmail.mockResolvedValue([{ firstName: "Rosa", lastName: "Diaz", phone: "210-555-0100" }]);
    const findings = await runDailyHealthCheck(NOW);
    expect(findings.customersWithoutEmail).toHaveLength(1);
    expect(findings.hasProblems).toBe(false);
    expect(mockOwnerAlert).not.toHaveBeenCalled();
  });

  it("counts multiple problems in the subject line", async () => {
    mockPaidOnOpen.mockResolvedValue([
      { invoiceNumber: "A", reference: "R1", bookingStatus: "confirmed", amount: 10 },
    ]);
    mockDeadLinks.mockResolvedValue([{ invoiceNumber: "B", amount: 20, linkExpiresAt: new Date() }]);
    await runDailyHealthCheck(NOW);
    expect(mockOwnerAlert.mock.calls[0]![0]).toContain("2 items need your attention");
  });

  it("alerts when the resolved SMTP sender diverges from the live business email", async () => {
    mockSmtpUser.mockReturnValue("grapefruit@grapefruitclean.com");
    const findings = await runDailyHealthCheck(NOW);
    expect(findings.smtpIdentity).toEqual({
      expected: "grapefruitcleaningc@gmail.com",
      effective: "grapefruit@grapefruitclean.com",
      matches: false,
    });
    expect(findings.hasProblems).toBe(true);
    expect(mockOwnerAlert).toHaveBeenCalledOnce();
    const [subject, body] = mockOwnerAlert.mock.calls[0]!;
    expect(subject).toContain("1 item needs your attention");
    expect(body).toContain("SMTP SENDER IDENTITY MISMATCH");
    expect(body).toContain("Public business email: grapefruitcleaningc@gmail.com");
    expect(body).toContain("Resolved SMTP sender: grapefruit@grapefruitclean.com");
  });

  it("compares SMTP and business email case-insensitively", async () => {
    mockGetSetting.mockResolvedValue("Grapefruitcleaningc@gmail.com");
    mockSmtpUser.mockReturnValue("grapefruitcleaningc@GMAIL.COM");
    const findings = await runHealthCheck(NOW);
    expect(findings.smtpIdentity.matches).toBe(true);
    expect(findings.hasProblems).toBe(false);
  });

  it("says so plainly when there is nothing to report", async () => {
    const findings = await runHealthCheck(NOW);
    expect(formatHealthFindings(findings)).toBe("No inconsistencies found.");
  });
});

// ---------------------------------------------------------------------------

describe("projecting upcoming nudges", () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    customerId: 1,
    firstName: "Daniel",
    email: "daniel@example.com",
    preferredLocale: "en",
    marketingUnsubscribedAt: null,
    marketingToken: null,
    lastMarketingEmailAt: null,
    marketingEmailCount: 0,
    lastCompletedDate: "2026-08-19",
    upcomingCount: 0,
    openInvoiceCount: 0,
    ...over,
  });

  it("names who is due and when, within the window", async () => {
    // 2026-08-19 + 24 days = 2026-09-12. From a Sept 8 vantage that is 4 days out.
    mockCandidates.mockResolvedValue([candidate()]);
    const due = await upcomingNudges(7, new Date("2026-09-08T14:00:00Z"));
    expect(due).toEqual([
      { name: "Daniel", email: "daniel@example.com", dueOn: "2026-09-12", nudgeNumber: 1 },
    ]);
  });

  it("omits anyone whose date falls outside the window", async () => {
    mockCandidates.mockResolvedValue([candidate()]);
    expect(await upcomingNudges(7, new Date("2026-08-20T14:00:00Z"))).toEqual([]);
  });

  it("never promises a nudge to someone who owes money or is already booked", async () => {
    mockCandidates.mockResolvedValue([
      candidate({ customerId: 2, openInvoiceCount: 1 }),
      candidate({ customerId: 3, upcomingCount: 1 }),
      candidate({ customerId: 4, marketingUnsubscribedAt: new Date("2026-01-01") }),
    ]);
    expect(await upcomingNudges(7, new Date("2026-09-08T14:00:00Z"))).toEqual([]);
  });

  it("sorts by date so the soonest is first", async () => {
    mockCandidates.mockResolvedValue([
      candidate({ customerId: 1, firstName: "Later", lastCompletedDate: "2026-08-22" }),
      candidate({ customerId: 2, firstName: "Sooner", lastCompletedDate: "2026-08-16" }),
    ]);
    const due = await upcomingNudges(14, new Date("2026-09-08T14:00:00Z"));
    expect(due.map(d => d.name)).toEqual(["Sooner", "Later"]);
  });
});

// ---------------------------------------------------------------------------

describe("the weekly digest", () => {
  it("summarises a quiet week without alarming language", async () => {
    const { subject, body } = formatDigest(await collectDigest(NOW));
    expect(subject).toBe("Grapefruit weekly report: 2026-08-24");
    expect(subject).not.toContain("needs a look");
    expect(body).toContain("Nothing sent this week.");
    expect(body).toContain("None. Every email this week was accepted");
    expect(body).toContain("Nobody is due.");
    expect(body).toContain("No inconsistencies found.");
  });

  it("reports the books", async () => {
    const { body } = formatDigest(await collectDigest(NOW));
    expect(body).toContain("Bookings all time:      5");
    expect(body).toContain("Unpaid invoices:        2 totalling $250");
    expect(body).toContain("Customers:              4");
  });

  it("breaks email volume down by type with failures called out", async () => {
    mockStats.mockResolvedValue([
      { emailType: "balance_due", outcome: "delivered", count: 3 },
      { emailType: "balance_due", outcome: "error", count: 1 },
      { emailType: "marketing", outcome: "delivered", count: 5 },
    ]);
    const { body } = formatDigest(await collectDigest(NOW));
    expect(body).toContain("EMAIL THIS WEEK (9 total)");
    expect(body).toMatch(/balance_due\s+3 delivered, 1 FAILED/);
    expect(body).toMatch(/marketing\s+5 delivered/);
  });

  it("surfaces the failures the hourly cap swallowed — the ones never seen", async () => {
    mockFailures.mockResolvedValue([
      {
        createdAt: new Date("2026-08-22T10:00:00Z"),
        recipient: "someone@example.com",
        subject: "Your balance",
        emailType: "balance_due",
        outcome: "error",
        errorText: "535 5.7.8 Username and Password not accepted",
        alertSuppressed: true,
        alertSentAt: null,
      },
    ]);
    const data = await collectDigest(NOW);
    expect(data.quietFailures).toBe(1);
    const { subject, body } = formatDigest(data);
    expect(subject).toContain("needs a look");
    expect(body).toContain("1 of these never raised an alert at the time");
    expect(body).toContain("535 5.7.8 Username and Password not accepted");
    expect(body).toContain("[no alert sent at the time]");
  });

  it("does not count an alerted failure as a quiet one", async () => {
    mockFailures.mockResolvedValue([
      {
        createdAt: new Date("2026-08-22T10:00:00Z"),
        recipient: "someone@example.com",
        subject: "Your balance",
        emailType: "balance_due",
        outcome: "error",
        errorText: "connection refused",
        alertSuppressed: false,
        alertSentAt: new Date("2026-08-22T10:00:05Z"),
      },
    ]);
    const data = await collectDigest(NOW);
    expect(data.quietFailures).toBe(0);
    expect(formatDigest(data).body).not.toContain("[no alert sent at the time]");
  });

  it("explains a log-only send in words rather than leaving it blank", async () => {
    mockFailures.mockResolvedValue([
      {
        createdAt: new Date("2026-08-22T10:00:00Z"),
        recipient: "x@example.com",
        subject: "s",
        emailType: "reminder",
        outcome: "log_only",
        errorText: null,
        alertSuppressed: false,
        alertSentAt: null,
      },
    ]);
    expect(formatDigest(await collectDigest(NOW)).body).toContain("no SMTP configured — logged only");
  });

  it("lists who is about to be invited back, by name", async () => {
    mockCandidates.mockResolvedValue([
      {
        customerId: 1,
        firstName: "Daniel",
        email: "daniel@example.com",
        preferredLocale: "en",
        marketingUnsubscribedAt: null,
        marketingToken: null,
        lastMarketingEmailAt: null,
        marketingEmailCount: 0,
        lastCompletedDate: "2026-08-19",
        upcomingCount: 0,
        openInvoiceCount: 0,
      },
    ]);
    const { body } = formatDigest(await collectDigest(new Date("2026-09-08T14:00:00Z")));
    expect(body).toContain("2026-09-12 — Daniel (daniel@example.com) — invitation #1");
  });

  it("flags the subject when the system found a problem", async () => {
    mockPaidOnOpen.mockResolvedValue([
      { invoiceNumber: "INV-X", reference: "GFC-X", bookingStatus: "confirmed", amount: 100 },
    ]);
    const { subject, body } = formatDigest(await collectDigest(NOW));
    expect(subject).toContain("needs a look");
    expect(body).toContain("INV-X");
  });

  it("looks back exactly seven days", async () => {
    await collectDigest(NOW);
    const since = mockStats.mock.calls[0]![0] as Date;
    expect(since.toISOString().slice(0, 10)).toBe("2026-08-17");
  });
});
