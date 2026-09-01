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
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
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
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
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
import { censusAddressVerify, COUNTY_ADAPTERS, detectCounties } from "./property";
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

describe("Travis County via the US Census geocoder — address-verify-only", () => {
  /**
   * Fixtures are REAL responses, fetched live from
   * geocoding.geo.census.gov/geocoder/geographies/onelineaddress
   * (benchmark Public_AR_Current, vintage Current_Current, layers=Counties)
   * on 2026-08-18 for the two spec addresses, trimmed to the fields the
   * adapter reads.
   */
  const censusMatch = (overrides: Record<string, unknown> = {}) => ({
    tigerLine: { side: "L", tigerLineId: "656281944" },
    geographies: {
      Counties: [
        {
          GEOID: "48453",
          STATE: "48",
          BASENAME: "Travis",
          NAME: "Travis County",
          COUNTY: "453",
          FUNCSTAT: "A",
          MTFCC: "G4020",
        },
      ],
    },
    coordinates: { x: -97.739752095692, y: 30.276444701663 },
    addressComponents: {
      zip: "78701",
      streetName: "CONGRESS",
      preType: "",
      city: "AUSTIN",
      preDirection: "",
      suffixDirection: "",
      fromAddress: "1100",
      state: "TX",
      suffixType: "AVE",
      toAddress: "1498",
      suffixQualifier: "",
      preQualifier: "",
    },
    matchedAddress: "1100 CONGRESS AVE, AUSTIN, TX, 78701",
    ...overrides,
  });
  const censusResponse = (matches: unknown[]) => ({
    result: {
      input: {
        benchmark: { id: "4", benchmarkName: "Public_AR_Current", isDefault: true },
        vintage: { id: "4", vintageName: "Current_Current", isDefault: true },
      },
      addressMatches: matches,
    },
  });

  it("Austin addresses detect to Travis, through the adapter table", () => {
    expect(detectCounties("Austin", "78704")).toEqual(["travis"]);
    expect(COUNTY_ADAPTERS.travis).toBeTypeOf("function");
  });

  it("verifies 1100 Congress Ave against the real response shape", async () => {
    stubFetch(censusResponse([censusMatch()]));
    const result = await censusAddressVerify("travis", "1100 Congress Ave", "78701", "Austin");
    expect(result).toMatchObject({
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: "census_geocoder",
      county: "Travis",
      matchedAddress: "1100 CONGRESS AVE, AUSTIN, TX, 78701",
    });
    // Never a square footage: the Census knows where homes are, not how big.
    expect(result.sqft).toBeUndefined();
  });

  it("verifies 6001 Shoal Creek Blvd against the real response shape", async () => {
    stubFetch(
      censusResponse([
        censusMatch({
          matchedAddress: "6001 SHOAL CREEK BLVD, AUSTIN, TX, 78757",
          addressComponents: {
            zip: "78757",
            streetName: "SHOAL CREEK",
            suffixType: "BLVD",
            city: "AUSTIN",
            state: "TX",
            fromAddress: "5701",
            toAddress: "6099",
          },
        }),
      ])
    );
    const result = await censusAddressVerify("travis", "6001 Shoal Creek Blvd", "78757", "Austin");
    expect(result).toMatchObject({
      addressVerified: true,
      matchedAddress: "6001 SHOAL CREEK BLVD, AUSTIN, TX, 78757",
    });
  });

  it("its outcome shape is identical to a CAD county's (Comal contract)", async () => {
    stubFetch(censusResponse([censusMatch()]));
    const travis = await censusAddressVerify("travis", "1100 Congress Ave", "78701");
    expect({ ...travis, source: "comal_cad", county: "Comal", matchedAddress: "x" }).toEqual({
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: "comal_cad",
      county: "Comal",
      matchedAddress: "x",
    });
  });

  it("refuses a match the geocoder places in the wrong county", async () => {
    // Same street name exists in Williamson — a plausible-looking match with
    // the wrong county context is somebody else's street.
    stubFetch(
      censusResponse([
        censusMatch({
          geographies: {
            Counties: [{ GEOID: "48491", BASENAME: "Williamson", NAME: "Williamson County" }],
          },
        }),
      ])
    );
    const result = await censusAddressVerify("travis", "1100 Congress Ave", "78701");
    expect(result).toMatchObject({ verified: false, reason: "not_found" });
  });

  it("refuses sloppy matches — wrong street with the right number, wrong number", async () => {
    stubFetch(
      censusResponse([censusMatch({ matchedAddress: "1100 CONGRESSIONAL LOOP, AUSTIN, TX, 78701" })])
    );
    expect((await censusAddressVerify("travis", "1100 Congress Ave", "78701")).reason).toBe("not_found");
    stubFetch(
      censusResponse([censusMatch({ matchedAddress: "1102 CONGRESS AVE, AUSTIN, TX, 78701" })])
    );
    expect((await censusAddressVerify("travis", "1100 Congress Ave", "78701")).reason).toBe("not_found");
  });

  it("falls back gracefully on timeout, unreachable host, and empty results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));
    expect(await censusAddressVerify("travis", "1100 Congress Ave", "78701")).toEqual({
      verified: false,
      reason: "not_found",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
    expect((await censusAddressVerify("travis", "1100 Congress Ave", "78701")).verified).toBe(false);
    stubFetch(censusResponse([]));
    expect((await censusAddressVerify("travis", "1100 Congress Ave", "78701")).reason).toBe("not_found");
    stubFetch({ result: {} });
    expect((await censusAddressVerify("travis", "1100 Congress Ave", "78701")).reason).toBe("not_found");
  });

  it("queries the Census geocoder with the documented parameters, city and ZIP included", async () => {
    const impl = stubFetch(censusResponse([]));
    await censusAddressVerify("travis", "1100 Congress Ave", "78701", "Austin");
    const url = String(impl.mock.calls[0]![0]);
    expect(url).toContain("geocoding.geo.census.gov");
    expect(url).toContain("benchmark=Public_AR_Current");
    expect(url).toContain("format=json");
    expect(url).toContain("layers=Counties");
    expect(url).toContain(encodeURIComponent("1100 Congress Ave, Austin, TX, 78701").replace(/%20/g, "+"));
    expect(url).not.toContain("traviscountytx");
    expect(url).not.toContain("EXTERNAL_tcad_parcel");
  });

  it("refuses an unparseable address without touching the network", async () => {
    const impl = stubFetch(censusResponse([]));
    const result = await censusAddressVerify("travis", "no house number here");
    expect(result.reason).toBe("unparseable");
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("Hays County — the second Census verify-only county", () => {
  /**
   * Fixture mirrors the real geocoder response shape (see the Travis fixtures
   * above), with Hays County's own geography codes (GEOID 48209).
   */
  const haysMatch = (overrides: Record<string, unknown> = {}) => ({
    tigerLine: { side: "L", tigerLineId: "63701277" },
    geographies: {
      Counties: [
        {
          GEOID: "48209",
          STATE: "48",
          BASENAME: "Hays",
          NAME: "Hays County",
          COUNTY: "209",
          FUNCSTAT: "A",
          MTFCC: "G4020",
        },
      ],
    },
    coordinates: { x: -97.9436, y: 29.8833 },
    addressComponents: {
      zip: "78666",
      streetName: "LBJ",
      preType: "",
      city: "SAN MARCOS",
      preDirection: "N",
      suffixDirection: "",
      fromAddress: "100",
      state: "TX",
      suffixType: "DR",
      toAddress: "198",
      suffixQualifier: "",
      preQualifier: "",
    },
    matchedAddress: "100 N LBJ DR, SAN MARCOS, TX, 78666",
    ...overrides,
  });
  const haysResponse = (matches: unknown[]) => ({
    result: {
      input: {
        benchmark: { id: "4", benchmarkName: "Public_AR_Current", isDefault: true },
        vintage: { id: "4", vintageName: "Current_Current", isDefault: true },
      },
      addressMatches: matches,
    },
  });

  it("its cities and ZIPs detect to Hays, through the adapter table", () => {
    expect(detectCounties("Kyle", "78640")).toEqual(["hays"]);
    expect(detectCounties("Buda", "78610")).toEqual(["hays"]);
    expect(detectCounties("Dripping Springs", "78620")).toEqual(["hays"]);
    expect(detectCounties("San Marcos", undefined)).toEqual(["hays"]);
    // 78666 straddles the Guadalupe line: Hays leads because the city agrees,
    // and the miss in one county falls through to the other.
    expect(detectCounties("San Marcos", "78666")[0]).toBe("hays");
    expect(detectCounties("San Marcos", "78666")).toContain("guadalupe");
    expect(COUNTY_ADAPTERS.hays).toBeTypeOf("function");
  });

  it("verifies a San Marcos address against the fixture, sqft staying customer-entered", async () => {
    stubFetch(haysResponse([haysMatch()]));
    const result = await censusAddressVerify("hays", "100 N LBJ Dr", "78666", "San Marcos");
    expect(result).toMatchObject({
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: "census_geocoder",
      county: "Hays",
      matchedAddress: "100 N LBJ DR, SAN MARCOS, TX, 78666",
    });
    expect(result.sqft).toBeUndefined();
  });

  it("refuses a plausible match the geocoder places outside Hays", async () => {
    stubFetch(
      haysResponse([
        haysMatch({
          geographies: {
            Counties: [{ GEOID: "48453", BASENAME: "Travis", NAME: "Travis County" }],
          },
        }),
      ])
    );
    const result = await censusAddressVerify("hays", "100 N LBJ Dr", "78666");
    expect(result).toMatchObject({ verified: false, reason: "not_found" });
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
      source: "census_geocoder",
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
    mockLookupProperty.mockResolvedValue({ verified: true, sqft: 2400, source: "census_geocoder" });
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
    // Now with the friendly fallback for slotless leads that have no address.
    expect(admin).toContain('composeAddressOr(');
    expect(admin).toContain('"No address yet"');
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
