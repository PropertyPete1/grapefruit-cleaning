/**
 * The apartment square-footage bug: a customer typed an apartment address, the
 * county lookup returned the WHOLE BUILDING (300,000 sq ft), and the quote
 * priced the unit off it.
 *
 * What this pins:
 *   - a home has a size ceiling (MAX_HOME_SQFT): a record above it is a
 *     building or a mismatch and is never applied, even with no entered figure
 *     to compare against — on the public flow, the admin form's records-only
 *     path, and the deposit link's address step;
 *   - an address that names a unit is an apartment whatever the toggle says,
 *     so the lookup is skipped and the unit's own size is asked for;
 *   - every square-footage input, public and admin, is bounded by the same
 *     range, so an absurd value cannot reach a quote by any road;
 *   - the quote and booking pages prompt for the unit's exact size instead of
 *     auto-filling, and the booking page refuses an apartment without one.
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
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    findOrCreateCustomer: vi.fn().mockResolvedValue(7),
    getCustomerById: vi.fn().mockResolvedValue({ id: 7, firstName: "Ana", lastName: "Lopez", email: "ana@example.com", phone: "5125550134" }),
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    listBookings: vi.fn().mockResolvedValue([]),
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

import { calculateQuote, DEFAULT_PRICING } from "@shared/pricing";
import {
  acceptableSqft,
  looksLikeUnitAddress,
  MAX_HOME_SQFT,
  MIN_HOME_SQFT,
  plausibleVerifiedSqft,
} from "@shared/property";
import { resolveEffectiveSqft } from "./adminBooking";
import { _resetRateLimits } from "./antiSpam";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "a".repeat(48);
const BUILDING = 300_000;

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
  quote: { type: "residential" as const, bedrooms: 2, bathrooms: 1, sqft: 800, extras: [] as string[], frequency: "onetime" as const },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "5125550134",
  address: "100 Tower Plaza",
  city: "San Antonio",
  zip: "78205",
  locale: "en" as const,
};

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const patched = () =>
  Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>));

const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-UNIT2",
  customerId: 7,
  grandfatheredCustomerId: null,
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: null,
  scheduledTime: null,
  bedrooms: 2,
  bathrooms: 1,
  sqft: null,
  extras: "[]",
  addressLine: null,
  unitNumber: null,
  propertyType: "house",
  city: null,
  zip: null,
  notes: null,
  locale: "en",
  totalAmount: 0,
  depositAmount: 0,
  status: "pending_deposit",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: null,
  verifiedSqft: null,
  sqftMismatch: false,
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
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The shared rules
// ---------------------------------------------------------------------------

describe("the home size ceiling", () => {
  it("is the one bound every input uses", () => {
    expect(MAX_HOME_SQFT).toBe(10_000);
    expect(MIN_HOME_SQFT).toBe(200);
  });

  it("makes a building-sized record implausible even with nothing to compare against", () => {
    expect(plausibleVerifiedSqft(null, BUILDING)).toBe(false);
    expect(plausibleVerifiedSqft(undefined, 10_001)).toBe(false);
    expect(plausibleVerifiedSqft(null, 10_000)).toBe(true);
    // The 4x guard still applies underneath the ceiling.
    expect(plausibleVerifiedSqft(800, 3_200)).toBe(true);
    expect(plausibleVerifiedSqft(800, 3_201)).toBe(false);
    // 35,000 is under 4x a 9,000 entry, but no home is 35,000 sq ft.
    expect(plausibleVerifiedSqft(9_000, 35_000)).toBe(false);
    expect(plausibleVerifiedSqft(800, 0)).toBe(false);
  });

  it("accepts only whole sizes inside the home range", () => {
    expect(acceptableSqft("743")).toBe(743);
    expect(acceptableSqft(850.4)).toBe(850);
    expect(acceptableSqft("10000")).toBe(10_000);
    expect(acceptableSqft("12")).toBeNull();
    expect(acceptableSqft("300000")).toBeNull();
    expect(acceptableSqft("")).toBeNull();
    expect(acceptableSqft("abc")).toBeNull();
    expect(acceptableSqft(null)).toBeNull();
  });
});

describe("recognising a unit address", () => {
  it("spots the usual designators", () => {
    for (const line of [
      "1200 Barton Springs Rd Apt 204",
      "1200 Barton Springs Rd, Apt 204, Austin",
      "1200 Barton Springs Rd apt. 204",
      "100 Main St #12",
      "100 Main St # 12B",
      "55 Pearl Pkwy Unit 5B",
      "77 Elm Ste 300",
      "77 Elm Suite 300-A",
      "9 Riverwalk Condo 7",
      "9 Riverwalk Bldg C",
      "300 Alamo Plaza Fl 3",
      "12 Oak Ln Apartment B",
    ]) {
      expect(looksLikeUnitAddress(line), line).toBe(true);
    }
  });

  it("leaves houses and street names alone", () => {
    for (const line of [
      "5500 Grand Lake Dr",
      "800 Congress Ave",
      "9 Condo Ln",
      "42 Building Blvd",
      "7 Apartment Dr",
      "1 Suite Way",
      "",
      "   ",
    ]) {
      expect(looksLikeUnitAddress(line), line).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The server never prices from the building
// ---------------------------------------------------------------------------

describe("public booking.create", () => {
  it("treats a building-sized record as a failed lookup — entered size stands, nothing 'verified'", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: BUILDING, source: "bexar_gis" });
    await publicCaller().create(publicInput);
    const entered = calculateQuote(publicInput.quote, DEFAULT_PRICING);
    expect(written().sqft).toBe(800);
    expect(written().sqftMismatch).toBe(false);
    expect(written().verifiedSqft).toBeUndefined();
    expect(written().totalAmount).toBe(entered.total);
  });

  it("refuses a record over the ceiling even when it is under 4x the entered size", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 35_000, source: "bexar_gis" });
    await publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, sqft: 9_000 } });
    expect(written().sqft).toBe(9_000);
    expect(written().verifiedSqft).toBeUndefined();
  });

  it("still reprices a house from a believable record", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2_400, source: "bexar_gis" });
    await publicCaller().create(publicInput);
    expect(written().sqft).toBe(2_400);
    expect(written().sqftMismatch).toBe(true);
    expect(written().verifiedSqft).toBe(2_400);
  });

  it("never looks an apartment up, and books the unit's entered size", async () => {
    await publicCaller().create({ ...publicInput, propertyType: "apartment", unitNumber: "204", quote: { ...publicInput.quote, sqft: 743 } });
    expect(mockLookupProperty).not.toHaveBeenCalled();
    expect(written().sqft).toBe(743);
  });

  it("rejects an absurd size at the door", async () => {
    await expect(
      publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, sqft: 10_001 } })
    ).rejects.toThrow();
    await expect(
      publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, sqft: BUILDING } })
    ).rejects.toThrow();
    await expect(publicCaller().create({ ...publicInput, quote: { ...publicInput.quote, sqft: 199 } })).rejects.toThrow();
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });
});

describe("the admin form's records-only path", () => {
  it("does not take the building as the size when the owner left sqft blank", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: BUILDING, source: "bexar_gis" });
    const result = await adminCaller().createBooking({
      firstName: "Ana",
      phone: "5125550134",
      serviceType: "residential",
      address: "100 Tower Plaza",
      city: "San Antonio",
      zip: "78205",
    });
    expect(result.sqft).toBeNull();
    expect(result.basePrice).toBeNull();
    expect(result.customerWillChoose).toContain("size");
    expect(written().sqft).toBeNull();
    expect(written().verifiedSqft).toBeUndefined();
    expect(written().totalAmount).toBe(0);
  });

  it("still settles the size from a believable record alone", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2_400, source: "bexar_gis" });
    const result = await adminCaller().createBooking({
      firstName: "Ana",
      phone: "5125550134",
      serviceType: "residential",
      address: "12 Oak Ln",
      city: "San Antonio",
      zip: "78205",
    });
    expect(result.sqft).toBe(2_400);
    expect(written().verifiedSqft).toBe(2_400);
  });

  it("caps the typed size at the same ceiling as the public flow", async () => {
    await expect(
      adminCaller().createBooking({ firstName: "Ana", phone: "5125550134", serviceType: "residential", sqft: 12_000 })
    ).rejects.toThrow();
    await expect(
      adminCaller().createBooking({ firstName: "Ana", phone: "5125550134", serviceType: "residential", sqft: 10_000 })
    ).resolves.toMatchObject({ sqft: 10_000 });
  });

  it("resolveEffectiveSqft never returns a building on its own", () => {
    expect(
      resolveEffectiveSqft({ enteredSqft: null, verifiedSqft: BUILDING, serviceType: "residential", pricing: DEFAULT_PRICING })
    ).toEqual({ sqft: null, corrected: false });
    expect(
      resolveEffectiveSqft({ enteredSqft: null, verifiedSqft: 2_400, serviceType: "residential", pricing: DEFAULT_PRICING })
    ).toEqual({ sqft: 2_400, corrected: false });
  });
});

describe("the deposit link's address step", () => {
  it("stores the address but not a building-sized 'verified' size", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: BUILDING, source: "bexar_gis" });
    mockGetBookingById.mockResolvedValue(linkRow({ addressLine: "100 Tower Plaza" }));
    await payCaller().updateDetails({ token: TOKEN, address: "100 Tower Plaza", city: "San Antonio", zip: "78205" });
    const patch = patched();
    expect(patch.addressLine).toBe("100 Tower Plaza");
    expect(patch.verifiedSqft).toBeUndefined();
    expect(patch.sqft).toBeUndefined();
  });

  it("still verifies a house from a believable record", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2_400, source: "bexar_gis" });
    mockGetBookingById.mockResolvedValue(linkRow({ addressLine: "12 Oak Ln", sqft: 2_400, verifiedSqft: 2_400 }));
    await payCaller().updateDetails({ token: TOKEN, address: "12 Oak Ln", city: "San Antonio", zip: "78205" });
    expect(patched()).toMatchObject({ verifiedSqft: 2_400, sqft: 2_400 });
  });

  it("rejects an absurd slider value", async () => {
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 10_001 })).rejects.toThrow();
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: BUILDING })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The pages ask instead of auto-filling
// ---------------------------------------------------------------------------

describe("the quote and booking pages", () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
  const quote = source("../client/src/pages/Quote.tsx");
  const booking = source("../client/src/pages/Booking.tsx");
  const en = source("../client/src/i18n/translations/en.ts");
  const es = source("../client/src/i18n/translations/es.ts");

  it("the quote page has the house/apartment choice, and a unit address switches it on its own", () => {
    expect(quote).toContain('useState<PropertyType>("house")');
    expect(quote).toContain("looksLikeUnitAddress(address)");
    expect(quote).toContain('if (unitAddress) setPropertyType("apartment");');
    // The lookup itself is off for units, not just its result.
    expect(quote).toMatch(/enabled:\s*propertyType === "house" && !looksLikeUnitAddress\(debouncedAddress\)/);
  });

  it("the quote page never auto-fills an implausible record, and says why", () => {
    expect(quote).toContain("const verifiedSqft = recordSqft && plausibleVerifiedSqft(enteredSqft, recordSqft) ? recordSqft : null;");
    expect(quote).toContain("const implausibleRecord = recordSqft && !verifiedSqft ? recordSqft : null;");
    expect(quote).toContain('data-testid="implausible-record"');
    expect(quote).toContain("t.quote.implausibleRecord.replace(");
    // No bare literal cap left behind: the shared constants bound the field.
    expect(quote).toContain("min={MIN_HOME_SQFT}");
    expect(quote).toContain("max={MAX_HOME_SQFT}");
    expect(quote).not.toContain("Math.min(10000,");
  });

  it("the quote page asks apartments for the unit's exact size before moving on", () => {
    expect(quote).toContain("const needsUnitSqft = isUnit && enteredSqft == null;");
    expect(quote).toContain('data-testid="unit-sqft-prompt"');
    expect(quote).toContain('data-testid="unit-sqft-required"');
    expect(quote).toContain("disabled={step === 1 && needsUnitSqft}");
    expect(quote).toContain('id="quote-exact-sqft"');
    expect(quote).toContain("acceptableSqft(e.target.value)");
    // The choice travels to the booking page.
    expect(quote).toContain("propertyType,\n    });");
  });

  it("the booking page reads the choice, detects a unit, and refuses an apartment without a size", () => {
    expect(booking).toContain('params.get("propertyType") === "apartment"');
    expect(booking).toContain("looksLikeUnitAddress(form.address)");
    expect(booking).toContain("const unitSqft = isUnit ? acceptableSqft(unitSqftText) : null;");
    expect(booking).toContain("const sqft = unitSqft ?? sqftParam ?? entrySqft(type, pricing);");
    expect(booking).toContain("if (isUnit && unitSqft === null) errs.unitSqft = t.booking.unitSqftInvalid;");
    expect(booking).toContain('data-testid="unit-sqft-block"');
    expect(booking).toMatch(/enabled:\s*propertyType === "house" && !looksLikeUnitAddress\(debouncedAddress\)/);
  });

  it("the prompts exist in both languages", () => {
    for (const key of ["unitSqftPrompt", "unitSqftRequired", "unitDetected", "implausibleRecord", "exactSqft", "sqftOutOfRange"]) {
      expect(en, key).toMatch(new RegExp(`\\b${key}:`));
      expect(es, key).toMatch(new RegExp(`\\b${key}:`));
    }
    for (const key of ["unitSqftLabel", "unitSqftHint", "unitSqftInvalid"]) {
      expect(en, key).toMatch(new RegExp(`\\b${key}:`));
      expect(es, key).toMatch(new RegExp(`\\b${key}:`));
    }
    expect(en).toContain("{sqft} sq ft for this address");
    expect(es).toContain("{sqft} pies² para esta dirección");
  });
});
