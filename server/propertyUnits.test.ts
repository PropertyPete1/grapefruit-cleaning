/**
 * Travis County coverage, apartment/unit handling, and the plausibility guard.
 *
 * The thread joining the three: county parcels are BUILDING-level records.
 * Travis extends where verification reaches; the apartment flag turns it off
 * where it can only mislead (a unit's lookup finds the complex or nothing);
 * and the >4x guard catches the same false positive when it arrives without
 * the flag — a house lookup returning the strip mall next door.
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
const mockConfirmUnpaid = vi.fn();

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
    getCustomerById: vi.fn().mockResolvedValue({
      id: 7,
      firstName: "Maria",
      lastName: "Lopez",
      email: "maria@example.com",
      phone: "5125550134",
    }),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
    createPayment: vi.fn(),
    incrementCouponRedemptions: vi.fn(),
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
import { composeAddress, plausibleVerifiedSqft } from "@shared/property";
import { _resetRateLimits } from "./antiSpam";
import { __resetTransporter } from "./emails";
import {
  COUNTY_ADAPTERS,
  detectCounties,
  lookupTravisProperty,
} from "./property";
import { resolveEffectiveSqft } from "./adminBooking";
import { adminRouter } from "./routers/admin";
import { bookingRouter, finalizeBooking } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "e".repeat(48);

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
    sqft: 800,
    extras: [],
    frequency: "onetime" as const,
  },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Maria",
  lastName: "Lopez",
  email: "maria@example.com",
  phone: "5125550134",
  address: "800 Congress Ave",
  city: "Austin",
  zip: "78701",
  locale: "en" as const,
};

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const patched = () =>
  Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>));

const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-UNIT1",
  customerId: 7,
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

/** ArcGIS-shaped fetch stub for the Travis adapter. */
function stubFetch(payload: unknown, ok = true) {
  const impl = vi.fn().mockResolvedValue({ ok, json: async () => payload });
  vi.stubGlobal("fetch", impl);
  return impl;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Travis County (TCAD) adapter", () => {
  it("Austin addresses detect to Travis, through the adapter table", () => {
    expect(detectCounties("Austin", "78704")).toEqual(["travis"]);
    expect(COUNTY_ADAPTERS.travis).toBeTypeOf("function");
  });

  it("verifies square footage when the parcel layer carries a living area", async () => {
    stubFetch({
      features: [
        { attributes: { SITUS_ADDRESS: "800 CONGRESS AVE", LIVING_AREA: "1740", OTHER: "x" } },
      ],
    });
    const result = await lookupTravisProperty("800 Congress Ave");
    expect(result).toMatchObject({
      verified: true,
      sqft: 1740,
      source: "travis_cad",
      county: "Travis",
      matchedAddress: "800 CONGRESS AVE",
    });
  });

  it("reads alternate field spellings the county has used", async () => {
    stubFetch({ features: [{ attributes: { SITUS: "12 OAK LN", BLDG_SQFT: 2210 } }] });
    const result = await lookupTravisProperty("12 Oak Ln");
    expect(result).toMatchObject({ verified: true, sqft: 2210 });
  });

  it("degrades to address verification when the layer has no sqft fields", async () => {
    stubFetch({ features: [{ attributes: { SITUS_ADDRESS: "800 CONGRESS AVE", ZONING: "CBD" } }] });
    const result = await lookupTravisProperty("800 Congress Ave");
    expect(result).toMatchObject({
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: "travis_cad",
    });
  });

  it("falls back gracefully on service errors, empty results, and network failure", async () => {
    stubFetch({ error: { code: 500 } });
    expect((await lookupTravisProperty("800 Congress Ave")).verified).toBe(false);
    stubFetch({ features: [] });
    expect((await lookupTravisProperty("800 Congress Ave")).reason).toBe("not_found");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const result = await lookupTravisProperty("800 Congress Ave");
    expect(result).toEqual({ verified: false, reason: "not_found" });
  });

  it("refuses an unparseable address without touching the network", async () => {
    const impl = stubFetch({ features: [] });
    const result = await lookupTravisProperty("no house number here");
    expect(result.reason).toBe("unparseable");
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("the plausibility guard", () => {
  it("accepts a record up to 4x the entered figure", () => {
    expect(plausibleVerifiedSqft(800, 3200)).toBe(true);
    expect(plausibleVerifiedSqft(800, 3201)).toBe(false);
    expect(plausibleVerifiedSqft(800, 12000)).toBe(false);
  });

  it("has no opinion without a baseline", () => {
    expect(plausibleVerifiedSqft(null, 50000)).toBe(true);
    expect(plausibleVerifiedSqft(undefined, 50000)).toBe(true);
  });

  it("keeps the entered figure in resolveEffectiveSqft when the record is absurd", () => {
    const absurd = resolveEffectiveSqft({
      enteredSqft: 800,
      verifiedSqft: 41000, // the whole complex
      serviceType: "residential",
      pricing: DEFAULT_PRICING,
    });
    expect(absurd).toEqual({ sqft: 800, corrected: false });
    // A believable record still wins upward.
    const believable = resolveEffectiveSqft({
      enteredSqft: 800,
      verifiedSqft: 2400,
      serviceType: "residential",
      pricing: DEFAULT_PRICING,
    });
    expect(believable).toEqual({ sqft: 2400, corrected: true });
  });

  it("public booking.create treats an absurd record as a failed lookup", async () => {
    mockLookupProperty.mockResolvedValue({
      verified: true,
      sqft: 41000,
      source: "travis_cad",
    });
    await publicCaller().create(publicInput);
    const entered = calculateQuote(publicInput.quote, DEFAULT_PRICING);
    expect(written().sqft).toBe(800);
    expect(written().sqftMismatch).toBe(false);
    expect(written().totalAmount).toBe(entered.total);
  });

  it("still reprices a house upward from a believable record — tampering unaffected", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2400, source: "bexar_gis" });
    await publicCaller().create({ ...publicInput, city: "San Antonio", zip: "78230" });
    expect(written().sqft).toBe(2400);
    expect(written().sqftMismatch).toBe(true);
  });
});

describe("apartments never verify", () => {
  it("public flow: the lookup is not even attempted", async () => {
    await publicCaller().create({
      ...publicInput,
      propertyType: "apartment",
      unitNumber: "204",
    });
    expect(mockLookupProperty).not.toHaveBeenCalled();
    expect(written().sqft).toBe(800);
    expect(written().propertyType).toBe("apartment");
    expect(written().unitNumber).toBe("204");
    expect(written().verifiedSqft).toBeUndefined();
  });

  it("public flow: houses still verify (the default)", async () => {
    await publicCaller().create(publicInput);
    expect(mockLookupProperty).toHaveBeenCalled();
    expect(written().propertyType).toBe("house");
  });

  it("admin form: apartment with an address skips the county entirely", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Maria",
      phone: "5125550134",
      serviceType: "residential",
      sqft: 750,
      address: "1200 Barton Springs Rd",
      propertyType: "apartment",
      unitNumber: "5B",
      city: "Austin",
      zip: "78704",
    });
    expect(mockLookupProperty).not.toHaveBeenCalled();
    expect(written().sqft).toBe(750);
    expect(written().unitNumber).toBe("5B");
    expect(result.sqftCorrected).toBe(false);
  });

  it("link flow: an apartment address is stored without a lookup", async () => {
    await payCaller().updateDetails({
      token: TOKEN,
      propertyType: "apartment",
      unitNumber: "204",
      sqft: 700,
      address: "1200 Barton Springs Rd",
      city: "Austin",
      zip: "78704",
    });
    expect(mockLookupProperty).not.toHaveBeenCalled();
    expect(patched()).toMatchObject({
      propertyType: "apartment",
      unitNumber: "204",
      addressLine: "1200 Barton Springs Rd",
      sqft: 700,
    });
  });

  it("link flow: a house address still verifies", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2400, source: "travis_cad" });
    await payCaller().updateDetails({ token: TOKEN, address: "12 Oak Ln", city: "Austin", zip: "78704" });
    expect(mockLookupProperty).toHaveBeenCalled();
    expect(patched()).toMatchObject({ verifiedSqft: 2400 });
  });

  it("a locked size refuses the property-type switch — no back door", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ sqft: 2400, verifiedSqft: 2400, adminProvided: "service,size" })
    );
    await expect(
      payCaller().updateDetails({ token: TOKEN, propertyType: "apartment" })
    ).rejects.toThrow(/give us a call/i);
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 700 })).rejects.toThrow(/give us a call/i);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("but the unit number stays editable — crew information, not a price lever", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ sqft: 2400, adminProvided: "service,size,address", addressLine: "1 Main St" })
    );
    await payCaller().updateDetails({ token: TOKEN, unitNumber: "204" });
    expect(patched()).toMatchObject({ unitNumber: "204" });
  });
});

describe("the unit number reaches the crew", () => {
  it("composeAddress renders it between street and city", () => {
    expect(
      composeAddress({ addressLine: "1 Main St", unitNumber: "204", city: "Austin", zip: "78704" })
    ).toBe("1 Main St, Apt 204, Austin, 78704");
    // A unit that names its own designator renders as typed.
    expect(composeAddress({ addressLine: "1 Main St", unitNumber: "Ste 300", city: "Austin" })).toBe(
      "1 Main St, Ste 300, Austin"
    );
    expect(composeAddress({ addressLine: "1 Main St", unitNumber: "#12", city: "Austin" })).toBe(
      "1 Main St, #12, Austin"
    );
    // No unit, no artifact.
    expect(composeAddress({ addressLine: "1 Main St", city: "Austin" })).toBe("1 Main St, Austin");
  });

  it("the confirmation and owner emails carry it", async () => {
    vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
    mockConfirmUnpaid.mockResolvedValue(true);
    mockGetBookingById.mockResolvedValue(
      linkRow({
        sqft: 700,
        scheduledDate: OPEN_MONDAY,
        scheduledTime: "10:00",
        estimatedHours: 2,
        totalAmount: 90,
        depositAmount: 18,
        addressLine: "1200 Barton Springs Rd",
        unitNumber: "204",
        propertyType: "apartment",
        city: "Austin",
        zip: "78704",
      })
    );
    await finalizeBooking(99, "pi_unit_1");
    const bodies = mockSendMail.mock.calls.map(c => (c[0] as { text: string }).text).join("\n");
    expect(bodies).toContain("Apt 204");
  });

  it("the customer link page shows it in the locked address", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ addressLine: "1200 Barton Springs Rd", unitNumber: "204", city: "Austin" })
    );
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.address).toBe("1200 Barton Springs Rd, Apt 204, Austin");
  });

  it("the admin table and staff cards render through composeAddress", () => {
    const admin = readFileSync(
      fileURLToPath(new URL("../client/src/pages/admin/AdminAppointments.tsx", import.meta.url)),
      "utf-8"
    );
    const staff = readFileSync(
      fileURLToPath(new URL("../client/src/pages/staff/StaffRoutes.tsx", import.meta.url)),
      "utf-8"
    );
    expect(admin).toContain("composeAddress({ addressLine: b.addressLine, unitNumber: b.unitNumber, city: b.city })");
    expect(staff).toContain("composeAddress(booking)");
  });
});

describe("exact square footage", () => {
  const dialog = readFileSync(
    fileURLToPath(new URL("../client/src/pages/admin/NewBookingDialog.tsx", import.meta.url)),
    "utf-8"
  );
  const payPage = readFileSync(
    fileURLToPath(new URL("../client/src/pages/PayDeposit.tsx", import.meta.url)),
    "utf-8"
  );

  it("admin form takes an exact number on a numeric keypad, clamped 200–20,000", () => {
    expect(dialog).toMatch(/type="number"[\s\S]{0,120}inputMode="numeric"[\s\S]{0,240}min=\{200\}[\s\S]{0,60}max=\{20000\}/);
    expect(dialog).toContain("Math.min(20000, Math.max(200, Number(sqft)))");
    expect(dialog).not.toContain('type="range"');
  });

  it("the customer link keeps its slider but adds tap-to-type", () => {
    expect(payPage).toContain('type="range"');
    expect(payPage).toMatch(/type="number"[\s\S]{0,160}inputMode="numeric"/);
  });

  it("both public previews run the same plausibility guard the server runs", () => {
    // Quote auto-fills its slider from the verified record and Booking
    // reprices its preview — a guard applied server-side only would still show
    // customers a complex-parcel price before the server corrected it.
    const quote = readFileSync(
      fileURLToPath(new URL("../client/src/pages/Quote.tsx", import.meta.url)),
      "utf-8"
    );
    const booking = readFileSync(
      fileURLToPath(new URL("../client/src/pages/Booking.tsx", import.meta.url)),
      "utf-8"
    );
    expect(quote).toContain("plausibleVerifiedSqft(");
    expect(booking).toContain("plausibleVerifiedSqft(");
  });

  it("the server clamps whatever arrives", async () => {
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 50 })).rejects.toThrow();
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 250000 })).rejects.toThrow();
    await expect(
      adminCaller().createBooking({ firstName: "M", phone: "5125550134", sqft: 25000 })
    ).rejects.toThrow();
  });
});
