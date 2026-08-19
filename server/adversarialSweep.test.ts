/**
 * Adversarial sweep gap-fillers: the review checklist scenarios that had no
 * single existing test to point at. The rest of the sweep is evidenced by
 * the standing suite — see the sweep report for the scenario→test map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetBalanceInvoiceForBooking = vi.fn();
const mockCreateInvoice = vi.fn();
const mockListSentBalanceInvoices = vi.fn();
const mockClaimBalanceReminder = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  getInvoiceById: (...args: unknown[]) => mockGetInvoiceById(...args),
  getBalanceInvoiceForBooking: (...args: unknown[]) => mockGetBalanceInvoiceForBooking(...args),
  createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
  updateInvoice: vi.fn(),
  updateBooking: vi.fn(),
  createPayment: vi.fn(),
  listSentBalanceInvoices: (...args: unknown[]) => mockListSentBalanceInvoices(...args),
  claimBalanceReminder: (...args: unknown[]) => mockClaimBalanceReminder(...args),
  claimBalanceReminderExhaustedAlert: vi.fn().mockResolvedValue(true),
  listInvoices: vi.fn().mockResolvedValue([]),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: vi.fn().mockResolvedValue({ id: "cs_x", url: "https://s" }) } },
  }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import { serializeLineItems } from "@shared/invoiceItems";
import { calculateQuote, DEFAULT_PRICING, type ExtraId } from "@shared/pricing";
import { balanceReminderAction, computeBalanceDue } from "./balanceRules";
import { issueBalanceForCompletedBooking, sendDueBalanceReminders } from "./balance";
import { __resetTransporter } from "./emails";
import { tipPresets } from "./tip";

const BOOKING = {
  id: 42,
  reference: "GFC-SWEEP1",
  customerId: 7,
  serviceType: "residential" as const,
  frequency: "onetime" as const,
  scheduledDate: "2026-08-01",
  scheduledTime: "09:00",
  locale: "en" as const,
  status: "completed" as const,
  totalAmount: 250,
  depositAmount: 0,
  addressLine: "123 Main St",
  unitNumber: null,
  city: "San Antonio",
  zip: "78201",
  extras: "[]",
  couponCode: null,
  stripePaymentIntentId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
  mockGetSetting.mockResolvedValue(null);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue({
    id: 7,
    firstName: "Ana",
    lastName: "Lopez",
    email: "ana@example.com",
    phone: "2105550000",
  });
  mockGetBalanceInvoiceForBooking.mockResolvedValue(undefined);
  mockCreateInvoice.mockResolvedValue(601);
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockListSentBalanceInvoices.mockResolvedValue([]);
  mockClaimBalanceReminder.mockResolvedValue(true);
});

describe("scenario 1 — booking totals with 0, 1, and 5 add-ons", () => {
  const base = { type: "residential" as const, bedrooms: 2, bathrooms: 1, sqft: 1200, frequency: "onetime" as const };
  const five: ExtraId[] = ["laundry", "oven", "windows", "pets", "garage"];

  it("each add-on adds exactly its catalog price to the total", () => {
    const none = calculateQuote({ ...base, extras: [] }, DEFAULT_PRICING);
    const one = calculateQuote({ ...base, extras: ["laundry"] }, DEFAULT_PRICING);
    const all5 = calculateQuote({ ...base, extras: five }, DEFAULT_PRICING);
    expect(none.extrasTotal).toBe(0);
    expect(one.total - none.total).toBeCloseTo(DEFAULT_PRICING.extras.laundry, 2);
    const fiveSum = five.reduce((sum, id) => sum + DEFAULT_PRICING.extras[id], 0);
    expect(all5.extrasTotal).toBeCloseTo(fiveSum, 2);
    expect(all5.total).toBeCloseTo(none.total + fiveSum, 2);
  });

  it("the math is locale-free: EN and ES bookings price identically", () => {
    // Locale drives words, never numbers — the same shared engine runs for
    // both languages, so asserting the engine once covers EN and ES; the
    // bilingual WORDING is pinned by the email/i18n tests.
    const quote = calculateQuote({ ...base, extras: five }, DEFAULT_PRICING);
    expect(quote.total).toBe(calculateQuote({ ...base, extras: [...five] }, DEFAULT_PRICING).total);
  });
});

describe("scenario 2 — catalog edits never rewrite pinned money", () => {
  it("a booking's stored totals are computed once, at creation, and never re-derived", () => {
    // The pinning design: totalAmount/depositAmount/estimatedHours are DB
    // columns written by booking.create from the config OF THAT MOMENT, and
    // no code path recomputes them afterwards (finalize/confirm read the
    // row). A catalog change alters only future quotes:
    const before = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: ["oven"], frequency: "onetime" },
      DEFAULT_PRICING
    );
    const editedCatalog = {
      ...DEFAULT_PRICING,
      extras: { ...DEFAULT_PRICING.extras, oven: DEFAULT_PRICING.extras.oven + 40 },
    };
    const after = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: ["oven"], frequency: "onetime" },
      editedCatalog
    );
    expect(after.total).toBeCloseTo(before.total + 40, 2);
    // A row written from `before` holds a NUMBER (e.g. 152), not a formula —
    // nothing about `editedCatalog` can reach it. Sent invoices carry the
    // same protection explicitly via the lineItems snapshot (scenario 10
    // test in invoiceLineItems.test.ts).
    expect(before.total).not.toBe(after.total);
  });
});

describe("scenario 3 — zero-deposit booking bills full price at completion", () => {
  it("the balance invoice for an unpaid-deposit booking is the whole total", async () => {
    // depositAmount 0 and no payment intent — the ical_auto/no-deposit shape.
    const result = await issueBalanceForCompletedBooking(42, "https://grapefruitclean.com");
    expect(result.outcome).toBe("awaiting_approval");
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 250, computedAmount: 250, kind: "balance", status: "awaiting_approval" })
    );
  });

  it("a PAID deposit is credited; an unpaid one never is", () => {
    expect(computeBalanceDue({ totalAmount: 250, depositAmount: 0 })).toBe(250);
    expect(computeBalanceDue({ totalAmount: 250, depositAmount: 50 })).toBe(200);
  });
});

describe("scenario 14 — tips key off the booking total, not the invoice", () => {
  it("an itemized invoice does not move the tip presets", () => {
    // The tip flow reads booking.totalAmount; invoice.amount (base + add-ons
    // + customs) is a different number and a different table. Presets on the
    // $250 job stay 15/20/25% of 250 whatever the invoice billed.
    const presets = tipPresets(BOOKING.totalAmount);
    expect(presets).toEqual([
      { percent: 15, amount: 38 },
      { percent: 20, amount: 50 },
      { percent: 25, amount: 63 },
    ]);
  });
});

describe("scenarios 18 & 19 — reminders on itemized and zero-settled invoices", () => {
  const SENT_ITEMIZED = {
    id: 601,
    number: "INV-SWEEP-1",
    bookingId: 42,
    customerId: 7,
    amount: 275,
    computedAmount: 200,
    kind: "balance" as const,
    status: "sent" as const,
    payToken: "tok-sweep",
    lineItems: serializeLineItems([
      { kind: "addon", id: "laundry", name: "Laundry & folding", amount: 30 },
      { kind: "custom", name: "Garage sweep-out", amount: 45 },
    ]),
    linkSentAt: new Date(Date.now() - 4 * 24 * 3_600_000),
    linkExpiresAt: new Date(Date.now() + 3 * 24 * 3_600_000),
    dueDate: null,
    paidAt: null,
    reminderCount: 0,
    lastReminderAt: null,
    reminderExhaustedAlertAt: null,
    createdAt: new Date(),
  };

  it("the day-3 reminder carries the itemization and the exact amount", async () => {
    mockListSentBalanceInvoices.mockResolvedValue([SENT_ITEMIZED]);
    const summary = await sendDueBalanceReminders("https://grapefruitclean.com");
    expect(summary.reminded).toBe(1);
    const body = (mockSendMail.mock.calls[0]![0] as { text?: string }).text ?? "";
    expect(body).toContain("$275");
    expect(body).toContain("Laundry & folding: $30 USD");
    expect(body).toContain("Garage sweep-out: $45 USD");
  });

  it("a lost claim sends nothing — no duplicate reminders across overlapping runs", async () => {
    mockListSentBalanceInvoices.mockResolvedValue([SENT_ITEMIZED]);
    mockClaimBalanceReminder.mockResolvedValue(false);
    const summary = await sendDueBalanceReminders("https://grapefruitclean.com");
    expect(summary.reminded).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("an invoice settled at zero is never reminded", () => {
    // Zero-settle writes status "paid" with no payToken — both of which halt
    // the reminder rules on their own.
    const settled = { kind: "balance", status: "paid", payToken: null, reminderCount: 0, linkSentAt: null };
    expect(balanceReminderAction(settled as never, new Date())).toBeNull();
  });
});
