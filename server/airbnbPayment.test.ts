/**
 * Test E — Airbnb payment: NO deposit, ONE full payment.
 *
 * What this file pins:
 *   - the rule lives in one place (depositRateFor) and every quote path reads
 *     it: public quote, catalog quote, public booking, deposit link, admin
 *     booking — an Airbnb job never prices a deposit, whatever the dial says;
 *   - an Airbnb booking confirms on submit with no Stripe step, no
 *     pending_deposit state and no payment row;
 *   - completion bills the FULL amount once, the Stripe line is the service
 *     (not "remaining balance"), and the card payment is recorded as one
 *     "full" payment; a cash settlement is the same one payment;
 *   - the payment position reads Unpaid → Paid / Paid in Cash, nothing else;
 *   - a residential booking beside it keeps its deposit (positive control).
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
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetBalanceInvoice = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockSettleUnpaidInvoice = vi.fn();
const mockCreatePayment = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockConfirmUnpaid = vi.fn();
const mockRecordOffline = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
    getBalanceInvoiceForBooking: (...a: unknown[]) => mockGetBalanceInvoice(...a),
    createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
    updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
    settleUnpaidInvoice: (...a: unknown[]) => mockSettleUnpaidInvoice(...a),
    flagInvoiceRefundNeeded: vi.fn().mockResolvedValue(true),
    createPayment: (...a: unknown[]) => mockCreatePayment(...a),
    recordOfflineInvoicePayment: (...a: unknown[]) => mockRecordOffline(...a),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
    incrementCouponRedemptions: vi.fn(),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    claimBookingCompletedBySettlement: vi.fn().mockResolvedValue(false),
    claimTipRequestEmail: vi.fn().mockResolvedValue(false),
    getConnectedPropertyById: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./property", () => ({ lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a) }));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a), expire: vi.fn().mockResolvedValue({}) } },
  }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { calculateCatalogQuote, calculateQuote, DEFAULT_PRICING, depositRateFor, isDepositFree } from "@shared/pricing";
import { derivePaymentStatus } from "@shared/paymentStatus";
import { createAdminBooking } from "./adminBooking";
import { _resetRateLimits } from "./antiSpam";
import {
  applyBalancePayment,
  balanceDueForBooking,
  buildStripeLineItems,
  createBalanceCheckoutSession,
  issueBalanceForCompletedBooking,
} from "./balance";
import { settlementKind } from "./balanceRules";
import { payBookingInCash } from "./cashPayment";
import { __resetTransporter } from "./emails";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const TOKEN = "a".repeat(48);
const publicCtx = (): TrpcContext => ({
  user: null,
  req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
  res: {} as TrpcContext["res"],
});
const bookingCaller = () => bookingRouter.createCaller(publicCtx());
const payCaller = () => depositLinkRouter.createCaller(publicCtx());
const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

const CUSTOMER = { id: 7, firstName: "Hank", lastName: "Rivera", email: "hank@example.com", phone: "2105550199", preferredLocale: "en" };

const quoteInput = (type: "airbnb" | "residential") => ({
  type,
  bedrooms: 2,
  bathrooms: 1,
  sqft: 1200,
  extras: [] as never[],
  frequency: "onetime" as const,
});

const CREATE_INPUT = {
  quote: quoteInput("airbnb"),
  date: OPEN_MONDAY,
  time: "11:00",
  firstName: "Hank",
  lastName: "Rivera",
  email: "hank@example.com",
  phone: "2105550199",
  address: "2208 Schriber St",
  propertyType: "house" as const,
  city: "San Antonio",
  zip: "78201",
  locale: "en" as const,
};

/** An Airbnb booking row: never a deposit, never a Stripe intent. */
const airbnbRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-BNB01",
  customerId: 7,
  kind: "self_serve",
  serviceType: "airbnb",
  frequency: "onetime",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "11:00",
  bedrooms: 2,
  bathrooms: 1,
  sqft: 1200,
  extras: "[]",
  addressLine: "2208 Schriber St",
  city: "San Antonio",
  zip: "78201",
  notes: null,
  locale: "en",
  totalAmount: 113,
  totalAmountCents: 11300,
  depositAmount: 0,
  depositAmountCents: 0,
  stripePaymentIntentId: null,
  status: "confirmed",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: 2,
  verifiedSqft: null,
  sqftMismatch: false,
  holdMinutes: null,
  payToken: null,
  payTokenExpiresAt: null,
  adminProvided: null,
  paymentPreference: null,
  cashChosenAt: null,
  createdAt: new Date(),
  ...overrides,
});

const INVOICE = {
  id: 501,
  number: "INV-BNB-01",
  bookingId: 99,
  customerId: 7,
  amount: 113,
  amountCents: 11300,
  kind: "balance" as const,
  status: "sent" as const,
  payToken: "tok_bnb",
  stripeSessionId: "cs_bnb",
  stripePaymentIntentId: null,
  paidVia: null,
  paidMethod: null,
  paymentPreference: null,
  serviceType: "airbnb",
  serviceDate: OPEN_MONDAY,
  lineItems: null,
  refundNeeded: false,
  linkExpiresAt: new Date("2099-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetSetting.mockResolvedValue(null); // defaults → 20% deposit dial
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockFindOrCreateCustomer.mockResolvedValue(7);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/pay" });
  mockGetBookingById.mockResolvedValue(airbnbRow());
  mockGetBookingByPayToken.mockResolvedValue(undefined);
  mockConfirmUnpaid.mockResolvedValue(true);
  mockGetInvoiceById.mockResolvedValue(INVOICE);
  mockGetBalanceInvoice.mockResolvedValue(undefined);
  mockCreateInvoice.mockResolvedValue(501);
  mockSettleUnpaidInvoice.mockResolvedValue(true);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => vi.unstubAllEnvs());

describe("the rule: Airbnb never prices a deposit", () => {
  it("depositRateFor is 0 for airbnb at any dial, and the dial for everyone else", () => {
    expect(isDepositFree("airbnb")).toBe(true);
    expect(isDepositFree("residential")).toBe(false);
    expect(depositRateFor("airbnb", DEFAULT_PRICING)).toBe(0);
    expect(depositRateFor("airbnb", { ...DEFAULT_PRICING, depositRate: 0.5 })).toBe(0);
    expect(depositRateFor("residential", DEFAULT_PRICING)).toBe(0.2);
    expect(depositRateFor("deep", { ...DEFAULT_PRICING, depositRate: 0.5 })).toBe(0.5);
  });

  it("the customer-facing previews price the deposit through the same rule", () => {
    // The deposit-link page previews its own deposit; a preview at the raw
    // dial would offer an Airbnb host a deposit the server refuses to mint.
    const payPage = source("../client/src/pages/PayDeposit.tsx");
    expect(payPage).toContain("depositRateFor(booking.quote.type, booking.pricing)");
    expect(payPage).not.toContain("booking.pricing.depositRate)");
    // The booking page reads breakdown.deposit, which calculateQuote already prices per type.
    expect(source("../client/src/pages/Booking.tsx")).toContain("const deposit = breakdown.deposit;");
  });

  it("both quote engines follow it: an Airbnb quote has a price and a $0 deposit", () => {
    const airbnb = calculateQuote(quoteInput("airbnb"));
    expect(airbnb.total).toBeGreaterThan(0);
    expect(airbnb.deposit).toBe(0);
    const catalog = calculateCatalogQuote(quoteInput("airbnb"), 2500);
    expect(catalog.totalCents).toBeGreaterThan(2500);
    expect(catalog.depositCents).toBe(0);
    expect(catalog.deposit).toBe(0);
    // Positive control: the same home as a residential job still deposits 20%.
    const residential = calculateQuote(quoteInput("residential"));
    expect(residential.total).toBe(airbnb.total);
    expect(residential.deposit).toBeCloseTo(residential.total * 0.2, 2);
    expect(calculateCatalogQuote(quoteInput("residential"), 2500).depositCents).toBeGreaterThan(0);
  });
});

describe("Test E — an Airbnb booking takes no deposit and confirms on submit", () => {
  it("public booking: confirmed, $0 deposit, no Stripe session, no payment row", async () => {
    const result = await bookingCaller().create(CREATE_INPUT);
    expect(written().serviceType).toBe("airbnb");
    expect(written().status).toBe("confirmed");
    expect(written().depositAmount).toBe(0);
    expect(written().depositAmountCents).toBe(0);
    expect(written().totalAmount).toBe(112.99);
    expect(written().holdMinutes).toBeUndefined();
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
    expect(result.confirmed).toBe(true);
    if (result.confirmed) expect(result.booking.deposit).toBe(0);
  });

  it("the confirmation email promises no deposit and one payment after the cleaning", async () => {
    await bookingCaller().create(CREATE_INPUT);
    const customerEmail = sentEmails().find(e => e.to === "hank@example.com");
    expect(customerEmail?.text).toContain("No deposit required — payment is due at completion.");
    expect(customerEmail?.text).not.toContain("Deposit paid today");
  });

  it("a residential booking made the same way still runs the deposit flow (positive control)", async () => {
    const result = await bookingCaller().create({ ...CREATE_INPUT, quote: quoteInput("residential") });
    expect(written().status).toBe("pending_deposit");
    expect(Number(written().depositAmount)).toBeGreaterThan(0);
    expect(mockSessionCreate).toHaveBeenCalledOnce();
    expect(result.confirmed).toBe(false);
  });

  it("the deposit link prices an Airbnb job at $0 deposit and ends in CONFIRM", async () => {
    const link = airbnbRow({
      kind: "admin",
      status: "pending_deposit",
      payToken: TOKEN,
      payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
      adminProvided: "service,size,address,slot",
      holdMinutes: 24 * 60,
    });
    mockGetBookingByPayToken.mockResolvedValue(link);
    mockGetBookingById.mockResolvedValue(link);
    const page = await payCaller().get({ token: TOKEN });
    expect(page.booking?.deposit).toBe(0);
    expect(page.booking?.depositFree).toBe(true);
    // The CONFIRM ending works because the server prices the deposit at 0 too.
    const result = await payCaller().confirm({ token: TOKEN, extras: [] });
    expect(result.confirmed).toBe(true);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("an admin-created Airbnb booking estimates no deposit", async () => {
    const result = await createAdminBooking(
      {
        firstName: "Hank",
        phone: "2105550199",
        serviceType: "airbnb",
        sqft: 1200,
        date: OPEN_MONDAY,
        time: "11:00",
        address: "2208 Schriber St",
        city: "San Antonio",
        zip: "78201",
      },
      ORIGIN
    );
    expect(result.basePrice).toBe(112.99);
    expect(result.depositEstimate).toBe(0);
    expect(written().depositAmount).toBe(0);
    // And the same phone lead as a residential job keeps its 20% (positive control).
    mockCreateBooking.mockClear();
    const residential = await createAdminBooking(
      { firstName: "Hank", phone: "2105550199", serviceType: "residential", sqft: 1200, address: "1 Main St", city: "San Antonio", zip: "78201" },
      ORIGIN
    );
    expect(residential.depositEstimate).toBe(23);
  });
});

describe("Test E — one full payment after the cleaning", () => {
  it("completion bills the full amount, named by service and date, and knows no deposit was taken", async () => {
    mockGetBookingById.mockResolvedValue(airbnbRow({ status: "completed" }));
    expect(balanceDueForBooking(airbnbRow())).toBe(113);
    const result = await issueBalanceForCompletedBooking(99, ORIGIN);
    expect(result.outcome).toBe("awaiting_approval");
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 113, amountCents: 11300, kind: "balance", serviceType: "airbnb", serviceDate: OPEN_MONDAY })
    );
    expect(settlementKind(airbnbRow())).toBe("full");
    expect(settlementKind({ depositAmount: 23, depositAmountCents: 2300, stripePaymentIntentId: "pi_1" })).toBe("balance");
  });

  it("the Stripe checkout is the service itself, not a 'remaining balance', with no invoice number", async () => {
    await createBalanceCheckoutSession({
      invoice: INVOICE,
      booking: airbnbRow({ status: "completed" }),
      customerEmail: "hank@example.com",
      origin: ORIGIN,
    });
    const params = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { unit_amount: number; product_data: { name: string; description: string } } }[];
      metadata: Record<string, string>;
    };
    expect(params.line_items).toHaveLength(1);
    expect(params.line_items[0]!.price_data.unit_amount).toBe(11300);
    expect(params.line_items[0]!.price_data.product_data.name).toBe("Airbnb Cleaning");
    expect(params.line_items[0]!.price_data.product_data.description).toContain("Airbnb Cleaning — ");
    expect(params.line_items[0]!.price_data.product_data.description).toContain("Booking GFC-BNB01");
    expect(params.line_items[0]!.price_data.product_data.description).not.toContain("INV-");
    // The number still rides in metadata, where the owner's tooling reads it.
    expect(params.metadata.invoice_number).toBe("INV-BNB-01");
    // A deposit-backed job keeps its "Remaining balance" line (positive control).
    const lines = buildStripeLineItems({ amount: 90, items: [], serviceName: "Residential Cleaning", locale: "en", description: "x" });
    expect(lines[0]!.price_data!.product_data!.name).toBe("Remaining balance — Residential Cleaning");
  });

  it("paying online records ONE full payment for the whole amount", async () => {
    mockGetBookingById.mockResolvedValue(airbnbRow({ status: "completed" }));
    const result = await applyBalancePayment(501, "pi_full_1");
    expect(result.outcome).toBe("paid");
    expect(mockSettleUnpaidInvoice).toHaveBeenCalledWith(
      501,
      expect.objectContaining({ paidVia: "stripe", paidMethod: "card", stripePaymentIntentId: "pi_full_1" })
    );
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "full", amount: 113, amountCents: 11300, method: "card", source: "stripe", status: "succeeded" })
    );
  });

  it("paying in cash is the same one payment, recorded as cash", async () => {
    mockGetBookingById.mockResolvedValue(airbnbRow({ status: "completed" }));
    mockGetBalanceInvoice.mockResolvedValue(INVOICE);
    mockRecordOffline.mockResolvedValue({
      outcome: "recorded",
      invoice: { ...INVOICE, status: "paid", paidVia: "manual", paidMethod: "cash" },
      paymentId: 71,
      tipPaymentId: null,
      bookingCompleted: false,
      paidAt: new Date("2026-09-28T12:00:00Z"),
    });
    const result = await payBookingInCash({ bookingId: 99, recordedByUserId: 1, origin: ORIGIN });
    expect(result).toMatchObject({ outcome: "paid", amount: 113, amountCents: 11300 });
    expect(mockRecordOffline).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 501, amountCents: 11300, method: "cash", paymentKind: "full", tipAmountCents: 0 })
    );
  });

  it("the position reads Unpaid → Paid / Paid in Cash — no deposit words anywhere", () => {
    const booking = { status: "confirmed", serviceType: "airbnb", depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null };
    expect(derivePaymentStatus(booking)).toBe("unpaid");
    expect(derivePaymentStatus({ ...booking, status: "in_progress" })).toBe("unpaid");
    expect(derivePaymentStatus({ ...booking, status: "completed" })).toBe("unpaid");
    expect(derivePaymentStatus({ ...booking, status: "completed", invoice: { status: "paid", paidVia: "stripe", paidMethod: "card" } })).toBe("paid");
    expect(derivePaymentStatus({ ...booking, status: "completed", invoice: { status: "paid", paidVia: "manual", paidMethod: "cash" } })).toBe("paid_cash");
    // Feed-created turnovers are Airbnb by kind, not only by service type.
    expect(derivePaymentStatus({ ...booking, serviceType: null, kind: "ical_auto" })).toBe("unpaid");
    // A residential job with nothing collected up front still says what it means.
    expect(derivePaymentStatus({ ...booking, serviceType: "residential" })).toBe("pay_after_service");
  });
});
