/**
 * Admin New booking — custom price.
 *
 * The owner can type the price they agreed with a customer in place of the
 * catalog figure. It rides the same price-lock machinery as a grandfathered
 * rate (PR #21): a flat base for the booked service, extras on top, the
 * deposit derived from the total, the balance invoice from what was booked.
 * This file pins:
 *   - the override is a lock with source "custom", read off the booking's own
 *     columns, and it outranks the customer's standing rate;
 *   - admin.createBooking takes it only with a service, a positive amount in
 *     cents under the same cap every other amount has, and a reason — and
 *     records who set it;
 *   - the deposit link keeps honouring it on every repricing, extras itemize
 *     on top, and the balance invoice is the booked total less the deposit;
 *   - the Details row, the admin list and the owner's notification say
 *     "custom price" with the reason, never "grandfathered";
 *   - changing the rate by hand replaces it; and the public form cannot send
 *     one — an unknown key is dropped and the catalog prices the booking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetBookingByPayToken = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockGetCustomerById = vi.fn();
const mockListGrandfathered = vi.fn();
const mockListBookings = vi.fn();
const mockGetCustomersByIds = vi.fn();
const mockGetUsersByIds = vi.fn();
const mockGetBalanceInvoice = vi.fn();
const mockCreateInvoice = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    listGrandfatheredCustomers: (...a: unknown[]) => mockListGrandfathered(...a),
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    getCustomersByIds: (...a: unknown[]) => mockGetCustomersByIds(...a),
    getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
    getBalanceInvoiceForBooking: (...a: unknown[]) => mockGetBalanceInvoice(...a),
    createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
    updateInvoice: vi.fn().mockResolvedValue(undefined),
    findCustomersByContact: vi.fn().mockResolvedValue([]),
    listCompletedBookingsForCustomers: vi.fn().mockResolvedValue([]),
    listInvoiceStatesForBookings: vi.fn().mockResolvedValue([]),
    listBalanceInvoicesForBookings: vi.fn().mockResolvedValue([]),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    recordEmailAttemptReturningId: vi.fn().mockResolvedValue(1),
  };
});

vi.mock("./property", async () => {
  const actual = await vi.importActual<typeof import("./property")>("./property");
  return { ...actual, lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a) };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: vi.fn().mockResolvedValue(true) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { withoutIncludedAddons } from "@shared/addonRules";
import { dollarsToCents } from "@shared/money";
import { calculateQuote, DEFAULT_PRICING, depositFor, depositRateFor, EXTRA_IDS } from "@shared/pricing";
import { lockFromBookingOverride, lockFromCustomer } from "@shared/priceLock";
import { _resetRateLimits } from "./antiSpam";
import { issueBalanceForCompletedBooking } from "./balance";
import { __resetTransporter, buildOwnerNotification } from "./emails";
import { grandfatheredColumns, lockForBooking } from "./priceLock";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const TOKEN = "f".repeat(48);
const REASON = "Quoted on the phone";

/** The original client with a standing residential rate. */
const MARIA = {
  id: 41,
  firstName: "Maria del Mar",
  lastName: "Prado",
  email: "maria.prado@example.com",
  phone: "2105550199",
  address: "1200 Barton Springs Road",
  city: "San Antonio",
  zip: "78205",
  preferredLocale: "es",
  notes: null,
  grandfatheredPriceCents: 8500,
  grandfatheredServiceType: "residential",
  grandfatheredNote: "Original client",
  grandfatheredAt: new Date("2026-09-28T00:00:00Z"),
  grandfatheredByUserId: 1,
};

/** A new lead with no rate of their own. */
const HANK = {
  id: 7,
  firstName: "Hank",
  lastName: "Hill",
  email: "hank@example.com",
  phone: "2105550123",
  address: "84 Rainey St",
  city: "San Antonio",
  zip: "78209",
  preferredLocale: "en",
  notes: null,
  grandfatheredPriceCents: null,
  grandfatheredServiceType: null,
  grandfatheredNote: null,
  grandfatheredAt: null,
  grandfatheredByUserId: null,
};

const DEEP_3000 = { type: "deep" as const, bedrooms: 2, bathrooms: 1, sqft: 3000, extras: [] as string[], frequency: "onetime" as const };
/** The catalog figure the override replaces: a deep clean at 3,000 sq ft. */
const CATALOG = calculateQuote(DEEP_3000, DEFAULT_PRICING).total;
/** What the owner agreed instead — deliberately not a catalog figure, with cents. */
const AGREED = 389.5;
const AGREED_CENTS = 38950;
const DEEP_RATE = depositRateFor("deep", DEFAULT_PRICING);
/** A real extra the customer can add to a deep clean on their link. */
const EXTRA = withoutIncludedAddons("deep", EXTRA_IDS)[0]!;

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const payCaller = () =>
  depositLinkRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const patched = () => Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>));

/** An admin-created booking as the deposit link finds it: Hank's deep clean at the agreed price. */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-CP1",
  customerId: 7,
  grandfatheredCustomerId: null,
  grandfatheredBaseCents: null,
  customPriceCents: AGREED_CENTS,
  customPriceReason: REASON,
  customPriceByUserId: 1,
  customPriceAt: new Date("2026-11-09T15:00:00Z"),
  serviceType: "deep",
  frequency: "onetime",
  scheduledDate: null,
  scheduledTime: null,
  bedrooms: 2,
  bathrooms: 1,
  sqft: 3000,
  extras: "[]",
  addonsAmountCents: 0,
  addressLine: "84 Rainey St",
  unitNumber: null,
  propertyType: "house",
  city: "San Antonio",
  zip: "78209",
  notes: null,
  locale: "en",
  totalAmount: AGREED,
  totalAmountCents: AGREED_CENTS,
  depositAmount: depositFor(AGREED, DEEP_RATE),
  depositAmountCents: dollarsToCents(depositFor(AGREED, DEEP_RATE)),
  discountApplied: 0,
  discountAppliedCents: 0,
  status: "pending_deposit",
  couponCode: null,
  estimatedHours: null,
  verifiedSqft: null,
  sqftMismatch: false,
  stripePaymentIntentId: null,
  paymentPreference: null,
  kind: "admin",
  holdMinutes: 24 * 60,
  payToken: TOKEN,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  adminProvided: "service,size",
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockListGrandfathered.mockResolvedValue([MARIA]);
  mockGetCustomerById.mockImplementation(async (id: number) => (id === 41 ? MARIA : id === 7 ? HANK : undefined));
  mockGetCustomersByIds.mockResolvedValue([MARIA, HANK]);
  mockGetUsersByIds.mockResolvedValue([{ id: 1, name: "Peter", email: "peter@example.com" }]);
  mockFindOrCreateCustomer.mockImplementation(async (data: { customerId?: number }) => data.customerId ?? 7);
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockGetBalanceInvoice.mockResolvedValue(undefined);
  mockCreateInvoice.mockResolvedValue(501);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe("the custom price is a lock read off the booking", () => {
  it("reads a real one, and only a real one", () => {
    expect(lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: AGREED_CENTS, customPriceReason: REASON })).toEqual({
      basePriceCents: AGREED_CENTS,
      serviceType: "deep",
      customerId: 7,
      customerName: "",
      source: "custom",
      reason: REASON,
    });
    // No service, no price, a zero, or fractional cents: no lock.
    expect(lockFromBookingOverride({ customerId: 7, serviceType: null, customPriceCents: AGREED_CENTS, customPriceReason: REASON })).toBeNull();
    expect(lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: null, customPriceReason: null })).toBeNull();
    expect(lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: 0, customPriceReason: REASON })).toBeNull();
    expect(lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: 389.5, customPriceReason: REASON })).toBeNull();
    expect(lockFromBookingOverride(null)).toBeNull();
  });

  it("prices exactly as a grandfathered rate does: flat base, no recurring discount, extras on top", () => {
    const lock = lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: AGREED_CENTS, customPriceReason: REASON });
    const flat = calculateQuote({ ...DEEP_3000, frequency: "biweekly" }, DEFAULT_PRICING, lock);
    expect(flat.base).toBe(AGREED);
    expect(flat.discount).toBe(0);
    expect(flat.total).toBe(AGREED);
    const withExtra = calculateQuote({ ...DEEP_3000, extras: [EXTRA] }, DEFAULT_PRICING, lock);
    expect(withExtra.extrasTotal).toBeGreaterThan(0);
    expect(withExtra.total).toBe(AGREED + withExtra.extrasTotal);
    // And a lock for another service prices nothing.
    expect(calculateQuote({ ...DEEP_3000, type: "residential" }, DEFAULT_PRICING, lock).grandfathered).toBe(false);
  });

  it("is not recorded in the grandfathered columns", () => {
    const lock = lockFromBookingOverride({ customerId: 7, serviceType: "deep", customPriceCents: AGREED_CENTS, customPriceReason: REASON });
    expect(grandfatheredColumns(lock)).toEqual({ grandfatheredBaseCents: null, grandfatheredCustomerId: null });
    expect(grandfatheredColumns(lockFromCustomer(MARIA))).toEqual({ grandfatheredBaseCents: 8500, grandfatheredCustomerId: 41 });
  });

  it("outranks the customer's standing rate on the booking it was set for, and only there", async () => {
    // Maria's booking with an agreed price: the agreed price wins.
    const custom = await lockForBooking(
      { customerId: 41, grandfatheredCustomerId: null, serviceType: "residential", customPriceCents: 20000, customPriceReason: "Repeat customer" },
      "residential"
    );
    expect(custom).toMatchObject({ source: "custom", basePriceCents: 20000, reason: "Repeat customer" });
    // Her other bookings keep her standing rate.
    expect(await lockForBooking({ customerId: 41, grandfatheredCustomerId: null }, "residential")).toMatchObject({
      source: "grandfathered",
      basePriceCents: 8500,
    });
    // A price agreed for a deep clean says nothing about a residential one.
    expect(
      await lockForBooking(
        { customerId: 7, grandfatheredCustomerId: null, serviceType: "deep", customPriceCents: 20000, customPriceReason: "x" },
        "residential"
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// admin.createBooking
// ---------------------------------------------------------------------------

describe("admin.createBooking with a custom price", () => {
  const lead = { firstName: "Hank", phone: "2105550123", serviceType: "deep" as const, sqft: 3000 };

  it("off, today's behaviour: the catalog prices the booking and no custom columns are written", async () => {
    const result = await adminCaller().createBooking(lead);
    expect(result.basePrice).toBe(CATALOG);
    expect(result.customPrice).toBeNull();
    expect(written()).toMatchObject({ totalAmount: CATALOG, customPriceCents: null, customPriceReason: null, customPriceByUserId: null, customPriceAt: null });
  });

  it("on: the agreed figure is the base price, the deposit derives from it, and the booking records it with its author", async () => {
    const result = await adminCaller().createBooking({ ...lead, customPrice: { amount: AGREED, reason: `  ${REASON} ` } });
    expect(result.basePrice).toBe(AGREED);
    expect(result.deposit).toBe(depositFor(AGREED, DEEP_RATE));
    expect(result.customPrice).toEqual({ basePrice: AGREED, reason: REASON });
    expect(result.grandfathered).toBeNull();
    const row = written();
    expect(row).toMatchObject({
      totalAmount: AGREED,
      depositAmount: depositFor(AGREED, DEEP_RATE),
      customPriceCents: AGREED_CENTS,
      customPriceReason: REASON,
      customPriceByUserId: 1,
      grandfatheredBaseCents: null,
      grandfatheredCustomerId: null,
    });
    expect(row.customPriceAt).toBeInstanceOf(Date);
  });

  it("the deposit-link email quotes the agreed figure", async () => {
    const result = await adminCaller().createBooking({
      ...lead,
      email: "hank@example.com",
      sendEmail: true,
      customPrice: { amount: 400, reason: REASON },
    });
    expect(result.emailSent).toBe(true);
    const sent = mockSendMail.mock.calls[0]![0] as { to: string; text: string };
    expect(sent.to).toBe("hank@example.com");
    expect(sent.text).toContain("$400 USD");
    expect(sent.text).not.toContain(`$${CATALOG.toFixed(0)} USD`);
  });

  it("outranks a grandfathered customer's standing rate for this one booking", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Maria del Mar",
      phone: "210 555 0199",
      serviceType: "residential",
      sqft: 1200,
      customPrice: { amount: 200, reason: "Agreed for the move-in week" },
    });
    expect(result.basePrice).toBe(200);
    expect(result.grandfathered).toBeNull();
    expect(result.customPrice).toEqual({ basePrice: 200, reason: "Agreed for the move-in week" });
    expect(written()).toMatchObject({
      customerId: 41,
      totalAmount: 200,
      customPriceCents: 20000,
      grandfatheredBaseCents: null,
      grandfatheredCustomerId: null,
    });
  });

  it("needs a service — the price is that service's price", async () => {
    await expect(
      adminCaller().createBooking({ firstName: "Hank", phone: "2105550123", sqft: 3000, customPrice: { amount: AGREED, reason: REASON } })
    ).rejects.toThrow(/service/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("takes a positive amount in cents under the same cap as every other amount, and a reason", async () => {
    for (const amount of [0, -50, 100000.01, 389.555]) {
      await expect(adminCaller().createBooking({ ...lead, customPrice: { amount, reason: REASON } })).rejects.toThrow();
    }
    await expect(adminCaller().createBooking({ ...lead, customPrice: { amount: AGREED, reason: "ok" } })).rejects.toThrow(/why/i);
    await expect(adminCaller().createBooking({ ...lead, customPrice: { amount: AGREED, reason: "x".repeat(501) } })).rejects.toThrow();
    expect(mockCreateBooking).not.toHaveBeenCalled();
    // The cap itself is fine, and so are cents.
    const result = await adminCaller().createBooking({ ...lead, customPrice: { amount: 100000, reason: REASON } });
    expect(result.basePrice).toBe(100000);
    expect(written().customPriceCents).toBe(10000000);
  });
});

// ---------------------------------------------------------------------------
// The deposit link and the balance invoice
// ---------------------------------------------------------------------------

describe("the deposit link honours the agreed price", () => {
  it("get previews the agreed figure and tells the page it is a custom price, not a grandfathered one", async () => {
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.priceLock).toEqual({ basePriceCents: AGREED_CENTS, serviceType: "deep", source: "custom" });
    expect(result.booking?.basePrice).toBe(AGREED);
    expect(result.booking?.total).toBe(AGREED);
    expect(result.booking?.deposit).toBe(depositFor(AGREED, DEEP_RATE));
  });

  it("keeps it through a repricing on the link, with the grandfathered columns untouched", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ sqft: null, adminProvided: "service" }));
    mockGetBookingById.mockResolvedValue(linkRow({ sqft: 3400 }));
    await payCaller().updateDetails({ token: TOKEN, sqft: 3400 });
    expect(patched()).toMatchObject({
      totalAmountCents: AGREED_CENTS,
      grandfatheredBaseCents: null,
      grandfatheredCustomerId: null,
    });
    // The custom columns are the record; the link never rewrites them.
    expect(patched()).not.toHaveProperty("customPriceCents");
  });

  it("extras itemize on top, and the deposit charged follows the new total", async () => {
    // Paying needs a complete booking: the owner held a slot for this one.
    const held = linkRow({ scheduledDate: OPEN_MONDAY, scheduledTime: "10:00", adminProvided: "service,size,time" });
    mockGetBookingByPayToken.mockResolvedValue(held);
    mockGetBookingById.mockResolvedValue(held);
    await payCaller().createSession({ token: TOKEN, extras: [EXTRA] });
    const lock = lockFromBookingOverride(linkRow() as never);
    const expected = calculateQuote({ ...DEEP_3000, extras: [EXTRA] }, DEFAULT_PRICING, lock);
    expect(expected.total).toBeGreaterThan(AGREED);
    expect(patched()).toMatchObject({ totalAmountCents: dollarsToCents(expected.total) });
    const session = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(session.line_items[0]!.price_data.unit_amount).toBe(patched().depositAmountCents);
    expect(patched().depositAmountCents).toBe(dollarsToCents(depositFor(expected.total, DEEP_RATE)));
  });
});

describe("the balance invoice derives from the booked total", () => {
  it("bills the agreed price plus extras, less the deposit already paid", async () => {
    const extraCents = dollarsToCents(calculateQuote({ ...DEEP_3000, extras: [EXTRA] }, DEFAULT_PRICING).extrasTotal);
    const totalCents = AGREED_CENTS + extraCents;
    const depositCents = dollarsToCents(depositFor(totalCents / 100, DEEP_RATE));
    mockGetBookingById.mockResolvedValue(
      linkRow({
        status: "completed",
        scheduledDate: OPEN_MONDAY,
        scheduledTime: "10:00",
        extras: JSON.stringify([EXTRA]),
        addonsAmountCents: extraCents,
        totalAmount: totalCents / 100,
        totalAmountCents: totalCents,
        depositAmount: depositCents / 100,
        depositAmountCents: depositCents,
        stripePaymentIntentId: "pi_paid",
      })
    );
    const outcome = await issueBalanceForCompletedBooking(99, ORIGIN, { notifyOwner: false });
    expect(outcome.outcome).toBe("awaiting_approval");
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "balance", amountCents: totalCents - depositCents, serviceType: "deep" })
    );
  });
});

// ---------------------------------------------------------------------------
// What the owner sees
// ---------------------------------------------------------------------------

describe("the admin list and the Details panel", () => {
  it("each booking carries its custom price with the reason and who set it", async () => {
    mockListBookings.mockResolvedValue([
      linkRow({ id: 1, status: "confirmed", scheduledDate: OPEN_MONDAY, scheduledTime: "10:00", stripePaymentIntentId: "pi_1" }),
      linkRow({ id: 2, reference: "GFC-CAT", customPriceCents: null, customPriceReason: null, customPriceByUserId: null, customPriceAt: null, totalAmount: CATALOG, totalAmountCents: dollarsToCents(CATALOG) }),
    ]);
    const [custom, catalog] = await adminCaller().bookings();
    expect(custom!.customPrice).toEqual({
      amount: AGREED,
      reason: REASON,
      setBy: "Peter",
      setAt: new Date("2026-11-09T15:00:00Z"),
    });
    expect(mockGetUsersByIds).toHaveBeenCalledWith([1]);
    expect(catalog!.customPrice).toBeNull();
  });

  it("never suggests a grandfathered rate over a price the owner typed", async () => {
    // Maria's address, her record, a reprice-able status — every signal, and still no hint.
    mockListBookings.mockResolvedValue([
      linkRow({ id: 1, customerId: 41, serviceType: "residential", status: "confirmed", addressLine: "1200 Barton Springs Rd", zip: "78205", stripePaymentIntentId: "pi_1" }),
    ]);
    const [booking] = await adminCaller().bookings();
    expect(booking!.customPrice?.amount).toBe(AGREED);
    expect(booking!.grandfatheredSuggestion).toBeNull();
    expect(booking!.grandfatheredCustomerName).toBeNull();
  });

  it("the Details row reads 'Custom price', the figure, the reason and the author — the grandfathered mark relabelled", () => {
    const details = read("../client/src/pages/admin/BookingDetails.tsx");
    expect(details).toContain("label={CUSTOM_PRICE_LABEL}");
    expect(details).toContain("{fmtMoney(row.customPrice.amount)} ({row.customPrice.reason})");
    expect(details).toContain("` — set by ${row.customPrice.setBy}`");
    const shared = read("../client/src/pages/admin/adminShared.tsx");
    expect(shared).toContain('export const CUSTOM_PRICE_LABEL = "Custom price";');
  });

  it("the New booking dialog prefills the catalog figure from the public calculator and requires a reason", () => {
    const dialog = read("../client/src/pages/admin/NewBookingDialog.tsx");
    expect(dialog).toContain("Customize price");
    expect(dialog).toContain("trpc.booking.calculate.useQuery");
    expect(dialog).toContain("setCustomPrice(catalogTotal.toFixed(2))");
    expect(dialog).toContain("customPriceReason.trim().length >= 3");
    expect(dialog).toMatch(/customPriceAmount <= 100000/);
  });

  it("the pay page tells the customer it is their agreed price, not an 'original' one", () => {
    const page = read("../client/src/pages/PayDeposit.tsx");
    expect(page).toContain('booking.priceLock?.source === "custom" ? c.agreedPrice : c.lockedPrice');
  });
});

describe("the owner's notification", () => {
  const base = {
    reference: "GFC-CP1",
    serviceName: "Deep Cleaning",
    date: OPEN_MONDAY,
    time: "10:00",
    frequencyLabel: "One-time",
    extras: [] as string[],
    total: AGREED,
    deposit: depositFor(AGREED, DEEP_RATE),
    customerName: "Hank",
    customerEmail: "hank@example.com",
    locale: "en" as const,
  };

  it("names the custom price and the reason, and never calls it grandfathered", () => {
    const { content } = buildOwnerNotification({ ...base, customPrice: { basePrice: AGREED, reason: REASON } });
    expect(content).toContain(`Price: CUSTOM PRICE — $389.50 per cleaning (${REASON}), not the catalog price`);
    expect(content).not.toContain("GRANDFATHERED");
    expect(buildOwnerNotification(base).content).not.toContain("CUSTOM PRICE");
  });

  it("the confirmation side effects read it off the booking", () => {
    const router = read("./routers/booking.ts");
    expect(router).toContain("customPrice: customPriceEmailNote(booking),");
  });
});

// ---------------------------------------------------------------------------
// Replacing it, and keeping it off the public form
// ---------------------------------------------------------------------------

describe("changing the rate by hand replaces the custom price", () => {
  it("back to the catalog clears the custom columns", async () => {
    mockGetBookingById.mockResolvedValue(linkRow({ id: 5, status: "confirmed", stripePaymentIntentId: "pi_5" }));
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: null });
    expect(result).toMatchObject({ total: CATALOG, grandfathered: null });
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        totalAmountCents: dollarsToCents(CATALOG),
        customPriceCents: null,
        customPriceReason: null,
        customPriceByUserId: null,
        customPriceAt: null,
      })
    );
  });

  it("applying a grandfathered rate does too", async () => {
    mockGetBookingById.mockResolvedValue(
      linkRow({ id: 5, customerId: 41, serviceType: "residential", sqft: 1200, status: "confirmed", stripePaymentIntentId: "pi_5" })
    );
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 });
    expect(result).toMatchObject({ total: 85, grandfathered: { customerName: "Maria del Mar Prado", basePrice: 85 } });
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ grandfatheredBaseCents: 8500, grandfatheredCustomerId: 41, customPriceCents: null, customPriceReason: null })
    );
  });
});

describe("the public flow is unchanged", () => {
  const publicInput = {
    quote: DEEP_3000,
    date: OPEN_MONDAY,
    time: "10:00",
    firstName: "Hank",
    lastName: "Hill",
    email: "hank@example.com",
    phone: "2105550123",
    address: "84 Rainey St",
    city: "San Antonio",
    zip: "78209",
    locale: "en" as const,
  };

  it("a customPrice key on the public form is dropped, and the catalog prices the booking", async () => {
    await publicCaller().create({ ...publicInput, customPrice: { amount: 1, reason: "nice try" } } as never);
    expect(written().totalAmount).toBe(CATALOG);
    expect(written()).not.toHaveProperty("customPriceCents");
    expect(written().grandfatheredBaseCents).toBeNull();
  });

  it("the public schema has no such field, and neither do the public pages", () => {
    const router = read("./routers/booking.ts");
    const start = router.indexOf("create: publicProcedure");
    const schema = router.slice(start, router.indexOf(".mutation(", start));
    expect(schema).not.toContain("customPrice");
    expect(read("../client/src/pages/Booking.tsx")).not.toMatch(/customPrice|Customize price/);
    expect(read("../client/src/pages/Quote.tsx")).not.toMatch(/customPrice|Customize price/);
  });

  it("the field lives on the admin procedure alone, stamped with the admin's own id", () => {
    const router = read("./routers/admin.ts");
    const start = router.indexOf("createBooking: adminProcedure");
    const procedure = router.slice(start, router.indexOf("resendDepositLink", start));
    expect(procedure).toContain("customPrice: z");
    expect(procedure).toContain("byUserId: ctx.user.id");
  });
});
