/**
 * Automatic follow-ups for unpaid balance links.
 *
 * What this file pins:
 *   - the schedule: a polite reminder 3 days after the original send, one more
 *     at 7 days, both anchored to linkSentAt so renewing the link's validity
 *     never shifts the clock;
 *   - the stop: after two reminders the customer hears nothing further — the
 *     OWNER gets one [ACTION NEEDED] hand-off instead;
 *   - the halts: payment (or a manual mark-paid) ends the sequence wherever it
 *     stood, and every send is claim-guarded so overlapping cron runs cannot
 *     double-email;
 *   - the reset: a manual Resend restarts the whole sequence from its fresh
 *     linkSentAt, owner alert re-armed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockListSentBalanceInvoices = vi.fn();
const mockClaimReminder = vi.fn();
const mockClaimExhaustedAlert = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
  updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
  listSentBalanceInvoices: (...a: unknown[]) => mockListSentBalanceInvoices(...a),
  claimBalanceReminder: (...a: unknown[]) => mockClaimReminder(...a),
  claimBalanceReminderExhaustedAlert: (...a: unknown[]) => mockClaimExhaustedAlert(...a),
  createPayment: vi.fn(),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { resendBalanceLink, sendDueBalanceReminders } from "./balance";
import { BALANCE_LINK_DAYS, balanceReminderAction } from "./balanceRules";
import { __resetTransporter } from "./emails";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "a1".repeat(24);
const DAY = 24 * 60 * 60 * 1000;
const SENT_AT = new Date("2026-08-10T15:00:00Z");
const daysLater = (n: number) => new Date(SENT_AT.getTime() + n * DAY);

const INVOICE = {
  id: 501,
  number: "INV-TEST01",
  bookingId: 42,
  customerId: 7,
  amount: 160,
  status: "sent" as const,
  kind: "balance" as const,
  payToken: TOKEN,
  linkSentAt: SENT_AT,
  linkExpiresAt: new Date(SENT_AT.getTime() + BALANCE_LINK_DAYS * DAY),
  dueDate: "2026-08-17",
  reminderCount: 0,
  lastReminderAt: null,
  reminderExhaustedAlertAt: null,
  refundNeeded: false,
  paidVia: null,
  stripeSessionId: "cs_old",
  stripePaymentIntentId: null,
  createdAt: SENT_AT,
};

const BOOKING = {
  id: 42,
  reference: "GFC-BAL42",
  customerId: 7,
  serviceType: "residential" as const,
  scheduledDate: "2026-08-09",
  locale: "en" as const,
  status: "completed" as const,
  totalAmount: 200,
  depositAmount: 40,
  stripePaymentIntentId: "pi_dep",
  addressLine: "1 Main St",
  city: "San Antonio",
  zip: "78201",
};

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
};

const sentEmails = () =>
  mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetInvoiceById.mockResolvedValue(INVOICE);
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockListSentBalanceInvoices.mockResolvedValue([INVOICE]);
  mockClaimReminder.mockResolvedValue(true);
  mockClaimExhaustedAlert.mockResolvedValue(true);
  mockSessionCreate.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockNotifyOwner.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The schedule, as pure rules.
// ---------------------------------------------------------------------------

describe("balanceReminderAction — the 3/7-day schedule", () => {
  it("stays silent before day 3, fires the first reminder from day 3", () => {
    expect(balanceReminderAction(INVOICE, daysLater(2.9))).toBeNull();
    expect(balanceReminderAction(INVOICE, daysLater(3))).toEqual({ action: "remind", reminderNumber: 1 });
    // A missed cron catches up late rather than skipping.
    expect(balanceReminderAction(INVOICE, daysLater(5))).toEqual({ action: "remind", reminderNumber: 1 });
  });

  it("fires the second reminder from day 7, anchored to the ORIGINAL send", () => {
    const afterFirst = { ...INVOICE, reminderCount: 1, lastReminderAt: daysLater(3) };
    expect(balanceReminderAction(afterFirst, daysLater(6.9))).toBeNull();
    expect(balanceReminderAction(afterFirst, daysLater(7))).toEqual({ action: "remind", reminderNumber: 2 });
  });

  it("after two reminders the customer hears nothing more — the owner is alerted instead, once", () => {
    const exhausted = { ...INVOICE, reminderCount: 2 };
    expect(balanceReminderAction(exhausted, daysLater(8))).toEqual({ action: "owner_alert" });
    expect(
      balanceReminderAction({ ...exhausted, reminderExhaustedAlertAt: daysLater(8) }, daysLater(30))
    ).toBeNull();
  });

  it("any status but sent halts the sequence wherever it stood", () => {
    for (const status of ["paid", "void", "overdue", "awaiting_approval", "draft"] as const) {
      expect(balanceReminderAction({ ...INVOICE, status }, daysLater(10))).toBeNull();
      expect(
        balanceReminderAction({ ...INVOICE, status, reminderCount: 2 }, daysLater(10))
      ).toBeNull();
    }
  });

  it("chases any invoice that actually has a link, whatever produced it", () => {
    // The gate is the LINK, not the kind: manual invoices are billable and get
    // chased on the same schedule — a dollar owed is a dollar owed.
    expect(balanceReminderAction({ ...INVOICE, kind: "manual" }, daysLater(10))).toEqual({
      action: "remind",
      reminderNumber: 1,
    });
    // No link means nothing to point the customer at. This is also what keeps
    // pre-feature manual invoices (which never had a token) out of the sweep.
    expect(balanceReminderAction({ ...INVOICE, payToken: null }, daysLater(10))).toBeNull();
    expect(balanceReminderAction({ ...INVOICE, linkSentAt: null }, daysLater(10))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

describe("sendDueBalanceReminders — the daily sweep", () => {
  it("sends the day-3 reminder with a working link and a renewed validity window", async () => {
    const now = daysLater(3);
    const summary = await sendDueBalanceReminders(ORIGIN, now);
    expect(summary).toMatchObject({ scanned: 1, reminded: 1, alerted: 0 });

    // Claimed as reminder #1 (expected count 0), renewing the link window.
    const [id, expectedCount, data] = mockClaimReminder.mock.calls[0]!;
    expect(id).toBe(501);
    expect(expectedCount).toBe(0);
    expect((data as { linkExpiresAt: Date }).linkExpiresAt.getTime()).toBe(
      now.getTime() + BALANCE_LINK_DAYS * DAY
    );

    const [email] = sentEmails();
    expect(email!.to).toBe("ana@example.com");
    expect(email!.subject).toContain("Friendly reminder");
    expect(email!.text).toContain(`${ORIGIN}/api/pay/balance/${TOKEN}`);
    expect(email!.text).toContain("$160 USD");
    // No new Stripe session at send time — the pay route mints per visit.
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("the day-7 reminder is the final one and says so", async () => {
    mockListSentBalanceInvoices.mockResolvedValue([
      { ...INVOICE, reminderCount: 1, lastReminderAt: daysLater(3) },
    ]);
    await sendDueBalanceReminders(ORIGIN, daysLater(7));
    expect(mockClaimReminder).toHaveBeenCalledWith(501, 1, expect.anything(), expect.anything());
    expect(sentEmails()[0]!.subject).toContain("Final reminder");
  });

  it("writes in the language stored on the booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    await sendDueBalanceReminders(ORIGIN, daysLater(3));
    expect(sentEmails()[0]!.subject).toContain("Recordatorio amistoso");
    expect(sentEmails()[0]!.text).toContain("Saldo pendiente");
  });

  it("does nothing when nothing is due yet", async () => {
    const summary = await sendDueBalanceReminders(ORIGIN, daysLater(1));
    expect(summary).toMatchObject({ scanned: 1, reminded: 0, alerted: 0 });
    expect(mockClaimReminder).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("a lost claim means an overlapping run already sent it — no second email", async () => {
    mockClaimReminder.mockResolvedValue(false);
    const summary = await sendDueBalanceReminders(ORIGIN, daysLater(3));
    expect(summary.reminded).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("hands off to the owner exactly once after both reminders run their course", async () => {
    mockListSentBalanceInvoices.mockResolvedValue([{ ...INVOICE, reminderCount: 2 }]);
    const summary = await sendDueBalanceReminders(ORIGIN, daysLater(8));
    expect(summary).toMatchObject({ reminded: 0, alerted: 1 });
    expect(mockClaimExhaustedAlert).toHaveBeenCalledWith(501, expect.any(Date));
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("[ACTION NEEDED] Unpaid balance INV-TEST01 — 2 reminders sent"),
      })
    );
    // The customer got nothing this pass — the machine has stopped emailing them.
    expect(sentEmails().every(e => e.to !== "ana@example.com")).toBe(true);

    // A second pass loses the alert claim and stays silent.
    vi.clearAllMocks();
    mockListSentBalanceInvoices.mockResolvedValue([
      { ...INVOICE, reminderCount: 2, reminderExhaustedAlertAt: daysLater(8) },
    ]);
    mockClaimExhaustedAlert.mockResolvedValue(false);
    const again = await sendDueBalanceReminders(ORIGIN, daysLater(9));
    expect(again).toMatchObject({ reminded: 0, alerted: 0 });
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("skips without claiming when no public origin is configured — the send survives for the next run", async () => {
    const summary = await sendDueBalanceReminders("", daysLater(3));
    expect(summary.reminded).toBe(0);
    expect(summary.details[0]).toContain("no public origin");
    expect(mockClaimReminder).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The reset.
// ---------------------------------------------------------------------------

describe("a manual Resend restarts the sequence", () => {
  it("zeroes the count, clears the alert, and re-anchors the clock to the new send", async () => {
    mockGetInvoiceById.mockResolvedValue({
      ...INVOICE,
      reminderCount: 2,
      lastReminderAt: daysLater(7),
      reminderExhaustedAlertAt: daysLater(8),
    });
    const result = await resendBalanceLink(501, ORIGIN);
    expect(result.outcome).toBe("resent");
    expect(mockUpdateInvoice).toHaveBeenCalledWith(
      501,
      expect.objectContaining({
        status: "sent",
        linkSentAt: expect.any(Date),
        reminderCount: 0,
        lastReminderAt: null,
        reminderExhaustedAlertAt: null,
      })
    );
  });

  it("after the reset, the schedule runs again from the fresh linkSentAt", () => {
    const resent = { ...INVOICE, linkSentAt: daysLater(10), reminderCount: 0 };
    expect(balanceReminderAction(resent, daysLater(12))).toBeNull();
    expect(balanceReminderAction(resent, daysLater(13))).toEqual({ action: "remind", reminderNumber: 1 });
  });
});
