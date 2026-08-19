/**
 * Zero-deposit mode: the deposit rate is a dial, and 0 is a first-class
 * setting rather than a degenerate rate.
 *
 * What this file pins:
 *   - the config accepts 0 and depositFor(_, 0) is 0, never rounded up to $1;
 *   - a public booking at rate 0 confirms on submit — no Stripe session, no
 *     pending_deposit state, no payment row, and the confirmation email drops
 *     the "deposit paid" line for "due at completion";
 *   - the progressive link ends in CONFIRM: completing it confirms the booking
 *     directly, once, with the owner's completed-link email intact — and the
 *     confirm path refuses to fire while a real deposit is owed;
 *   - in-flight bookings keep the terms they were created under: balance math
 *     reads the frozen row, so flipping the dial never reprices anyone;
 *   - the deposit-link email swaps its pay language for confirm language.
 */
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
const mockCreateInvoice = vi.fn();
const mockGetBalanceInvoice = vi.fn();
const mockIncrementCoupon = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
    getCouponByCode: (...a: unknown[]) => mockGetCouponByCode(...a),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: vi.fn().mockResolvedValue({
      id: 7,
      firstName: "Maria",
      lastName: "Lopez",
      email: "maria@example.com",
      phone: "2105550134",
    }),
    expireStaleBookingsForSlot: (...a: unknown[]) => mockExpireForSlot(...a),
    confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
    createPayment: (...a: unknown[]) => mockCreatePayment(...a),
    createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
    getBalanceInvoiceForBooking: (...a: unknown[]) => mockGetBalanceInvoice(...a),
    getInvoiceById: vi.fn().mockResolvedValue(undefined),
    incrementCouponRedemptions: (...a: unknown[]) => mockIncrementCoupon(...a),
    isSlotTakenError: actual.isSlotTakenError,
    setSetting: vi.fn().mockResolvedValue(undefined),
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

import {
  DEFAULT_PRICING,
  depositFor,
  PRICING_SETTING_KEY,
  serializePricingConfig,
  validatePricingConfig,
  calculateQuote,
} from "@shared/pricing";
import { _resetRateLimits } from "./antiSpam";
import { balanceDueForBooking, issueBalanceForCompletedBooking } from "./balance";
import { computeBalanceDue } from "./balanceRules";
import { buildCustomerConfirmation, buildDepositLinkEmail, __resetTransporter } from "./emails";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "e".repeat(48);

/** The live config with the deposit dial turned to zero. */
const ZERO_RATE_CONFIG = serializePricingConfig({ ...DEFAULT_PRICING, depositRate: 0 });

const publicCtx = (): TrpcContext => ({
  user: null,
  req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
  res: {} as TrpcContext["res"],
});

const bookingCaller = () => bookingRouter.createCaller(publicCtx());
const payCaller = () => depositLinkRouter.createCaller(publicCtx());

/** The row createBooking was called with. */
const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;

/** Messages actually handed to SMTP, oldest first. */
const sentEmails = () =>
  mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string; html?: string });

const CREATE_INPUT = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [] as never[],
    frequency: "onetime" as const,
  },
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

/** A complete admin-link row priced under the zero-rate config. */
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
  depositAmount: 0,
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
  mockGetSetting.mockImplementation(async (key: unknown) =>
    key === PRICING_SETTING_KEY ? ZERO_RATE_CONFIG : null
  );
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetCouponByCode.mockResolvedValue(undefined);
  mockFindOrCreateCustomer.mockResolvedValue(7);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockExpireForSlot.mockResolvedValue(0);
  mockConfirmUnpaid.mockResolvedValue(true);
  mockCreateInvoice.mockResolvedValue(501);
  mockGetBalanceInvoice.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The dial itself.
// ---------------------------------------------------------------------------

describe("deposit rate 0 in the pricing engine", () => {
  it("the config schema accepts 0 — it is a mode, not an error", () => {
    const result = validatePricingConfig(ZERO_RATE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.depositRate).toBe(0);
  });

  it("still refuses rates outside 0–1", () => {
    expect(validatePricingConfig(serializePricingConfig({ ...DEFAULT_PRICING, depositRate: -0.1 })).ok).toBe(false);
    expect(validatePricingConfig(serializePricingConfig({ ...DEFAULT_PRICING, depositRate: 1.5 })).ok).toBe(false);
  });

  it("depositFor is exactly 0 at rate 0 — never rounded up to the $1 floor", () => {
    expect(depositFor(250, 0)).toBe(0);
    expect(depositFor(1, 0)).toBe(0);
    // The floor still protects real rates from a $0 Stripe session.
    expect(depositFor(2, 0.01)).toBe(1);
    expect(depositFor(250, 0.2)).toBe(50);
  });

  it("calculateQuote's deposit follows the dial", () => {
    const quote = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" },
      { ...DEFAULT_PRICING, depositRate: 0 }
    );
    expect(quote.deposit).toBe(0);
    expect(quote.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Public booking at rate 0.
// ---------------------------------------------------------------------------

describe("public booking at rate 0 confirms without Stripe", () => {
  it("inserts the booking already confirmed, with a $0 deposit frozen on the row", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "confirmed", adminProvided: null })
    );
    const result = await bookingCaller().create(CREATE_INPUT);
    expect(written().status).toBe("confirmed");
    expect(written().depositAmount).toBe(0);
    expect(Number(written().totalAmount)).toBeGreaterThan(0);
    expect(result.confirmed).toBe(true);
    expect(result.checkoutUrl).toBeNull();
    if (result.confirmed) {
      expect(result.booking.deposit).toBe(0);
      expect(result.booking.total).toBe(written().totalAmount);
      expect(result.booking.customerFirstName).toBe("Maria");
    }
  });

  it("never touches Stripe and records no payment row", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "confirmed", adminProvided: null })
    );
    await bookingCaller().create(CREATE_INPUT);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("sends the confirmation emails immediately, with no deposit-paid line", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "confirmed", adminProvided: null })
    );
    await bookingCaller().create(CREATE_INPUT);
    const customerEmail = sentEmails().find(e => e.to === "maria@example.com");
    expect(customerEmail).toBeDefined();
    expect(customerEmail!.subject).toContain("confirmed");
    expect(customerEmail!.text).not.toContain("Deposit paid today");
    expect(customerEmail!.text).toContain("No deposit required — payment is due at completion.");
  });

  it("still redeems the coupon the booking was made with", async () => {
    mockGetCouponByCode.mockResolvedValue({
      id: 3,
      code: "SAVE10",
      active: true,
      percentOff: 10,
      amountOff: null,
      expiresAt: null,
      maxRedemptions: null,
      timesRedeemed: 0,
    });
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "confirmed", adminProvided: null, couponCode: "SAVE10" })
    );
    await bookingCaller().create({ ...CREATE_INPUT, couponCode: "SAVE10" });
    expect(mockIncrementCoupon).toHaveBeenCalledWith(3);
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("a nonzero rate keeps the original flow: pending_deposit plus a Stripe session", async () => {
    mockGetSetting.mockResolvedValue(null); // defaults → 20%
    const result = await bookingCaller().create(CREATE_INPUT);
    expect(written().status).toBe("pending_deposit");
    expect(Number(written().depositAmount)).toBeGreaterThan(0);
    expect(mockSessionCreate).toHaveBeenCalledOnce();
    expect(result.checkoutUrl).toBe("https://stripe.test/pay");
    expect(result.confirmed).toBe(false);
  });

  it("every scheduling rule still applies — a taken slot is refused before anything is created", async () => {
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "confirmed", createdAt: new Date() },
    ]);
    await expect(bookingCaller().create(CREATE_INPUT)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The progressive link's CONFIRM ending.
// ---------------------------------------------------------------------------

describe("the deposit link ends in CONFIRM when the deposit is 0", () => {
  it("the page payload prices the deposit at 0", async () => {
    const result = await payCaller().get({ token: TOKEN });
    expect(result.state).toBe("awaiting_payment");
    expect(result.booking?.deposit).toBe(0);
    expect(result.booking?.total).toBeGreaterThan(0);
  });

  it("confirm claims the booking, records no payment, and mints no session", async () => {
    const result = await payCaller().confirm({ token: TOKEN, extras: [] });
    expect(result).toEqual({ confirmed: true, reference: "GFC-LINK1" });
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ slotConflict: false }));
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
    // The row froze its terms: totals written, deposit 0.
    const patches = Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as object)) as Record<string, unknown>;
    expect(patches.depositAmount).toBe(0);
    expect(Number(patches.totalAmount)).toBeGreaterThan(0);
  });

  it("tells the owner their link was completed", async () => {
    await payCaller().confirm({ token: TOKEN, extras: [] });
    const ownerEmail = sentEmails().find(e => e.subject.includes("link completed"));
    expect(ownerEmail).toBeDefined();
    expect(ownerEmail!.text).toContain("confirmed their booking (no deposit required)");
  });

  it("a double-tapped CONFIRM confirms exactly once", async () => {
    await payCaller().confirm({ token: TOKEN, extras: [] });
    const emailsAfterFirst = sentEmails().length;
    // The second tap loses the conditional claim and does nothing further.
    mockConfirmUnpaid.mockResolvedValue(false);
    await payCaller().confirm({ token: TOKEN, extras: [] });
    expect(sentEmails().length).toBe(emailsAfterFirst);
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("refuses to confirm while a real deposit is owed", async () => {
    mockGetSetting.mockResolvedValue(null); // defaults → 20%
    await expect(payCaller().confirm({ token: TOKEN, extras: [] })).rejects.toThrow(/deposit is required/i);
    expect(mockConfirmUnpaid).not.toHaveBeenCalled();
  });

  it("refuses an incomplete link, exactly like the pay button", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ serviceType: null, adminProvided: null }));
    await expect(payCaller().confirm({ token: TOKEN, extras: [] })).rejects.toThrow(/still missing/i);
  });

  it("a dead link is refused — expiry semantics are unchanged", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ payTokenExpiresAt: new Date(Date.now() - 60_000) })
    );
    await expect(payCaller().confirm({ token: TOKEN, extras: [] })).rejects.toThrow(/expired/i);
  });
});

// ---------------------------------------------------------------------------
// Frozen terms and balance math.
// ---------------------------------------------------------------------------

describe("in-flight bookings keep the terms they were created under", () => {
  it("balance math reads the frozen row, not the live dial", () => {
    // Booked under 20% with the deposit captured; the dial is at 0 now.
    expect(
      balanceDueForBooking({ totalAmount: 200, depositAmount: 40, stripePaymentIntentId: "pi_1" })
    ).toBe(160);
    // Booked under 0; the dial has moved back to 20%.
    expect(
      balanceDueForBooking({ totalAmount: 200, depositAmount: 0, stripePaymentIntentId: null })
    ).toBe(200);
    expect(computeBalanceDue({ totalAmount: 200, depositAmount: 0 })).toBe(200);
  });

  it("a completed zero-deposit booking bills its full price at completion", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ kind: "self_serve", status: "completed", depositAmount: 0, totalAmount: 250, stripePaymentIntentId: null })
    );
    const result = await issueBalanceForCompletedBooking(99, ORIGIN);
    expect(result.outcome).toBe("awaiting_approval");
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 250, status: "awaiting_approval" })
    );
  });
});

// ---------------------------------------------------------------------------
// Email copy.
// ---------------------------------------------------------------------------

describe("email copy at deposit 0", () => {
  const base = {
    reference: "GFC-TEST1",
    serviceName: "Residential Cleaning",
    date: OPEN_MONDAY,
    time: "10:00",
    frequencyLabel: "One-time",
    extras: [],
    total: 150,
    customerName: "Maria",
    customerEmail: "maria@example.com",
  };

  it("the confirmation swaps the deposit lines for due-at-completion, in both languages", () => {
    const en = buildCustomerConfirmation({ ...base, deposit: 0, locale: "en" });
    expect(en.body).not.toContain("Deposit paid today");
    expect(en.body).toContain("No deposit required — payment is due at completion.");
    const es = buildCustomerConfirmation({ ...base, deposit: 0, locale: "es" });
    expect(es.body).not.toContain("Depósito pagado hoy");
    expect(es.body).toContain("No se requiere depósito");
    // And a real deposit keeps the original lines.
    const paid = buildCustomerConfirmation({ ...base, deposit: 30, locale: "en" });
    expect(paid.body).toContain("Deposit paid today: $30 USD");
  });

  it("the deposit-link email asks for a confirmation, not a payment", () => {
    const email = buildDepositLinkEmail({
      reference: "GFC-TEST1",
      serviceName: "Residential Cleaning",
      date: OPEN_MONDAY,
      time: "10:00",
      customerName: "Maria",
      customerEmail: "maria@example.com",
      basePrice: 150,
      deposit: 0,
      payUrl: `${ORIGIN}/pay/deposit/${TOKEN}`,
      expiresOn: "2026-08-30",
      locale: "en",
    });
    expect(email.subject).toContain("confirm it online");
    expect(email.subject).not.toContain("deposit");
    expect(email.html).toContain("Finish &amp; confirm");
    expect(email.html).not.toContain("pay your deposit");
    expect(email.body).toContain("None required");
    expect(email.body).not.toContain("$0");
  });
});
