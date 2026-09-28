/**
 * Grandfathered pricing — one original client keeps her per-cleaning price
 * while the catalog moves on, and nobody else does.
 *
 * What this pins:
 *   - the lock is found by NORMALIZED email or phone (case, spacing,
 *     punctuation, a leading country code), never by address alone, and never
 *     for a customer without one;
 *   - when it applies, the quote, the booking, the deposit and the deposit
 *     link all price from it — extras and coupons on top, the recurring
 *     discount not stacking — and the booking records which rate priced it;
 *   - it is service-specific: her residential rate says nothing about a deep
 *     clean;
 *   - the admin manual fallback re-prices one booking by hand, keeps a paid
 *     deposit paid, and refuses a finished job;
 *   - the admin pages label the booking and suggest the fallback when the
 *     address (the secondary signal) or the record itself points at her.
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
const mockSetGrandfathered = vi.fn();
const mockListBookings = vi.fn();
const mockGetCustomersByIds = vi.fn();
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
    setCustomerGrandfathered: (...a: unknown[]) => mockSetGrandfathered(...a),
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    getCustomersByIds: (...a: unknown[]) => mockGetCustomersByIds(...a),
    listBalanceInvoicesForBookings: vi.fn().mockResolvedValue([]),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./property", async () => {
  const actual = await vi.importActual<typeof import("./property")>("./property");
  return { ...actual, lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a) };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { calculateCatalogQuote, calculateQuote, DEFAULT_PRICING } from "@shared/pricing";
import {
  addressMatchesCustomer,
  contactMatchesCustomer,
  findLockedCustomer,
  lockAppliesTo,
  lockFromCustomer,
  normalizeAddressLine,
  normalizeEmail,
  normalizePhone,
  paidPerVisitCents,
} from "@shared/priceLock";
import { completedHistory, suggestedRate } from "../client/src/pages/admin/grandfathered";
import { _resetRateLimits } from "./antiSpam";
import { buildOwnerNotification } from "./emails";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "f".repeat(48);

/** The original client. Email and phone stored the way people type them. */
const MARIA = {
  id: 41,
  firstName: "Maria del Mar",
  lastName: "Prado",
  email: "Maria.Prado@Example.com",
  phone: "(210) 555-0199",
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

/** Everyone else. */
const ANA = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "5125550134",
  address: "800 Congress Ave",
  city: "Austin",
  zip: "78701",
  preferredLocale: "en",
  notes: null,
  grandfatheredPriceCents: null,
  grandfatheredServiceType: null,
  grandfatheredNote: null,
  grandfatheredAt: null,
  grandfatheredByUserId: null,
};

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

const payCaller = () =>
  depositLinkRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const publicInput = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [] as string[],
    frequency: "onetime" as const,
  },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Maria del Mar",
  lastName: "Prado",
  email: "MARIA.PRADO@example.com",
  phone: "210-555-0199",
  address: "1200 Barton Springs Rd",
  city: "San Antonio",
  zip: "78205",
  locale: "es" as const,
};

const CATALOG_1200 = calculateQuote(publicInput.quote, DEFAULT_PRICING); // $112.99 residential

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const patched = () =>
  Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>));

const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-GF1",
  customerId: 41,
  grandfatheredCustomerId: null,
  grandfatheredBaseCents: null,
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: null,
  scheduledTime: null,
  bedrooms: 2,
  bathrooms: 1,
  sqft: 1200,
  extras: "[]",
  addonsAmountCents: 0,
  addressLine: null,
  unitNumber: null,
  propertyType: "house",
  city: null,
  zip: null,
  notes: null,
  locale: "es",
  totalAmount: 0,
  depositAmount: 0,
  depositAmountCents: null,
  status: "pending_deposit",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: null,
  verifiedSqft: null,
  sqftMismatch: false,
  stripePaymentIntentId: null,
  paymentPreference: null,
  kind: "admin",
  holdMinutes: 24 * 60,
  payToken: TOKEN,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  adminProvided: "service",
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockListGrandfathered.mockResolvedValue([MARIA]);
  mockGetCustomerById.mockImplementation(async (id: number) => (id === 41 ? MARIA : id === 7 ? ANA : undefined));
  mockGetCustomersByIds.mockResolvedValue([MARIA, ANA]);
  mockFindOrCreateCustomer.mockImplementation(async (data: { customerId?: number }) => data.customerId ?? 7);
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockSetGrandfathered.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Matching: normalized email or phone, never the address alone
// ---------------------------------------------------------------------------

describe("contact normalization", () => {
  it("lowercases and trims an email, and refuses a non-email", () => {
    expect(normalizeEmail("  Maria.Prado@Example.com ")).toBe("maria.prado@example.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("reduces a phone to its digits and drops a leading US country code", () => {
    expect(normalizePhone("+1 (210) 555-0199")).toBe("2105550199");
    expect(normalizePhone("210.555.0199")).toBe("2105550199");
    expect(normalizePhone("12105550199")).toBe("2105550199");
    expect(normalizePhone("2105550199")).toBe("2105550199");
    // Too short to be a phone number: matches nothing, ever.
    expect(normalizePhone("555")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("normalizes a street line — case, punctuation, suffix, unit", () => {
    expect(normalizeAddressLine("1200 Barton Springs Road, Apt 4")).toBe("1200 barton springs rd");
    expect(normalizeAddressLine("1200 barton springs rd.")).toBe("1200 barton springs rd");
    expect(normalizeAddressLine("  ")).toBeNull();
  });
});

describe("finding the grandfathered customer", () => {
  const candidates = [MARIA, ANA];

  it("matches her email however it is typed", () => {
    expect(findLockedCustomer(candidates, { email: "maria.prado@EXAMPLE.com " })?.id).toBe(41);
  });

  it("matches her phone however it is formatted", () => {
    expect(findLockedCustomer(candidates, { email: "new.address@example.com", phone: "+1 210 555 0199" })?.id).toBe(41);
    expect(findLockedCustomer(candidates, { phone: "2105550199" })?.id).toBe(41);
  });

  it("never matches a stranger, blank details, or a customer without a lock", () => {
    expect(findLockedCustomer(candidates, { email: "someone@else.com", phone: "2105550000" })).toBeNull();
    expect(findLockedCustomer(candidates, {})).toBeNull();
    // Ana's own contact details point at Ana — who has no lock — so nobody.
    expect(findLockedCustomer(candidates, { email: "ana@example.com" })).toBeNull();
  });

  it("uses the address only as a secondary signal, never to match on its own", () => {
    expect(findLockedCustomer(candidates, { email: "tenant@example.com", phone: "2105550000" })).toBeNull();
    expect(addressMatchesCustomer(MARIA, { addressLine: "1200 Barton Springs Rd, Apt 4", zip: "78205" })).toBe(true);
    // Same street, different ZIP: a different city's Barton Springs.
    expect(addressMatchesCustomer(MARIA, { addressLine: "1200 Barton Springs Rd", zip: "78704" })).toBe(false);
    expect(contactMatchesCustomer(MARIA, { email: "maria.prado@example.com" })).toBe(true);
    expect(contactMatchesCustomer(MARIA, { phone: "2105550000" })).toBe(false);
  });

  it("reads the lock off the customer row, and only a real one", () => {
    expect(lockFromCustomer(MARIA)).toEqual({
      basePriceCents: 8500,
      serviceType: "residential",
      customerId: 41,
      customerName: "Maria del Mar Prado",
    });
    expect(lockFromCustomer(ANA)).toBeNull();
    expect(lockFromCustomer({ ...MARIA, grandfatheredPriceCents: 0 })).toBeNull();
    expect(lockAppliesTo(lockFromCustomer(MARIA), "residential")).toBe(true);
    expect(lockAppliesTo(lockFromCustomer(MARIA), "deep")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The quote engine under a lock
// ---------------------------------------------------------------------------

describe("calculateQuote with a grandfathered rate", () => {
  const lock = lockFromCustomer(MARIA)!;

  it("replaces the tier price and does not stack the recurring discount", () => {
    const quote = calculateQuote({ ...publicInput.quote, frequency: "biweekly" }, DEFAULT_PRICING, lock);
    expect(quote.base).toBe(85);
    expect(quote.discount).toBe(0);
    expect(quote.total).toBe(85);
    expect(quote.deposit).toBe(17);
    expect(quote.grandfathered).toBe(true);
    expect(quote.startingAt).toBe(false);
  });

  it("still adds extras on top", () => {
    const quote = calculateQuote({ ...publicInput.quote, extras: ["oven"] }, DEFAULT_PRICING, lock);
    expect(quote.total).toBe(Math.round((85 + DEFAULT_PRICING.extras.oven) * 100) / 100);
  });

  it("overrides even the custom-quote tier — her size does not change her price", () => {
    const quote = calculateQuote({ ...publicInput.quote, sqft: 9000 }, DEFAULT_PRICING, lock);
    expect(quote.customQuote).toBe(false);
    expect(quote.total).toBe(85);
  });

  it("is service-specific: a deep clean prices from the catalog", () => {
    const deep = calculateQuote({ ...publicInput.quote, type: "deep" }, DEFAULT_PRICING, lock);
    expect(deep.grandfathered).toBe(false);
    expect(deep.total).toBe(calculateQuote({ ...publicInput.quote, type: "deep" }, DEFAULT_PRICING).total);
  });

  it("does the same in the catalog (cents) path", () => {
    const quote = calculateCatalogQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, frequency: "biweekly" },
      1100,
      DEFAULT_PRICING,
      lock
    );
    expect(quote.baseCents).toBe(8500);
    expect(quote.discountCents).toBe(0);
    expect(quote.totalCents).toBe(9600);
    expect(quote.grandfathered).toBe(true);
  });

  it("changes nothing without a lock", () => {
    expect(calculateQuote(publicInput.quote, DEFAULT_PRICING, null)).toEqual(CATALOG_1200);
    expect(CATALOG_1200.total).toBe(112.99);
    expect(CATALOG_1200.grandfathered).toBe(false);
  });
});

describe("what she paid per visit", () => {
  it("takes that visit's extras back out when the exact snapshot exists", () => {
    expect(paidPerVisitCents({ totalAmount: 96, totalAmountCents: 9600, addonsAmountCents: 1100 })).toBe(8500);
  });

  it("falls back to the legacy whole-dollar total on old rows", () => {
    expect(paidPerVisitCents({ totalAmount: 85, totalAmountCents: null, addonsAmountCents: null })).toBe(8500);
  });

  it("prefills the dialog from her latest completed cleaning, or her current rate", () => {
    const history = completedHistory([
      { id: 1, reference: "A", status: "completed", serviceType: "residential", frequency: "biweekly", sqft: 1200, scheduledDate: "2026-07-01", totalAmount: 85, totalAmountCents: 8500, addonsAmountCents: 0 },
      { id: 2, reference: "B", status: "cancelled", serviceType: "residential", frequency: "biweekly", sqft: 1200, scheduledDate: "2026-08-15", totalAmount: 112, totalAmountCents: 11299, addonsAmountCents: 0 },
      { id: 3, reference: "C", status: "completed", serviceType: "residential", frequency: "biweekly", sqft: 1200, scheduledDate: "2026-08-01", totalAmount: 96, totalAmountCents: 9600, addonsAmountCents: 1100 },
    ]);
    expect(history.map(b => b.reference)).toEqual(["C", "A"]);
    expect(suggestedRate({ grandfatheredPriceCents: null, grandfatheredServiceType: null }, history)).toMatchObject({
      price: "85.00",
      serviceType: "residential",
    });
    expect(suggestedRate({ grandfatheredPriceCents: 7999, grandfatheredServiceType: "deep" }, history)).toMatchObject({
      price: "79.99",
      serviceType: "deep",
    });
    expect(suggestedRate({ grandfatheredPriceCents: null, grandfatheredServiceType: null }, [])).toMatchObject({
      price: "",
      from: null,
    });
  });
});

// ---------------------------------------------------------------------------
// booking.create — the public guest checkout
// ---------------------------------------------------------------------------

describe("booking.create applies the lock", () => {
  it("prices her booking, deposit and Stripe session from her rate when her email matches", async () => {
    await publicCaller().create(publicInput);
    const row = written();
    expect(row.totalAmountCents).toBe(8500);
    expect(row.depositAmountCents).toBe(1700);
    expect(row.grandfatheredBaseCents).toBe(8500);
    expect(row.grandfatheredCustomerId).toBe(41);
    // Her booking lands on HER record, not a duplicate.
    expect(row.customerId).toBe(41);
    expect(mockFindOrCreateCustomer.mock.calls[0]![0]).toMatchObject({ customerId: 41, email: "MARIA.PRADO@example.com" });
    const session = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(session.line_items[0].price_data.unit_amount).toBe(1700);
  });

  it("recognises her by phone under a brand-new email", async () => {
    await publicCaller().create({ ...publicInput, email: "maria.new@gmail.com", phone: "+1 (210) 555-0199" });
    expect(written().totalAmountCents).toBe(8500);
    expect(written().customerId).toBe(41);
  });

  it("does not stack her recurring discount", async () => {
    await publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, frequency: "biweekly" } });
    expect(written().totalAmountCents).toBe(8500);
    expect(written().discountAppliedCents).toBe(0);
  });

  it("never applies it to anyone else — a stranger pays the catalog price", async () => {
    await publicCaller().create({
      ...publicInput,
      firstName: "Ana",
      lastName: "Lopez",
      email: "ana@example.com",
      phone: "5125550134",
      address: "800 Congress Ave",
      city: "Austin",
      zip: "78701",
    });
    const row = written();
    expect(row.totalAmountCents).toBe(11299);
    expect(row.grandfatheredBaseCents).toBeNull();
    expect(row.grandfatheredCustomerId).toBeNull();
    expect(mockFindOrCreateCustomer.mock.calls[0]![0]).toMatchObject({ customerId: undefined });
  });

  it("never applies it by address alone — a new tenant at her address is not her", async () => {
    await publicCaller().create({
      ...publicInput,
      firstName: "Tenant",
      lastName: "New",
      email: "tenant@example.com",
      phone: "2105550000",
    });
    expect(written().totalAmountCents).toBe(11299);
    expect(written().grandfatheredBaseCents).toBeNull();
  });

  it("is service-specific — her deep clean prices from the catalog", async () => {
    await publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, type: "deep" } });
    const deep = calculateQuote({ ...publicInput.quote, type: "deep" }, DEFAULT_PRICING);
    expect(written().totalAmount).toBe(deep.total);
    expect(written().grandfatheredBaseCents).toBeNull();
    // Still her record, though.
    expect(written().customerId).toBe(41);
  });

  it("does not let a county record reprice a locked booking upward", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 3400, source: "bexar_gis" });
    await publicCaller().create(publicInput);
    expect(written().totalAmountCents).toBe(8500);
    expect(written().sqftMismatch).toBe(false);
    expect(written().verifiedSqft).toBe(3400);
  });

  it("does nothing at all when no customer has a lock", async () => {
    mockListGrandfathered.mockResolvedValue([]);
    await publicCaller().create(publicInput);
    expect(written().totalAmountCents).toBe(11299);
    expect(written().grandfatheredBaseCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The admin form and the deposit link
// ---------------------------------------------------------------------------

describe("admin.createBooking applies the lock", () => {
  it("prices a phone lead at her rate when the phone is hers", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Maria del Mar",
      phone: "210 555 0199",
      serviceType: "residential",
      sqft: 1200,
    });
    expect(result.basePrice).toBe(85);
    expect(result.deposit).toBe(17);
    expect(result.grandfathered).toEqual({ customerName: "Maria del Mar Prado", basePrice: 85 });
    expect(written().grandfatheredBaseCents).toBe(8500);
    expect(written().grandfatheredCustomerId).toBe(41);
    expect(written().customerId).toBe(41);
  });

  it("prices her deep clean from the catalog", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Maria del Mar",
      phone: "210 555 0199",
      serviceType: "deep",
      sqft: 1200,
    });
    expect(result.grandfathered).toBeNull();
    expect(result.basePrice).toBe(calculateQuote({ ...publicInput.quote, type: "deep" }, DEFAULT_PRICING).total);
  });

  it("prices anyone else from the catalog", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Ana",
      phone: "5125550134",
      serviceType: "residential",
      sqft: 1200,
    });
    expect(result.grandfathered).toBeNull();
    expect(result.basePrice).toBe(112.99);
    expect(written().grandfatheredBaseCents).toBeNull();
  });
});

describe("the deposit link prices from the lock", () => {
  it("get returns her price lock and her totals, so the page previews what she will pay", async () => {
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.priceLock).toEqual({ basePriceCents: 8500, serviceType: "residential" });
    expect(result.booking?.basePrice).toBe(85);
    expect(result.booking?.total).toBe(85);
    expect(result.booking?.deposit).toBe(17);
  });

  it("get returns no lock for a customer without one", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ customerId: 7 }));
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.priceLock).toBeNull();
    expect(result.booking?.total).toBe(112.99);
  });

  it("records the rate on the row whenever the link re-prices", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ sqft: null }));
    mockGetBookingById.mockResolvedValue(linkRow({ sqft: 1400 }));
    await payCaller().updateDetails({ token: TOKEN, sqft: 1400 });
    expect(patched()).toMatchObject({
      totalAmountCents: 8500,
      depositAmountCents: 1700,
      grandfatheredBaseCents: 8500,
      grandfatheredCustomerId: 41,
    });
  });

  it("follows the service she picks on the link — deep clean, catalog price", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ serviceType: null, adminProvided: "size" }));
    mockGetBookingById.mockResolvedValue(linkRow({ serviceType: "deep" }));
    await payCaller().updateDetails({ token: TOKEN, serviceType: "deep" });
    const deep = calculateQuote({ ...publicInput.quote, type: "deep" }, DEFAULT_PRICING);
    expect(patched()).toMatchObject({ totalAmount: deep.total, grandfatheredBaseCents: null, grandfatheredCustomerId: null });
  });

  it("honours a rate the owner applied by hand to a booking under another record", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ customerId: 7, grandfatheredCustomerId: 41 }));
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.priceLock).toEqual({ basePriceCents: 8500, serviceType: "residential" });
    expect(result.booking?.total).toBe(85);
  });
});

// ---------------------------------------------------------------------------
// Admin: setting the rate, the manual fallback, the labels
// ---------------------------------------------------------------------------

describe("admin.setGrandfatheredPrice", () => {
  it("stores the whole per-visit figure in cents against her record", async () => {
    const result = await adminCaller().setGrandfatheredPrice({
      customerId: 41,
      price: 85,
      serviceType: "residential",
      note: "Original client since 2019",
    });
    expect(result).toEqual({ success: true, lock: { price: 85, serviceType: "residential" } });
    expect(mockSetGrandfathered).toHaveBeenCalledWith(41, {
      priceCents: 8500,
      serviceType: "residential",
      note: "Original client since 2019",
      byUserId: 1,
    });
  });

  it("clears it with a null price", async () => {
    const result = await adminCaller().setGrandfatheredPrice({ customerId: 41, price: null });
    expect(result).toEqual({ success: true, lock: null });
    expect(mockSetGrandfathered).toHaveBeenCalledWith(41, null);
  });

  it("refuses a rate without a service, a non-positive rate, and an unknown customer", async () => {
    await expect(adminCaller().setGrandfatheredPrice({ customerId: 41, price: 85 })).rejects.toThrow(/service/i);
    await expect(
      adminCaller().setGrandfatheredPrice({ customerId: 41, price: 0, serviceType: "residential" })
    ).rejects.toThrow();
    await expect(
      adminCaller().setGrandfatheredPrice({ customerId: 999, price: 85, serviceType: "residential" })
    ).rejects.toThrow(/not found/i);
    expect(mockSetGrandfathered).not.toHaveBeenCalled();
  });

  it("lists the grandfathered customers for the manual fallback picker", async () => {
    const list = await adminCaller().grandfatheredCustomers();
    expect(list).toEqual([
      expect.objectContaining({ id: 41, name: "Maria del Mar Prado", price: 85, serviceType: "residential" }),
    ]);
  });
});

describe("admin.repriceBooking — the manual fallback", () => {
  const confirmedCatalogBooking = (overrides: Record<string, unknown> = {}) =>
    linkRow({
      id: 5,
      customerId: 7,
      kind: "self_serve",
      status: "confirmed",
      totalAmount: 112.99,
      totalAmountCents: 11299,
      depositAmount: 22.6,
      depositAmountCents: 2260,
      stripePaymentIntentId: "pi_5",
      addonsAmountCents: 0,
      ...overrides,
    });

  it("re-prices a booking made under another email at her rate and keeps the paid deposit", async () => {
    mockGetBookingById.mockResolvedValue(confirmedCatalogBooking());
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 });
    expect(result).toMatchObject({
      success: true,
      total: 85,
      deposit: 22.6,
      depositKept: true,
      grandfathered: { customerName: "Maria del Mar Prado", basePrice: 85 },
    });
    expect(mockUpdateBooking).toHaveBeenCalledWith(5, expect.objectContaining({
      totalAmountCents: 8500,
      depositAmountCents: 2260,
      grandfatheredBaseCents: 8500,
      grandfatheredCustomerId: 41,
    }));
  });

  it("recomputes a deposit that has not been paid yet", async () => {
    mockGetBookingById.mockResolvedValue(
      confirmedCatalogBooking({ status: "pending_deposit", stripePaymentIntentId: null })
    );
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 });
    expect(result).toMatchObject({ total: 85, deposit: 17, depositKept: false });
  });

  it("keeps a cash choice at no deposit", async () => {
    mockGetBookingById.mockResolvedValue(
      confirmedCatalogBooking({ status: "pending_deposit", stripePaymentIntentId: null, paymentPreference: "cash", depositAmountCents: 0, depositAmount: 0 })
    );
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 });
    expect(result).toMatchObject({ total: 85, deposit: 0 });
  });

  it("keeps the extras she booked at their snapshot amount", async () => {
    mockGetBookingById.mockResolvedValue(confirmedCatalogBooking({ addonsAmountCents: 1100 }));
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 });
    expect(result.total).toBe(96);
  });

  it("goes back to the catalog with null", async () => {
    mockGetBookingById.mockResolvedValue(
      confirmedCatalogBooking({ grandfatheredBaseCents: 8500, grandfatheredCustomerId: 41, totalAmountCents: 8500 })
    );
    const result = await adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: null });
    expect(result).toMatchObject({ total: 112.99, grandfathered: null });
    expect(mockUpdateBooking).toHaveBeenCalledWith(5, expect.objectContaining({
      totalAmountCents: 11299,
      grandfatheredBaseCents: null,
      grandfatheredCustomerId: null,
    }));
  });

  it("refuses a finished job, a customer without a rate, and a rate for another service", async () => {
    mockGetBookingById.mockResolvedValue(confirmedCatalogBooking({ status: "completed" }));
    await expect(adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 })).rejects.toThrow(/invoice/i);

    mockGetBookingById.mockResolvedValue(confirmedCatalogBooking());
    await expect(adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 7 })).rejects.toThrow(
      /no grandfathered price/i
    );

    mockGetBookingById.mockResolvedValue(confirmedCatalogBooking({ serviceType: "deep" }));
    await expect(adminCaller().repriceBooking({ bookingId: 5, grandfatheredCustomerId: 41 })).rejects.toThrow(
      /is for Residential Cleaning/
    );
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });
});

describe("admin.bookings labels the rate and suggests the fallback", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    reference: "GFC-1",
    customerId: 7,
    kind: "self_serve",
    status: "confirmed",
    serviceType: "residential",
    scheduledDate: OPEN_MONDAY,
    scheduledTime: "10:00",
    sqft: 1200,
    estimatedHours: 2,
    depositAmount: 17,
    depositAmountCents: 1700,
    stripePaymentIntentId: "pi_1",
    totalAmount: 85,
    addressLine: "800 Congress Ave",
    zip: "78701",
    grandfatheredBaseCents: null,
    grandfatheredCustomerId: null,
    createdAt: new Date(),
    ...overrides,
  });

  it("names whose rate priced a grandfathered booking", async () => {
    mockListBookings.mockResolvedValue([row({ customerId: 41, grandfatheredBaseCents: 8500, grandfatheredCustomerId: 41 })]);
    const [booking] = await adminCaller().bookings();
    expect(booking.grandfatheredCustomerName).toBe("Maria del Mar Prado");
    expect(booking.grandfatheredSuggestion).toBeNull();
  });

  it("suggests her rate for a catalog-priced booking at her address (the secondary signal)", async () => {
    mockListBookings.mockResolvedValue([row({ addressLine: "1200 Barton Springs Rd Apt 2", zip: "78205" })]);
    const [booking] = await adminCaller().bookings();
    expect(booking.grandfatheredCustomerName).toBeNull();
    expect(booking.grandfatheredSuggestion).toEqual({
      customerId: 41,
      customerName: "Maria del Mar Prado",
      basePrice: 85,
      reason: "address",
    });
  });

  it("suggests it for her own record when the rate was set after she booked", async () => {
    mockListBookings.mockResolvedValue([row({ customerId: 41 })]);
    const [booking] = await adminCaller().bookings();
    expect(booking.grandfatheredSuggestion).toMatchObject({ customerId: 41, reason: "same_customer" });
  });

  it("suggests nothing for a stranger, a finished job, or another service", async () => {
    mockListBookings.mockResolvedValue([
      row({ id: 1 }),
      row({ id: 2, customerId: 41, status: "completed" }),
      row({ id: 3, customerId: 41, serviceType: "deep" }),
    ]);
    const rows = await adminCaller().bookings();
    expect(rows.map(r => r.grandfatheredSuggestion)).toEqual([null, null, null]);
  });
});

describe("the owner hears which rate priced the booking", () => {
  it("names the grandfathered rate in the new-booking notification", () => {
    const note = buildOwnerNotification({
      reference: "GFC-GF1",
      serviceName: "Residential Cleaning",
      date: OPEN_MONDAY,
      time: "10:00",
      frequencyLabel: "One-time",
      extras: [],
      total: 85,
      deposit: 17,
      customerName: "Maria del Mar",
      customerEmail: "maria.prado@example.com",
      locale: "en",
      grandfathered: { customerName: "Maria del Mar Prado", basePrice: 85 },
    });
    expect(note.content).toContain("GRANDFATHERED RATE — $85.00 per cleaning (Maria del Mar Prado)");
  });

  it("says nothing about it for a catalog booking", () => {
    const note = buildOwnerNotification({
      reference: "GFC-1",
      serviceName: "Residential Cleaning",
      date: OPEN_MONDAY,
      time: "10:00",
      frequencyLabel: "One-time",
      extras: [],
      total: 112.99,
      deposit: 22.6,
      customerName: "Ana",
      customerEmail: "ana@example.com",
      locale: "en",
      grandfathered: null,
    });
    expect(note.content).not.toMatch(/GRANDFATHERED/);
  });
});

// ---------------------------------------------------------------------------
// The admin pages carry the label and the two dialogs
// ---------------------------------------------------------------------------

describe("admin UI pins", () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

  it("labels a grandfathered booking in its Details and offers the manual fallback", () => {
    const details = source("../client/src/pages/admin/BookingDetails.tsx");
    expect(details).toContain("<GrandfatheredBadge />");
    expect(details).toContain("Change rate");
    expect(details).toContain("grandfatheredSuggestion");
    expect(details).toContain("<ApplyGrandfatheredRateDialog");
    expect(source("../client/src/pages/admin/adminShared.tsx")).toContain("Grandfathered price");
  });

  it("sets the rate from the customer record, prefilled from what she paid", () => {
    const customers = source("../client/src/pages/admin/AdminCustomers.tsx");
    expect(customers).toContain("<GrandfatheredPriceDialog");
    expect(customers).toContain("Set grandfathered price");
    const dialog = source("../client/src/pages/admin/GrandfatheredPriceDialog.tsx");
    expect(dialog).toContain("suggestedRate(customer, history)");
    expect(dialog).toContain("What they've been paying");
    expect(dialog).toContain("trpc.admin.setGrandfatheredPrice.useMutation");
  });

  it("the pay page previews from the lock the link returns", () => {
    const payPage = source("../client/src/pages/PayDeposit.tsx");
    expect(payPage).toContain("booking.priceLock");
    expect(payPage).toContain("c.lockedPrice");
  });
});
