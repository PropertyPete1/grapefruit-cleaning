/**
 * Progressive booking links: the owner enters what he knows, the customer
 * finishes the rest.
 *
 * What this file pins, per the redesign:
 *   - a name and a phone number alone produce a working link;
 *   - the page asks exactly the questions the owner left open, no more;
 *   - a fully pre-filled link behaves exactly like the original flow;
 *   - the customer's slot claim obeys every scheduling rule, and claiming is
 *     the moment inventory changes hands — before it, nothing is held and
 *     nothing can go stale-released;
 *   - locked facts refuse edits no matter what the request claims;
 *   - money is recomputed server-side at every step, tampering included;
 *   - the owner hears about it when a link he sent hours ago completes.
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
const mockFindOrCreateCustomer = vi.fn();
const mockExpireForSlot = vi.fn();
const mockListElapsedDepositBookings = vi.fn();
const mockConfirmUnpaid = vi.fn();
const mockCreatePayment = vi.fn();

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
    listElapsedDepositBookings: (...a: unknown[]) => mockListElapsedDepositBookings(...a),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
    createPayment: (...a: unknown[]) => mockCreatePayment(...a),
    incrementCouponRedemptions: vi.fn(),
    isSlotTakenError: actual.isSlotTakenError,
    listBookings: vi.fn().mockResolvedValue([]),
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

import { calculateQuote, DEFAULT_PRICING, depositFor } from "@shared/pricing";
import { LUNCH_SETTING_KEY } from "@shared/schedule";
import { slotStartInstant } from "@shared/leadTime";
import { _resetRateLimits } from "./antiSpam";
import { __resetTransporter, deliverEmail } from "./emails";
import { adminRouter } from "./routers/admin";
import { bookingRouter, finalizeBooking } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "d".repeat(48);

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

/** The row createBooking was called with. */
const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
/** Every patch updateBooking has applied, merged in order. */
const patched = () =>
  Object.assign({}, ...mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>));

/** A link row in a given state of completeness, as the DB would return it. */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-LINK1",
  customerId: 7,
  serviceType: null,
  frequency: "onetime",
  scheduledDate: null,
  scheduledTime: null,
  bedrooms: 2,
  bathrooms: 1,
  sqft: null,
  extras: "[]",
  addressLine: null,
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
  adminProvided: null,
  createdAt: new Date(),
  ...overrides,
});

const fullRow = (overrides: Record<string, unknown> = {}) =>
  linkRow({
    serviceType: "residential",
    sqft: 1200,
    scheduledDate: OPEN_MONDAY,
    scheduledTime: "10:00",
    estimatedHours: 3,
    totalAmount: 112,
    depositAmount: 22,
    addressLine: "1 Main St",
    city: "San Antonio",
    zip: "78201",
    adminProvided: "service,size,address,slot",
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
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
  mockListElapsedDepositBookings.mockResolvedValue([]);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the minimum viable lead", () => {
  it("a name and a phone number produce a working link", async () => {
    const result = await adminCaller().createBooking({ firstName: "Maria", phone: "2105550134" });
    expect(result.payUrl).toBe(`${ORIGIN}/pay/deposit/${written().payToken}`);
    expect(result.customerWillChoose).toEqual(["service", "size", "time"]);
    expect(result.basePrice).toBeNull();
    expect(written().kind).toBe("admin");
    expect(written().adminProvided).toBeUndefined();
  });

  it("a name and an email work too", async () => {
    await expect(
      adminCaller().createBooking({ firstName: "Maria", email: "maria@example.com" })
    ).resolves.toMatchObject({ reference: expect.any(String) });
  });

  it("a name alone does not — the link needs a way to reach them", async () => {
    await expect(adminCaller().createBooking({ firstName: "Maria" })).rejects.toThrow(/email or a phone/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("a date without a time is refused rather than guessed at", async () => {
    await expect(
      adminCaller().createBooking({ firstName: "Maria", phone: "2105550134", date: OPEN_MONDAY })
    ).rejects.toThrow(/both a date and a time/i);
  });

  it("holds nothing: no slot means NULL date and time, which the unique index ignores", async () => {
    await adminCaller().createBooking({ firstName: "Maria", phone: "2105550134" });
    expect(written().scheduledDate).toBeNull();
    expect(written().scheduledTime).toBeNull();
    // And no scheduling checks ran — there was nothing to check against.
    expect(mockGetOccupiedBookings).not.toHaveBeenCalled();
  });

  it("still runs every scheduling rule when the owner does pick a time", async () => {
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "09:00", serviceType: "deep", sqft: 1200, estimatedHours: 4, status: "confirmed", createdAt: new Date() },
    ]);
    await expect(
      adminCaller().createBooking({
        firstName: "Maria",
        phone: "2105550134",
        serviceType: "residential",
        sqft: 1200,
        date: OPEN_MONDAY,
        time: "10:00",
      })
    ).rejects.toThrow(/not bookable/i);
  });

  it("records which facts the owner locked", async () => {
    await adminCaller().createBooking({
      firstName: "Maria",
      phone: "2105550134",
      serviceType: "deep",
      date: OPEN_MONDAY,
      time: "10:00",
      sqft: 1500,
    });
    expect(written().adminProvided).toBe("service,size,slot");
  });

  it("lets county records settle the size when the owner gave only an address", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 2400, source: "bexar_gis" });
    const result = await adminCaller().createBooking({
      firstName: "Maria",
      phone: "2105550134",
      address: "1 Main St",
      city: "San Antonio",
      zip: "78201",
    });
    expect(written().sqft).toBe(2400);
    expect(written().adminProvided).toBe("size,address");
    expect(result.customerWillChoose).toEqual(["service", "time"]);
  });
});

describe("the page asks exactly what is missing", () => {
  it("everything, for a bare lead", async () => {
    const result = await payCaller().get({ token: TOKEN });
    expect(result.state).toBe("incomplete");
    expect(result.booking?.needs).toEqual({ service: true, size: true, slot: true });
    expect(result.booking?.customerFirstName).toBe("Maria");
    expect(result.booking?.total).toBeNull();
  });

  it("only the slot, when service and size are locked", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ serviceType: "residential", sqft: 1200, adminProvided: "service,size" })
    );
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.needs).toEqual({ service: false, size: false, slot: true });
    // Priceable already — the total shows before the time is picked.
    expect(result.booking?.total).toBeGreaterThan(0);
  });

  it("only the service, when the owner scoped everything else", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow({ serviceType: null, adminProvided: "size,address,slot" }));
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.needs).toEqual({ service: true, size: false, slot: false });
  });

  it("size is skipped when the owner's address county-verified", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ sqft: 2400, verifiedSqft: 2400, addressLine: "1 Main St", adminProvided: "size,address" })
    );
    const result = await payCaller().get({ token: TOKEN });
    expect(result.booking?.needs.size).toBe(false);
    expect(result.booking?.sqftVerified).toBe(true);
  });

  it("nothing, for a fully pre-filled link — exactly the original page", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow());
    const result = await payCaller().get({ token: TOKEN });
    expect(result.state).toBe("awaiting_payment");
    expect(result.booking?.needs).toEqual({ service: false, size: false, slot: false });
    expect(result.booking?.locks).toEqual({ service: true, size: true, address: true, slot: true });
    // The stored figure is ignored: get reprices from the live config, the
    // same as every other read.
    const live = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(result.booking?.total).toBe(live.total);
  });

  it("never returns the owner's notes, in any state", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      fullRow({ notes: "Haggler — quoted high.\n\nFrom customer: gate code 4411" })
    );
    const result = await payCaller().get({ token: TOKEN });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain("Haggler");
    expect(payload).not.toContain("quoted high");
    // Their own section still comes back so the textarea can prefill.
    expect(result.booking?.customerNote).toBe("gate code 4411");
  });
});

describe("customer choices are validated and priced server-side", () => {
  it("stores a chosen service and reprices the row", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ sqft: 1200 }));
    mockGetBookingById.mockResolvedValue(linkRow({ serviceType: "deep", sqft: 1200 }));
    await payCaller().updateDetails({ token: TOKEN, serviceType: "deep" });
    const expected = calculateQuote(
      { type: "deep", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(patched()).toMatchObject({ serviceType: "deep", totalAmount: expected.total });
  });

  it("refuses to change a fact the owner locked, whatever the page claims", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({ serviceType: "residential", sqft: 1200, adminProvided: "service,size" })
    );
    await expect(payCaller().updateDetails({ token: TOKEN, serviceType: "deep" })).rejects.toThrow(/give us a call/i);
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 300 })).rejects.toThrow(/give us a call/i);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("county-verifies a customer-entered address and keeps the higher-pricing figure", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ serviceType: "residential", sqft: 800, adminProvided: "service" }));
    mockGetBookingById.mockResolvedValue(linkRow({ serviceType: "residential", sqft: 2400 }));
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 2400, source: "bexar_gis" });
    const result = await payCaller().updateDetails({
      token: TOKEN,
      address: "1 Main St",
      city: "San Antonio",
      zip: "78201",
    });
    expect(result.sizeVerified).toBe(true);
    expect(patched()).toMatchObject({ sqft: 2400, sqftMismatch: true, verifiedSqft: 2400 });
  });

  it("rejects a slider value outside the public bounds", async () => {
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 50 })).rejects.toThrow();
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 99999 })).rejects.toThrow();
  });

  it("releases a customer-claimed slot the new size no longer fits, and says so", async () => {
    // 16:00 fit a 2h job; the size change makes it 5h against an 18:00 close.
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({
        serviceType: "residential",
        sqft: 900,
        scheduledDate: OPEN_MONDAY,
        scheduledTime: "16:00",
        estimatedHours: 2,
        adminProvided: "service",
      })
    );
    mockGetBookingById.mockResolvedValue(linkRow({ serviceType: "residential", sqft: 4000 }));
    const result = await payCaller().updateDetails({ token: TOKEN, sqft: 4000 });
    expect(result.slotCleared).toBe(true);
    expect(patched()).toMatchObject({ scheduledDate: null, scheduledTime: null });
  });

  it("releases a customer-claimed slot when the longer job would cross a neighbour", async () => {
    // 10:00 for 2h fit beside a 13:00 booking; at 4,000 sq ft the job runs 5h
    // and would plough into it. Closing time alone would not catch this.
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({
        serviceType: "residential",
        sqft: 900,
        scheduledDate: OPEN_MONDAY,
        scheduledTime: "10:00",
        estimatedHours: 2,
        adminProvided: "service",
      })
    );
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 55, time: "13:00", serviceType: "residential", sqft: 900, estimatedHours: 2, status: "confirmed", createdAt: new Date() },
    ]);
    mockGetBookingById.mockResolvedValue(linkRow({ serviceType: "residential", sqft: 4000 }));
    const result = await payCaller().updateDetails({ token: TOKEN, sqft: 4000 });
    expect(result.slotCleared).toBe(true);
    expect(patched()).toMatchObject({ scheduledDate: null, scheduledTime: null });
  });

  it("writes nothing when a call carries no changes", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow());
    const result = await payCaller().updateDetails({ token: TOKEN });
    expect(result.ok).toBe(true);
    // Drizzle throws on an empty SET — the guard means it is never reached.
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("refuses the same edit when the OWNER locked the slot", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      linkRow({
        serviceType: "residential",
        sqft: 900,
        scheduledDate: OPEN_MONDAY,
        scheduledTime: "16:00",
        estimatedHours: 2,
        adminProvided: "service,slot",
      })
    );
    await expect(payCaller().updateDetails({ token: TOKEN, sqft: 4000 })).rejects.toThrow(/give us a call/i);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });
});

describe("claiming the slot", () => {
  // Token expiry is minted from Date.now(), so the row has to be built AFTER
  // the fake clock moves — otherwise it reads as already-dead under it.
  const readyRow = (overrides: Record<string, unknown> = {}) =>
    linkRow({
      serviceType: "residential",
      sqft: 1200,
      adminProvided: "service,size",
      payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
      createdAt: new Date(),
      ...overrides,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A weekday morning well before the fixture Monday, clear of any notice window.
    vi.setSystemTime(new Date(slotStartInstant(OPEN_MONDAY, "10:00") - 96 * 3_600_000));
    mockGetBookingByPayToken.mockResolvedValue(readyRow());
  });

  it("claims a legal slot and pins the duration", async () => {
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" })).resolves.toMatchObject({
      claimed: true,
    });
    expect(patched()).toMatchObject({ scheduledDate: OPEN_MONDAY, scheduledTime: "10:00", estimatedHours: 3 });
    // The provider-safe stale-hold sweep ran before the check, as in every booking path.
    expect(mockListElapsedDepositBookings).toHaveBeenCalledOnce();
  });

  it("requires service and size first — duration is unknowable without them", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow());
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" })).rejects.toThrow(
      /service and home size first/i
    );
  });

  it("obeys the lead time — with no admin override available to a customer", async () => {
    vi.setSystemTime(new Date(slotStartInstant(OPEN_MONDAY, "10:00") - 30 * 60_000));
    // Re-mint the row under the moved clock, or its token reads as expired
    // and the wrong rule fires.
    mockGetBookingByPayToken.mockResolvedValue(readyRow());
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" })).rejects.toThrow(
      /not available/i
    );
  });

  it("obeys the lunch break when the owner has reserved it", async () => {
    mockGetSetting.mockImplementation(async (key: string) => (key === LUNCH_SETTING_KEY ? "true" : null));
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "12:00" })).rejects.toThrow(
      /not available/i
    );
  });

  it("obeys other bookings' full spans", async () => {
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "09:00", serviceType: "deep", sqft: 1500, estimatedHours: 4, status: "confirmed", createdAt: new Date() },
    ]);
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" })).rejects.toThrow(
      /not available/i
    );
  });

  it("refuses a start the job cannot finish before close", async () => {
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "17:00" })).rejects.toThrow(
      /not available/i
    );
  });

  it("loses the write race with the ordinary taken-slot message", async () => {
    mockUpdateBooking.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry '2026-01-01T10:00' for key 'bookings_slotKey_unique'"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      })
    );
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" })).rejects.toThrow(
      /not available/i
    );
  });

  it("starts the hold clock at the claim, not at link creation", async () => {
    // Link sent 20 hours ago; the customer claims now. The slot must be held
    // a full window from NOW — releasing it at the original token expiry
    // would punish the customer for the owner's head start.
    const createdAt = new Date(Date.now() - 20 * 3_600_000);
    mockGetBookingByPayToken.mockResolvedValue(readyRow({ createdAt }));
    await payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "10:00" });
    const patch = patched();
    // holdMinutes restates the window in createdAt's terms: elapsed + window.
    expect(patch.holdMinutes).toBeGreaterThanOrEqual(20 * 60 + 24 * 60);
    // And the link window moves with it — one promise, one clock.
    const expires = patch.payTokenExpiresAt as Date;
    expect(expires.getTime() - Date.now()).toBeGreaterThanOrEqual(24 * 3_600_000 - 60_000);
  });

  it("ignores the booking's own previous claim when moving to a new time", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      readyRow({ scheduledDate: OPEN_MONDAY, scheduledTime: "08:00", estimatedHours: 3 })
    );
    mockGetOccupiedBookings.mockResolvedValue([
      // Its own held hours — must not block its own move.
      { id: 99, time: "08:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "pending_deposit", createdAt: new Date() },
    ]);
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "13:00" })).resolves.toMatchObject({
      claimed: true,
    });
  });

  it("refuses to move a slot the owner locked", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow());
    await expect(payCaller().claimSlot({ token: TOKEN, date: OPEN_MONDAY, time: "13:00" })).rejects.toThrow(
      /give us a call/i
    );
  });
});

describe("paying", () => {
  it("refuses while any step is missing", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ serviceType: "residential", sqft: 1200 }));
    await expect(payCaller().createSession({ token: TOKEN, extras: [] })).rejects.toThrow(/still missing/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("charges the recomputed figure, extras and coupon included", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow({ couponCode: "SAVE20" }));
    mockGetCouponByCode.mockResolvedValue({
      id: 1,
      code: "SAVE20",
      active: true,
      percentOff: 20,
      amountOff: null,
      timesRedeemed: 0,
      maxRedemptions: null,
      expiresAt: null,
    });
    await payCaller().createSession({ token: TOKEN, extras: ["oven"] });
    const gross = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: ["oven"], frequency: "onetime" },
      DEFAULT_PRICING
    ).total;
    const discounted = gross - Math.round((gross * 20) / 100);
    const args = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(args.line_items[0]!.price_data.unit_amount / 100).toBe(depositFor(discounted, DEFAULT_PRICING.depositRate));
  });

  it("ignores amounts smuggled into the payload", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow());
    await payCaller().createSession({
      // @ts-expect-error the schema has no amount field — that is the point
      token: TOKEN,
      extras: [],
      total: 1,
      deposit: 1,
      unit_amount: 100,
    });
    const args = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(args.line_items[0]!.price_data.unit_amount / 100).toBeGreaterThan(1);
  });

  it("appends the customer's notes under the label, preserving the owner's", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow({ notes: "Quoted high — haggler." }));
    await payCaller().createSession({ token: TOKEN, extras: [], notes: "Dog in the yard" });
    expect(patched().notes).toBe("Quoted high — haggler.\n\nFrom customer: Dog in the yard");
  });

  it("replaces their previous note on a re-mint instead of stacking", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      fullRow({ notes: "Quoted high — haggler.\n\nFrom customer: First thought" })
    );
    await payCaller().createSession({ token: TOKEN, extras: [], notes: "Better thought" });
    expect(patched().notes).toBe("Quoted high — haggler.\n\nFrom customer: Better thought");
  });

  it("leaves notes untouched when the field is not sent", async () => {
    mockGetBookingByPayToken.mockResolvedValue(fullRow({ notes: "Quoted high — haggler." }));
    await payCaller().createSession({ token: TOKEN, extras: [] });
    expect(patched().notes).toBeUndefined();
  });
});

describe("lifecycle without a slot", () => {
  const DB_SOURCE = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf-8");

  it("exempts slotless rows from stale release — they hold nothing to release", () => {
    const fn = DB_SOURCE.slice(
      DB_SOURCE.indexOf("export async function expireStaleDepositBookings"),
      DB_SOURCE.indexOf("/** Confirmed/in-progress bookings")
    );
    expect(fn).toContain("isNotNull(bookings.scheduledDate)");
    expect(fn).toContain("isNotNull(bookings.scheduledTime)");
  });

  it("keeps slotless rows off the staff schedule — nothing for a crew to act on", () => {
    const fn = DB_SOURCE.slice(
      DB_SOURCE.indexOf("export async function listBookingsForStaff"),
      DB_SOURCE.indexOf("export async function listBookingsForMonth")
    );
    expect(fn).toContain("isNotNull(bookings.scheduledDate)");
  });

  it("cannot be hand-confirmed into a job with no hours", async () => {
    mockGetBookingById.mockResolvedValue(linkRow());
    await expect(adminCaller().updateBookingStatus({ id: 99, status: "confirmed" })).rejects.toThrow(/no time yet/i);
    // Retiring a dead lead is still allowed.
    await expect(adminCaller().updateBookingStatus({ id: 99, status: "cancelled" })).resolves.toMatchObject({
      success: true,
    });
  });

  it("reports incomplete in the admin list, and expired only by the token window", async () => {
    const { depositLinkStatus } = await import("./depositLinkRules");
    const open = linkRow();
    expect(depositLinkStatus(open)).toBe("incomplete");
    const dead = linkRow({ payTokenExpiresAt: new Date(Date.now() - 1000) });
    expect(depositLinkStatus(dead)).toBe("expired");
  });
});

describe("completion tells the owner", () => {
  beforeEach(() => {
    vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
    mockConfirmUnpaid.mockResolvedValue(true);
    mockGetBookingById.mockResolvedValue(
      fullRow({
        // The owner locked nothing but the contact — the customer chose it all.
        adminProvided: null,
        extras: JSON.stringify(["oven"]),
        totalAmount: 145,
        depositAmount: 29,
      })
    );
  });

  it("leads with the completed link and names what the customer chose", async () => {
    await finalizeBooking(99, "pi_link_1");
    const owner = mockSendMail.mock.calls
      .map(c => c[0] as { subject: string; text: string })
      .find(m => m.subject.includes("Deposit link completed"));
    expect(owner).toBeDefined();
    expect(owner!.text).toContain("finished the booking link you sent");
    expect(owner!.text).toContain("service: Residential Cleaning");
    expect(owner!.text).toContain(`time: ${OPEN_MONDAY} at 10:00`);
    expect(owner!.text).toContain("size: 1,200 sq ft");
  });

  it("names only the facts the customer actually chose", async () => {
    mockGetBookingById.mockResolvedValue(fullRow({ adminProvided: "service,size,address,slot" }));
    await finalizeBooking(99, "pi_link_2");
    const owner = mockSendMail.mock.calls
      .map(c => c[0] as { subject: string; text: string })
      .find(m => m.subject.includes("Deposit link completed"));
    expect(owner).toBeDefined();
    expect(owner!.text).not.toContain("They chose:");
  });

  it("keeps the plain 'new booking' subject for self-serve deposits", async () => {
    mockGetBookingById.mockResolvedValue(fullRow({ kind: "self_serve", payToken: null }));
    await finalizeBooking(99, "pi_self_1");
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("New booking"))).toBe(true);
    expect(subjects.some(s => s.includes("Deposit link completed"))).toBe(false);
  });
});

describe("phone-only customers", () => {
  it("deliverEmail refuses an empty address instead of erroring downstream", async () => {
    await expect(deliverEmail("", "Subject", "Body")).resolves.toBe(false);
    await expect(deliverEmail(null, "Subject", "Body")).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("createBooking skips the email path without an address to send to", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Maria",
      phone: "2105550134",
      sendEmail: true,
    });
    expect(result.emailSent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
