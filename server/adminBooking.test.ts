/**
 * Admin-created bookings and their deposit links.
 *
 * The owner takes a price request by phone or text, enters the basics, and
 * sends a personal link. The CUSTOMER opens it, picks their own extras, and
 * pays the deposit.
 *
 * The property this file exists to pin: NO PRICE EVER COMES FROM A CLIENT. The
 * admin form has no amount field, the pay page sends extra IDs and nothing
 * else, and both paths recompute every figure from the live pricing config. A
 * tampered payload can change which extras someone is buying; it cannot change
 * what they cost.
 *
 * The second property: an admin booking is a real booking from the moment it is
 * created. It holds its slot under the same rules as a self-serve one — just
 * for longer, because a phone lead needs the evening to decide rather than the
 * hour an abandoned checkout gets.
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
const mockGetCouponByCode = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();
const mockListBookings = vi.fn();

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
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    findOrCreateCustomer: vi.fn().mockResolvedValue(7),
    getCustomerById: vi.fn().mockResolvedValue({
      id: 7,
      firstName: "Ana",
      lastName: "Lopez",
      email: "ana@example.com",
      phone: "2105550000",
    }),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    isSlotTakenError: () => false,
    listInvoices: vi.fn().mockResolvedValue([]),
    listInvoicesAwaitingApproval: vi.fn().mockResolvedValue([]),
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

import { DEFAULT_PRICING, calculateQuote, depositFor } from "@shared/pricing";
import { ADMIN_HOLD_SETTING_KEY } from "@shared/holdWindow";
import { LEAD_TIME_SETTING_KEY, MAX_LEAD_TIME_HOURS, slotStartInstant } from "@shared/leadTime";
import { LUNCH_SETTING_KEY } from "@shared/schedule";
import { _resetRateLimits } from "./antiSpam";
import { blocksSlot, holdMinutesFor, STALE_DEPOSIT_MINUTES } from "./bookingRules";
import { depositLinkStatus, depositLinkExpiresAt, depositSessionSeconds } from "./depositLinkRules";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "a".repeat(48);

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

const input = {
  serviceType: "residential" as const,
  frequency: "onetime" as const,
  bedrooms: 3,
  bathrooms: 2,
  sqft: 1200,
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  address: "1 Main St",
  city: "San Antonio",
  zip: "78201",
  locale: "en" as const,
  sendEmail: false,
};

/** The row createBooking was called with. */
const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;

/** A pending admin booking as the DB would return it. */
const pendingBooking = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GF-TEST",
  customerId: 7,
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "10:00",
  bedrooms: 3,
  bathrooms: 2,
  sqft: 1200,
  extras: "[]",
  addressLine: "1 Main St",
  city: "San Antonio",
  zip: "78201",
  locale: "en",
  totalAmount: 112,
  depositAmount: 22,
  status: "pending_deposit",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: 3,
  kind: "admin",
  holdMinutes: 24 * 60,
  payToken: TOKEN,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockImplementation(async () => null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetCouponByCode.mockResolvedValue(undefined);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_admin_1", url: "https://stripe.test/pay" });
  mockGetBookingByPayToken.mockResolvedValue(pendingBooking());
  mockGetBookingById.mockResolvedValue(pendingBooking());
  mockListBookings.mockResolvedValue([]);
});

describe("creating the booking", () => {
  it("prices it server-side from the live config, with no extras", async () => {
    const result = await adminCaller().createBooking(input);
    const expected = calculateQuote(
      { type: "residential", bedrooms: 3, bathrooms: 2, sqft: 1200, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(result.basePrice).toBe(expected.total);
    expect(result.deposit).toBe(depositFor(expected.total, DEFAULT_PRICING.depositRate));
    expect(written().totalAmount).toBe(expected.total);
  });

  it("stores no extras — those are the customer's to pick", async () => {
    await adminCaller().createBooking(input);
    expect(written().extras).toBe("[]");
  });

  it("takes no price from the caller", async () => {
    // The mutation has no field to put one in. If a price ever becomes an
    // input, this fails and someone has to justify it.
    await expect(
      // @ts-expect-error deliberately passing a price the schema must reject
      adminCaller().createBooking({ ...input, totalAmount: 1, depositAmount: 1 })
    ).resolves.toBeDefined();
    expect(written().totalAmount).not.toBe(1);
    expect(written().depositAmount).not.toBe(1);
  });

  it("marks the row as admin-created and holds the slot", async () => {
    await adminCaller().createBooking(input);
    expect(written().kind).toBe("admin");
    expect(written().status).toBe("pending_deposit");
  });

  it("issues a token and an expiry, and returns a shareable link", async () => {
    const result = await adminCaller().createBooking(input);
    expect(String(written().payToken)).toHaveLength(48);
    expect(written().payTokenExpiresAt).toBeInstanceOf(Date);
    expect(result.payUrl).toBe(`${ORIGIN}/pay/deposit/${written().payToken}`);
  });

  it("pins the estimated duration like the public flow does", async () => {
    await adminCaller().createBooking(input);
    expect(written().estimatedHours).toBe(3);
  });

  it("copies the language choice onto the booking", async () => {
    await adminCaller().createBooking({ ...input, locale: "es" });
    expect(written().locale).toBe("es");
  });
});

describe("verified square footage", () => {
  it("prices from the county figure when it prices higher", async () => {
    mockLookupProperty.mockResolvedValue({
      verified: true,
      addressVerified: true,
      sqft: 2400,
      source: "bexar_gis",
    });
    const result = await adminCaller().createBooking(input);
    const verified = calculateQuote(
      { type: "residential", bedrooms: 3, bathrooms: 2, sqft: 2400, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(result.basePrice).toBe(verified.total);
    expect(result.sqftCorrected).toBe(true);
    expect(written().sqft).toBe(2400);
    expect(written().sqftMismatch).toBe(true);
  });

  it("keeps the entered figure when county records price lower", async () => {
    // Understating loses; overstating is not "corrected" downward, because the
    // owner may know something the county record does not.
    mockLookupProperty.mockResolvedValue({
      verified: true,
      addressVerified: true,
      sqft: 600,
      source: "bexar_gis",
    });
    const result = await adminCaller().createBooking(input);
    expect(written().sqft).toBe(1200);
    expect(result.sqftCorrected).toBe(false);
  });

  it("carries on when the county lookup finds nothing", async () => {
    mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
    await expect(adminCaller().createBooking(input)).resolves.toMatchObject({ reference: expect.any(String) });
  });
});

describe("the scheduling rules", () => {
  it("refuses a closed day", async () => {
    // The Sunday after the fixture Monday.
    const sunday = new Date(`${OPEN_MONDAY}T00:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    await expect(
      adminCaller().createBooking({ ...input, date: sunday.toISOString().slice(0, 10) })
    ).rejects.toThrow(/not bookable/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("refuses an hour the schedule never offers", async () => {
    await expect(adminCaller().createBooking({ ...input, time: "05:00" })).rejects.toThrow(/not bookable/i);
  });

  it("refuses the lunch hour when the owner has reserved it", async () => {
    mockGetSetting.mockImplementation(async (key: string) => (key === LUNCH_SETTING_KEY ? "true" : null));
    await expect(adminCaller().createBooking({ ...input, time: "12:00" })).rejects.toThrow(/not bookable/i);
  });

  it("refuses a slot another booking already occupies", async () => {
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "09:00", serviceType: "deep", sqft: 1200, estimatedHours: 4, status: "confirmed", createdAt: new Date() },
    ]);
    await expect(adminCaller().createBooking(input)).rejects.toThrow(/not bookable/i);
  });

  it("refuses a job that would run past closing", async () => {
    await expect(adminCaller().createBooking({ ...input, time: "17:00" })).rejects.toThrow(/not bookable/i);
  });
});

describe("the notice-period override", () => {
  const soon = { ...input, date: OPEN_MONDAY, time: "10:00" };

  beforeEach(() => {
    // Notice period at its 72-hour maximum, with the clock a day before the
    // slot: the appointment is real and in the future, and the rule still
    // refuses it. That is exactly the customer standing on the phone asking
    // for tomorrow morning.
    mockGetSetting.mockImplementation(async (key: string) =>
      key === LEAD_TIME_SETTING_KEY ? String(MAX_LEAD_TIME_HOURS) : null
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(slotStartInstant(OPEN_MONDAY, "10:00") - 24 * 3_600_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a slot inside the notice period without it", async () => {
    await expect(adminCaller().createBooking(soon)).rejects.toThrow(/not bookable/i);
  });

  it("takes the same slot with it", async () => {
    await expect(
      adminCaller().createBooking({ ...soon, overrideNotice: true })
    ).resolves.toMatchObject({ reference: expect.any(String) });
  });

  it("overrides that one rule and no others", async () => {
    // Closing time still applies with the override on.
    await expect(
      adminCaller().createBooking({ ...soon, time: "17:00", overrideNotice: true })
    ).rejects.toThrow(/not bookable/i);
    // And so does an occupied slot.
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 2, status: "confirmed", createdAt: new Date() },
    ]);
    await expect(
      adminCaller().createBooking({ ...soon, overrideNotice: true })
    ).rejects.toThrow(/not bookable/i);
  });

  it("does not open the past", async () => {
    await expect(
      adminCaller().createBooking({ ...soon, date: "2020-01-06", overrideNotice: true })
    ).rejects.toThrow(/not bookable/i);
  });
});

describe("the deposit link's slot hold", () => {
  it("holds for 24 hours by default, where the public flow holds for 15 minutes", async () => {
    await adminCaller().createBooking(input);
    expect(written().holdMinutes).toBe(24 * 60);
    expect(STALE_DEPOSIT_MINUTES).toBe(15);
  });

  it("takes the configured window when the owner sets one", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === ADMIN_HOLD_SETTING_KEY ? "48" : null
    );
    await adminCaller().createBooking(input);
    expect(written().holdMinutes).toBe(48 * 60);
  });

  it("falls back to 24 hours on a corrupt setting rather than to one hour", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === ADMIN_HOLD_SETTING_KEY ? "not-a-number" : null
    );
    await adminCaller().createBooking(input);
    expect(written().holdMinutes).toBe(24 * 60);
  });

  it("expires the link exactly when the hold ends", async () => {
    await adminCaller().createBooking(input);
    const created = written();
    const expires = created.payTokenExpiresAt as Date;
    // Same promise, one clock: a token outliving the hold would take money for
    // a slot already given away.
    expect(expires.getTime() - Date.now()).toBeGreaterThan(23.5 * 3_600_000);
    expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  });
});

describe("the release logic honours each booking's own window", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("releases a public booking after an hour", () => {
    expect(blocksSlot({ status: "pending_deposit", createdAt: minutesAgo(61), holdMinutes: null }, now)).toBe(false);
  });

  it("still holds an admin booking at the same age", () => {
    expect(blocksSlot({ status: "pending_deposit", createdAt: minutesAgo(61), holdMinutes: 24 * 60 }, now)).toBe(true);
  });

  it("releases the admin booking once its own day is up", () => {
    expect(blocksSlot({ status: "pending_deposit", createdAt: minutesAgo(24 * 60 + 1), holdMinutes: 24 * 60 }, now)).toBe(false);
  });

  it("treats a row written before the column existed as a public one", () => {
    expect(holdMinutesFor({})).toBe(STALE_DEPOSIT_MINUTES);
    expect(holdMinutesFor({ holdMinutes: null })).toBe(STALE_DEPOSIT_MINUTES);
    expect(holdMinutesFor({ holdMinutes: 0 })).toBe(STALE_DEPOSIT_MINUTES);
  });

  it("leaves confirmed and cancelled bookings alone whatever their window", () => {
    expect(blocksSlot({ status: "confirmed", createdAt: minutesAgo(99_999), holdMinutes: 60 }, now)).toBe(true);
    expect(blocksSlot({ status: "cancelled", createdAt: minutesAgo(1), holdMinutes: 24 * 60 }, now)).toBe(false);
  });
});

describe("resending the link", () => {
  it("issues a new token so a forwarded old link stops working", async () => {
    const before = pendingBooking();
    mockGetBookingById.mockResolvedValue(before);
    const result = await adminCaller().resendDepositLink({ id: 99 });
    const patch = mockUpdateBooking.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.payToken).not.toBe(before.payToken);
    expect(result.payUrl).toContain(String(patch.payToken));
  });

  it("moves the slot hold along with the link window", async () => {
    // The hold is measured from createdAt, which a resend cannot change. If
    // only the token expiry moved, the email would promise to hold a time the
    // scheduler had already put back on the calendar.
    const createdAt = new Date(Date.now() - 20 * 3_600_000);
    mockGetBookingById.mockResolvedValue(pendingBooking({ createdAt, holdMinutes: 24 * 60 }));
    await adminCaller().resendDepositLink({ id: 99 });
    const patch = mockUpdateBooking.mock.calls[0]![1] as Record<string, unknown>;
    const expiresAt = patch.payTokenExpiresAt as Date;
    const holdEnds = createdAt.getTime() + (patch.holdMinutes as number) * 60_000;
    expect(holdEnds).toBeGreaterThanOrEqual(expiresAt.getTime() - 60_000);
    expect(blocksSlot({ status: "pending_deposit", createdAt, holdMinutes: patch.holdMinutes as number })).toBe(true);
  });

  it("never shortens an existing hold", async () => {
    const createdAt = new Date(Date.now() - 1000);
    mockGetBookingById.mockResolvedValue(pendingBooking({ createdAt, holdMinutes: 48 * 60 }));
    await adminCaller().resendDepositLink({ id: 99 });
    const patch = mockUpdateBooking.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.holdMinutes as number).toBeGreaterThanOrEqual(48 * 60);
  });

  it("refuses a booking that is already paid", async () => {
    mockGetBookingById.mockResolvedValue(pendingBooking({ status: "confirmed" }));
    await expect(adminCaller().resendDepositLink({ id: 99 })).rejects.toThrow(/no longer awaiting/i);
  });

  it("refuses a self-serve booking, which has no link to resend", async () => {
    mockGetBookingById.mockResolvedValue(pendingBooking({ kind: "self_serve" }));
    await expect(adminCaller().resendDepositLink({ id: 99 })).rejects.toThrow(/phone bookings/i);
  });
});

describe("the expiry SQL", () => {
  const source = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf-8");

  it("compares each row against its own window", () => {
    expect(source).toContain("COALESCE(${bookings.holdMinutes}, ${STALE_DEPOSIT_MINUTES})");
  });

  it("keeps bound values out of the INTERVAL expression", () => {
    // `createdAt + INTERVAL COALESCE(holdMinutes, 60) MINUTE <= ?` reads better
    // but compiles to a placeholder inside INTERVAL, which MySQL's
    // prepared-statement parser rejects on some versions.
    expect(source).toContain("TIMESTAMPDIFF(MINUTE,");
    expect(source).not.toMatch(/INTERVAL COALESCE\(\$\{/);
  });

  it("no longer uses one global cutoff for every row", () => {
    expect(source).not.toMatch(/const cutoff = new Date\(now\.getTime\(\) - STALE_DEPOSIT_MINUTES/);
  });
});
