/**
 * Manual invoices as billable documents.
 *
 * A manual invoice is the owner-raised counterpart to a balance invoice: work
 * with no booking behind it. The point of this file is that "no booking" never
 * degrades into wrong money or nonsense copy. Specifically it pins:
 *   - issue → email → pay, end to end, with itemization surviving into both the
 *     stored snapshot and the Stripe line items;
 *   - NO deposit credit line, because there is no deposit — a "$0 already paid"
 *     row would imply a credit the customer never made;
 *   - NO tip ask on settlement, because there is no crew and no finished job;
 *   - reminders on the same 3/7-day schedule, halting the moment it is paid;
 *   - resend re-billing the stored snapshot rather than today's catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerById = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockSettleUnpaidInvoice = vi.fn();
const mockCreatePayment = vi.fn();
const mockGetSetting = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();
const mockSendTipRequest = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
  createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
  updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
  settleUnpaidInvoice: (...a: unknown[]) => mockSettleUnpaidInvoice(...a),
  flagInvoiceRefundNeeded: vi.fn().mockResolvedValue(true),
  createPayment: (...a: unknown[]) => mockCreatePayment(...a),
  updateBooking: vi.fn(),
  listInvoices: vi.fn().mockResolvedValue([]),
  getBalanceInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a), expire: vi.fn() } },
  }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a) }));

// The tip flow is mocked so the test can assert it is never invoked, rather
// than merely that no tip email happened to be sent.
vi.mock("./tip", () => ({ sendTipRequestEmailSafely: (...a: unknown[]) => mockSendTipRequest(...a) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { applyBalancePayment, issueManualInvoice, resendBalanceLink } from "./balance";
import { balanceReminderAction } from "./balanceRules";
import { __resetTransporter } from "./emails";

const ORIGIN = "https://grapeclean.example";
const DAY = 24 * 60 * 60 * 1000;
const SENT_AT = new Date("2026-08-10T15:00:00Z");
const daysLater = (n: number) => new Date(SENT_AT.getTime() + n * DAY);

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  preferredLocale: "en" as const,
};

/** A manual invoice as it exists once issued: token, snapshot, no booking. */
const MANUAL_INVOICE = {
  id: 900,
  number: "INV-MANUAL01",
  bookingId: null,
  customerId: 7,
  amount: 145,
  kind: "manual" as const,
  status: "sent" as const,
  payToken: "tok_manual",
  stripeSessionId: "cs_manual",
  stripePaymentIntentId: null as string | null,
  paidVia: null as "stripe" | "manual" | null,
  refundNeeded: false,
  // The stored snapshot's real shape: `kind`, and an id from the live catalog
  // ("refrigerator", not "fridge") — parseLineItems drops anything else, which
  // would silently empty the snapshot and make this test pass for nothing.
  lineItems: JSON.stringify([{ kind: "addon", id: "refrigerator", name: "Inside fridge", amount: 45 }]),
  linkSentAt: SENT_AT,
  linkExpiresAt: new Date(SENT_AT.getTime() + 7 * DAY),
  dueDate: "2026-08-17",
  reminderCount: 0,
  lastReminderAt: null,
  reminderExhaustedAlertAt: null,
  createdAt: SENT_AT,
};

const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetBookingById.mockResolvedValue(undefined);
  mockGetInvoiceById.mockResolvedValue(MANUAL_INVOICE);
  mockCreateInvoice.mockResolvedValue(900);
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockSettleUnpaidInvoice.mockResolvedValue(true);
  mockSessionCreate.mockResolvedValue({ id: "cs_manual", url: "https://stripe.test/manual" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockNotifyOwner.mockResolvedValue(undefined);
  mockSendTipRequest.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

// ---------------------------------------------------------------------------
// Issue → email → pay
// ---------------------------------------------------------------------------

describe("issueManualInvoice", () => {
  it("issues an itemized invoice, mints a link, and emails the customer", async () => {
    const result = await issueManualInvoice({
      customerId: 7,
      amount: 100,
      addonIds: ["refrigerator"],
      customItems: [{ name: "Garage sweep", amount: 25 }],
      origin: ORIGIN,
      now: SENT_AT,
    });

    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") return;
    // Base + add-on (live catalog price) + custom line. The entered amount is
    // the service line, never the whole bill.
    expect(result.amount).toBeGreaterThan(100);
    expect(result.emailed).toBe(true);

    const row = mockCreateInvoice.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.kind).toBe("manual");
    expect(row.status).toBe("sent");
    expect(row.bookingId).toBeUndefined();
    expect(row.payToken).toEqual(expect.any(String));
    // The snapshot is stored at issue time, so later catalog edits cannot
    // silently re-price an invoice already in the customer's inbox.
    const items = JSON.parse(row.lineItems as string) as { name: string; amount: number }[];
    expect(items.map(i => i.name)).toContain("Garage sweep");

    const [email] = sentEmails();
    expect(email!.to).toBe("ana@example.com");
    expect(email!.text).toContain(`${ORIGIN}/api/pay/balance/`);
    expect(email!.text).toContain("Garage sweep");
  });

  it("shows no deposit credit — there was never a deposit to credit", async () => {
    await issueManualInvoice({ customerId: 7, amount: 145, origin: ORIGIN, now: SENT_AT });
    const [email] = sentEmails();
    // The balance template's deposit block would otherwise print "$0 already
    // paid", which reads as a credit the customer never made.
    expect(email!.text).not.toContain("Deposit already paid");
    expect(email!.text).toContain("Total due:");
    // Nor any empty booking fields.
    expect(email!.text).not.toContain("Reference:");
    expect(email!.text).not.toContain("Service date:");
  });

  it("bills in the customer's own language, since no booking carries one", async () => {
    mockGetCustomerById.mockResolvedValue({ ...CUSTOMER, preferredLocale: "es" });
    await issueManualInvoice({ customerId: 7, amount: 145, origin: ORIGIN, now: SENT_AT });
    expect(sentEmails()[0]!.subject).toContain("Su factura");
    expect(sentEmails()[0]!.text).toContain("Total a pagar:");
  });

  it("refuses before writing a row when the customer has no email", async () => {
    mockGetCustomerById.mockResolvedValue({ ...CUSTOMER, email: null });
    const result = await issueManualInvoice({ customerId: 7, amount: 145, origin: ORIGIN });
    expect(result.outcome).toBe("customer_has_no_email");
    // No unsendable invoice left behind.
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("carries the itemization into the Stripe session, not just the email", async () => {
    await issueManualInvoice({
      customerId: 7,
      amount: 100,
      customItems: [{ name: "Garage sweep", amount: 25 }],
      origin: ORIGIN,
      now: SENT_AT,
    });
    const args = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { product_data: { name: string }; unit_amount: number } }[];
      metadata: Record<string, string>;
    };
    expect(args.line_items.map(l => l.price_data.product_data.name)).toContain("Garage sweep");
    // Routed by the same webhook branch as a balance…
    expect(args.metadata.payment_type).toBe("balance");
    // …but with no booking keys invented for it.
    expect(args.metadata.booking_id).toBeUndefined();
    expect(args.metadata.booking_reference).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

describe("paying a manual invoice", () => {
  it("settles through the same webhook path and records the payment", async () => {
    const result = await applyBalancePayment(900, "pi_manual_1");
    expect(result.outcome).toBe("paid");
    expect(mockSettleUnpaidInvoice).toHaveBeenCalledWith(
      900,
      expect.objectContaining({ paidVia: "stripe", stripePaymentIntentId: "pi_manual_1" })
    );
    expect(mockCreatePayment).toHaveBeenCalled();
  });

  it("never asks for a crew tip — there is no finished job behind it", async () => {
    await applyBalancePayment(900, "pi_manual_1");
    expect(mockSendTipRequest).not.toHaveBeenCalled();
  });

  it("still asks for a tip when a real balance invoice settles", async () => {
    // The negative above must be caused by the manual kind, not by a tip flow
    // that is broken for everyone.
    mockGetInvoiceById.mockResolvedValue({ ...MANUAL_INVOICE, kind: "balance", bookingId: 42 });
    await applyBalancePayment(900, "pi_balance_1");
    expect(mockSendTipRequest).toHaveBeenCalledWith(42, expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

describe("reminders on a manual invoice", () => {
  it("fires on the same 3/7-day schedule as a balance", () => {
    expect(balanceReminderAction(MANUAL_INVOICE, daysLater(2.9))).toBeNull();
    expect(balanceReminderAction(MANUAL_INVOICE, daysLater(3))).toEqual({ action: "remind", reminderNumber: 1 });
    expect(balanceReminderAction({ ...MANUAL_INVOICE, reminderCount: 1 }, daysLater(7))).toEqual({
      action: "remind",
      reminderNumber: 2,
    });
  });

  it("stops the moment it is paid, wherever the sequence stood", () => {
    expect(balanceReminderAction({ ...MANUAL_INVOICE, status: "paid" }, daysLater(10))).toBeNull();
    expect(
      balanceReminderAction({ ...MANUAL_INVOICE, status: "paid", reminderCount: 1 }, daysLater(10))
    ).toBeNull();
    // Voided too — nothing is owed on a cancelled invoice.
    expect(balanceReminderAction({ ...MANUAL_INVOICE, status: "void" }, daysLater(10))).toBeNull();
  });

  it("leaves pre-feature manual invoices alone: no link, no chase", () => {
    expect(balanceReminderAction({ ...MANUAL_INVOICE, payToken: null }, daysLater(10))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

describe("resending a manual invoice", () => {
  it("re-bills the stored snapshot rather than today's catalog", async () => {
    const result = await resendBalanceLink(900, ORIGIN);
    expect(result.outcome).toBe("resent");

    // The snapshot's own words and dollars reach both the email and Stripe,
    // even if the catalog has since moved.
    const args = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { product_data: { name: string }; unit_amount: number } }[];
    };
    // $45 is the snapshotted price, not whatever the catalog charges today.
    const addonLine = args.line_items.find(l => l.price_data.unit_amount === 45 * 100);
    expect(addonLine).toBeDefined();
    expect(sentEmails()[0]!.text).toContain("$45 USD");
  });

  it("renews the link window and restarts the reminder sequence", async () => {
    mockGetInvoiceById.mockResolvedValue({
      ...MANUAL_INVOICE,
      reminderCount: 2,
      reminderExhaustedAlertAt: daysLater(8),
    });
    await resendBalanceLink(900, ORIGIN);
    expect(mockUpdateInvoice).toHaveBeenCalledWith(
      900,
      expect.objectContaining({
        status: "sent",
        reminderCount: 0,
        lastReminderAt: null,
        reminderExhaustedAlertAt: null,
      })
    );
  });
});
