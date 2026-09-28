/**
 * Test D — regular customer payment, and the new PAY WITH CASH choice.
 *
 * What this file pins:
 *   - the default flow is untouched: a residential booking at the 20% dial
 *     still creates a pending_deposit row, mints the Stripe session, and the
 *     webhook finalization records the deposit — exactly as before;
 *   - PAY WITH CASH at booking waives the deposit: the row confirms on submit
 *     with depositAmount 0, the preference and its timestamp stored, no Stripe
 *     session, no payment row, and every email says cash;
 *   - the deposit link's PAY WITH CASH does the same for a phone lead, through
 *     the same finalizeBooking claim, with the owner told they chose cash;
 *   - a cash-preferring balance invoice is never chased by the card reminders;
 *   - the payment position reads Cash pending until the money is recorded;
 *   - the customer-facing pages offer both choices (source pins).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetBookingByPayToken = vi.fn();
const mockGetCouponByCode = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockExpireForSlot = vi.fn();
const mockConfirmUnpaid = vi.fn();
const mockCreatePayment = vi.fn();
const mockListSentBalanceInvoices = vi.fn();
const mockClaimReminder = vi.fn();
const mockGetCustomerById = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
    getCouponByCode: (...a: unknown[]) => mockGetCouponByCode(...a),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    expireStaleBookingsForSlot: (...a: unknown[]) => mockExpireForSlot(...a),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
    createPayment: (...a: unknown[]) => mockCreatePayment(...a),
    incrementCouponRedemptions: vi.fn(),
    isSlotTakenError: actual.isSlotTakenError,
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    listSentBalanceInvoices: (...a: unknown[]) => mockListSentBalanceInvoices(...a),
    claimBalanceReminder: (...a: unknown[]) => mockClaimReminder(...a),
    claimBalanceReminderExhaustedAlert: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("./property", () => ({
  lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { derivePaymentStatus } from "@shared/paymentStatus";
import { PAYMENT_PREFERENCES } from "@shared/paymentPreference";
import { _resetRateLimits } from "./antiSpam";
import { sendDueBalanceReminders } from "./balance";
import { buildCustomerConfirmation, buildOwnerNotification, buildReminderEmail, __resetTransporter } from "./emails";
import { bookingRouter, finalizeBooking } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const TOKEN = "e".repeat(48);

const publicCtx = (): TrpcContext => ({
  user: null,
  req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
  res: {} as TrpcContext["res"],
});
const bookingCaller = () => bookingRouter.createCaller(publicCtx());
const payCaller = () => depositLinkRouter.createCaller(publicCtx());

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

const CUSTOMER = { id: 7, firstName: "Maria", lastName: "Lopez", email: "maria@example.com", phone: "2105550134", preferredLocale: "en" };

const CREATE_INPUT = {
  quote: { type: "residential" as const, bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [] as never[], frequency: "onetime" as const },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Maria",
  lastName: "Lopez",
  email: "maria@example.com",
  phone: "2105550134",
  address: "1 Main St",
  propertyType: "house" as const,
  city: "San Antonio",
  zip: "78201",
  locale: "en" as const,
};

/** A complete admin-link row at the default 20% dial. */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-LINK1",
  customerId: 7,
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "10:00",
  bedrooms: 2,
  bathrooms: 1,
  sqft: 1200,
  extras: "[]",
  addressLine: "1 Main St",
  city: "San Antonio",
  zip: "78201",
  notes: null,
  locale: "en",
  totalAmount: 113,
  depositAmount: 23,
  status: "pending_deposit",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: 3,
  verifiedSqft: null,
  sqftMismatch: false,
  kind: "admin",
  holdMinutes: 24 * 60,
  payToken: TOKEN,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  adminProvided: "service,size,address,slot",
  paymentPreference: null,
  cashChosenAt: null,
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetSetting.mockResolvedValue(null); // defaults → 20% deposit
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetCouponByCode.mockResolvedValue(undefined);
  mockFindOrCreateCustomer.mockResolvedValue(7);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockExpireForSlot.mockResolvedValue(0);
  mockConfirmUnpaid.mockResolvedValue(true);
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockListSentBalanceInvoices.mockResolvedValue([]);
  mockClaimReminder.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// Test D — the regular deposit flow, exactly as intended.
// ---------------------------------------------------------------------------

describe("Test D — a regular booking still runs the deposit flow exactly as before", () => {
  it("pays online by default: pending_deposit, a 20% deposit, one Stripe session", async () => {
    const result = await bookingCaller().create(CREATE_INPUT);
    expect(written().status).toBe("pending_deposit");
    // 1,200 sq ft residential is $112.99 → a 20% deposit of $22.60 (whole dollars land at the DB layer).
    expect(written().totalAmount).toBe(112.99);
    expect(written().depositAmount).toBe(22.6);
    expect(written().depositAmountCents).toBe(2260);
    expect(written().paymentPreference).toBeNull();
    expect(written().cashChosenAt).toBeNull();
    expect(mockSessionCreate).toHaveBeenCalledOnce();
    expect(mockSessionCreate.mock.calls[0]![0]).toMatchObject({
      line_items: [{ price_data: { unit_amount: 2260 } }],
    });
    expect(result.confirmed).toBe(false);
    expect(result.checkoutUrl).toBe("https://stripe.test/pay");
  });

  it("an explicit PAY ONLINE choice is the same flow, with the choice remembered", async () => {
    await bookingCaller().create({ ...CREATE_INPUT, paymentPreference: "online" });
    expect(written().status).toBe("pending_deposit");
    expect(written().paymentPreference).toBe("online");
    expect(mockSessionCreate).toHaveBeenCalledOnce();
  });

  it("the paid deposit still finalizes through the webhook path: payment row, confirmation email", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "pending_deposit", adminProvided: null, depositAmount: 23, depositAmountCents: 2300 })
    );
    await finalizeBooking(99, "pi_deposit_1");
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ stripePaymentIntentId: "pi_deposit_1" }));
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "deposit", amount: 23, amountCents: 2300, method: "card", source: "stripe" })
    );
    const customerEmail = sentEmails().find(e => e.to === "maria@example.com");
    expect(customerEmail?.text).toContain("Deposit paid today: $23 USD");
    expect(customerEmail?.text).toContain("Remaining balance (due on completion): $90 USD");
  });

  it("the preference input only accepts the two real choices", () => {
    expect(PAYMENT_PREFERENCES).toEqual(["online", "cash"]);
    return expect(
      bookingCaller().create({ ...CREATE_INPUT, paymentPreference: "check" as never })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PAY WITH CASH at booking.
// ---------------------------------------------------------------------------

describe("PAY WITH CASH on the public booking", () => {
  const cashRow = () =>
    linkRow({ kind: "self_serve", status: "confirmed", adminProvided: null, depositAmount: 0, depositAmountCents: 0, paymentPreference: "cash", cashChosenAt: new Date() });

  it("waives the deposit and confirms on submit — no Stripe, no payment row", async () => {
    mockGetBookingById.mockResolvedValue(cashRow());
    const result = await bookingCaller().create({ ...CREATE_INPUT, paymentPreference: "cash" });
    expect(written().status).toBe("confirmed");
    expect(written().depositAmount).toBe(0);
    expect(written().depositAmountCents).toBe(0);
    expect(written().paymentPreference).toBe("cash");
    expect(written().cashChosenAt).toBeInstanceOf(Date);
    // The price itself is untouched: cash changes when they pay, not what.
    expect(written().totalAmount).toBe(112.99);
    expect(written().totalAmountCents).toBe(11299);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.booking.deposit).toBe(0);
      expect(result.booking.paymentPreference).toBe("cash");
    }
  });

  it("tells the customer and the owner it is cash, in the customer's language", async () => {
    mockGetBookingById.mockResolvedValue(cashRow());
    await bookingCaller().create({ ...CREATE_INPUT, paymentPreference: "cash" });
    const customerEmail = sentEmails().find(e => e.to === "maria@example.com");
    expect(customerEmail?.text).toContain("You chose to pay in cash: $113 USD is due at your cleaning. No deposit was charged.");
    expect(customerEmail?.text).not.toContain("Deposit paid today");
    const ownerEmail = sentEmails().find(e => e.to === "hello@grapefruitclean.com");
    expect(ownerEmail?.text).toContain("PAY IN CASH");
    expect(ownerEmail?.text).toContain("PAYING IN CASH — nothing collected yet");
  });

  it("reads Cash pending until the money is recorded, then Paid in Cash", () => {
    const base = { status: "confirmed", depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null, paymentPreference: "cash" };
    expect(derivePaymentStatus(base)).toBe("cash_pending");
    expect(derivePaymentStatus({ ...base, status: "completed" })).toBe("cash_pending");
    expect(derivePaymentStatus({ ...base, status: "completed", invoice: { status: "awaiting_approval" } })).toBe("cash_pending");
    expect(derivePaymentStatus({ ...base, status: "completed", invoice: { status: "sent" } })).toBe("cash_pending");
    expect(derivePaymentStatus({ ...base, status: "completed", invoice: { status: "paid", paidVia: "manual", paidMethod: "cash" } })).toBe("paid_cash");
    // A cash customer who pays by card after all is simply paid.
    expect(derivePaymentStatus({ ...base, status: "completed", invoice: { status: "paid", paidVia: "stripe", paidMethod: "card" } })).toBe("paid");
    // The invoice's own record of the choice counts too.
    expect(derivePaymentStatus({ status: "completed", depositAmount: 0, invoice: { status: "sent", paymentPreference: "cash" } })).toBe("cash_pending");
  });
});

// ---------------------------------------------------------------------------
// PAY WITH CASH on the deposit link.
// ---------------------------------------------------------------------------

describe("PAY WITH CASH on the deposit link", () => {
  it("the page offers the choice: a real deposit is priced, and no cash preference yet", async () => {
    const result = await payCaller().get({ token: TOKEN });
    expect(result.state).toBe("awaiting_payment");
    expect(result.booking?.deposit).toBe(23);
    expect(result.booking?.depositFree).toBe(false);
    expect(result.booking?.paymentPreference).toBeNull();
  });

  it("chooseCash writes a $0 deposit and the preference, then confirms through the same claim", async () => {
    // finalizeBooking re-reads the row after the patch: deposit 0, preference cash.
    mockGetBookingById.mockResolvedValue(linkRow({ depositAmount: 0, depositAmountCents: 0, paymentPreference: "cash" }));
    const result = await payCaller().chooseCash({ token: TOKEN, extras: [] });
    expect(result).toEqual({ confirmed: true, reference: "GFC-LINK1", paymentPreference: "cash" });
    const patches = Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as object)) as Record<string, unknown>;
    expect(patches.depositAmount).toBe(0);
    expect(patches.depositAmountCents).toBe(0);
    expect(patches.paymentPreference).toBe("cash");
    expect(patches.cashChosenAt).toBeInstanceOf(Date);
    expect(Number(patches.totalAmount)).toBe(112.99);
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ slotConflict: false }));
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("the owner's completed-link email says they chose cash", async () => {
    // finalizeBooking re-reads the row after the cash patch landed: still
    // pending_deposit (the claim flips it), now carrying the preference.
    mockGetBookingById.mockResolvedValue(linkRow({ depositAmount: 0, depositAmountCents: 0, paymentPreference: "cash" }));
    await payCaller().chooseCash({ token: TOKEN, extras: [] });
    const ownerEmail = sentEmails().find(e => e.subject.includes("link completed"));
    expect(ownerEmail).toBeDefined();
    expect(ownerEmail!.text).toContain("chose to PAY IN CASH (no deposit taken)");
  });

  it("a double tap confirms exactly once", async () => {
    await payCaller().chooseCash({ token: TOKEN, extras: [] });
    const emailsAfterFirst = sentEmails().length;
    mockConfirmUnpaid.mockResolvedValue(false);
    await payCaller().chooseCash({ token: TOKEN, extras: [] });
    expect(sentEmails().length).toBe(emailsAfterFirst);
  });

  it("refuses an incomplete or dead link, exactly like the pay button", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ serviceType: null, adminProvided: null }));
    await expect(payCaller().chooseCash({ token: TOKEN, extras: [] })).rejects.toThrow(/still missing/i);
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ payTokenExpiresAt: new Date(Date.now() - 60_000) }));
    await expect(payCaller().chooseCash({ token: TOKEN, extras: [] })).rejects.toThrow(/expired/i);
    expect(mockConfirmUnpaid).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reminders and email copy.
// ---------------------------------------------------------------------------

describe("cash and the automatic card reminders", () => {
  const sentInvoice = (overrides: Record<string, unknown> = {}) => ({
    id: 501,
    number: "INV-CASH-01",
    bookingId: 99,
    customerId: 7,
    amount: 113,
    amountCents: 11300,
    status: "sent",
    kind: "balance",
    payToken: TOKEN,
    linkSentAt: new Date("2026-08-10T15:00:00Z"),
    linkExpiresAt: new Date("2026-08-17T15:00:00Z"),
    reminderCount: 0,
    lastReminderAt: null,
    reminderExhaustedAlertAt: null,
    lineItems: null,
    paymentPreference: null,
    serviceType: "residential",
    serviceDate: OPEN_MONDAY,
    ...overrides,
  });

  it("a cash-preferring invoice is skipped by the reminder sweep, and says so", async () => {
    mockGetBookingById.mockResolvedValue(linkRow({ status: "completed", depositAmount: 0, paymentPreference: "cash" }));
    mockListSentBalanceInvoices.mockResolvedValue([sentInvoice({ paymentPreference: "cash" })]);
    const result = await sendDueBalanceReminders(ORIGIN, new Date("2026-08-13T16:00:00Z"));
    expect(result.reminded).toBe(0);
    expect(result.details).toEqual(["INV-CASH-01: skipped — customer chose to pay in cash"]);
    expect(mockClaimReminder).not.toHaveBeenCalled();
    expect(sentEmails()).toEqual([]);
  });

  it("the same invoice without the cash choice is reminded as before (positive control)", async () => {
    mockGetBookingById.mockResolvedValue(linkRow({ status: "completed" }));
    mockListSentBalanceInvoices.mockResolvedValue([sentInvoice()]);
    const result = await sendDueBalanceReminders(ORIGIN, new Date("2026-08-13T16:00:00Z"));
    expect(result.reminded).toBe(1);
    expect(sentEmails()[0]?.subject).toContain("Friendly reminder");
  });

  it("the reminder and confirmation emails talk about cash, not a deposit or a card balance", () => {
    const base = {
      reference: "GFC-TEST1",
      serviceName: "Residential Cleaning",
      date: OPEN_MONDAY,
      time: "10:00",
      frequencyLabel: "One-time",
      extras: [],
      total: 150,
      deposit: 0,
      customerName: "Maria",
      customerEmail: "maria@example.com",
      paymentPreference: "cash" as const,
    };
    expect(buildReminderEmail({ ...base, locale: "en" }, "day").body).toContain(
      "Paying in cash: $150 USD is due when your cleaning is complete."
    );
    expect(buildReminderEmail({ ...base, locale: "es" }, "day").body).toContain(
      "Pago en efectivo: $150 USD se paga al completar el servicio."
    );
    expect(buildCustomerConfirmation({ ...base, locale: "es" }).body).toContain("Eligió pagar en efectivo");
    expect(buildOwnerNotification({ ...base, locale: "en" }).content).toContain("Collect $150 USD at the cleaning");
    // Without the choice the zero-deposit wording is unchanged.
    expect(buildReminderEmail({ ...base, paymentPreference: null, locale: "en" }, "day").body).toContain(
      "Total due on completion: $150 USD"
    );
    expect(buildReminderEmail({ ...base, paymentPreference: null, deposit: 30, locale: "en" }, "day").body).toContain(
      "Remaining balance due on completion: $120 USD"
    );
  });
});

// ---------------------------------------------------------------------------
// The customer-facing pages offer both choices.
// ---------------------------------------------------------------------------

describe("the pages offer PAY ONLINE and PAY WITH CASH", () => {
  it("the public review step has the two-way choice and sends the preference, never an amount", () => {
    const page = source("../client/src/pages/Booking.tsx");
    expect(page).toContain('data-testid="payment-method"');
    expect(page).toContain('useState<"online" | "cash">("online")');
    expect(page).toContain("paymentPreference: paymentMethod");
    expect(page).toContain("t.booking.payWithCash");
    expect(page).toContain("t.booking.airbnbNoDeposit");
    // No deposit line or deposit button once cash is chosen.
    expect(page).toContain("const noPaymentToday = zeroDeposit || payingCash;");
    expect(page).toContain("{!noPaymentToday && (");
  });

  it("both languages carry the copy", () => {
    const en = source("../client/src/i18n/translations/en.ts");
    const es = source("../client/src/i18n/translations/es.ts");
    for (const key of ["paymentMethod", "payOnline", "payWithCash", "payWithCashHint", "cashChosenNote", "airbnbNoDeposit", "paymentCash"]) {
      expect(en, key).toContain(`${key}:`);
      expect(es, key).toContain(`${key}:`);
    }
    expect(en).toContain('payWithCash: "Pay with cash"');
    expect(es).toContain('payWithCash: "Pagar en efectivo"');
  });

  it("the deposit-link page has a cash button that calls chooseCash", () => {
    const page = source("../client/src/pages/PayDeposit.tsx");
    expect(page).toContain("trpc.depositLink.chooseCash.useMutation");
    expect(page).toContain("cashButton: \"Pay with cash instead — no deposit\"");
    expect(page).toContain("cashButton: \"Prefiero pagar en efectivo — sin depósito\"");
    // Only offered when a deposit would otherwise be taken.
    expect(page).toContain("{!zeroDeposit && (");
  });
});
