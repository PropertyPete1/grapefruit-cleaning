/**
 * The deposit pay page: /pay/deposit/:token
 *
 * The customer opens the link the owner sent, picks their own extras, and pays.
 * What this file pins is the trust boundary.
 *
 * THE CLIENT SENDS EXTRA IDS AND NOTHING ELSE. Not a total, not a deposit, not
 * a price for an extra. The server recomputes base + extras + coupon from the
 * live pricing config and mints the Stripe session for that figure. A payload
 * carrying an amount changes nothing, because there is no amount in the input
 * schema for it to land in.
 *
 * The rest is the lifecycle: a fresh session per attempt so changing extras
 * cannot pay yesterday's price, a validity window tied to the slot hold, and a
 * payment that lands in the same finalize path a self-serve deposit does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockUpdateBooking = vi.fn();
const mockGetBookingByPayToken = vi.fn();
const mockGetCouponByCode = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
  updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
  getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
  getCouponByCode: (...a: unknown[]) => mockGetCouponByCode(...a),
  getCustomerById: vi.fn().mockResolvedValue({
    id: 7,
    firstName: "Ana",
    email: "ana@example.com",
  }),
  createBooking: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
  isSlotTakenError: () => false,
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

import { calculateQuote, DEFAULT_PRICING, depositFor } from "@shared/pricing";
import { _resetRateLimits } from "./antiSpam";
import { depositLinkStatus, depositSessionSeconds, depositLinkExpiresAt } from "./depositLinkRules";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "b".repeat(48);

const caller = () =>
  depositLinkRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const booking = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-ABC123",
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

/** What the pricing engine says a job of this shape costs with these extras. */
const priceWith = (extras: string[]) =>
  calculateQuote(
    { type: "residential", bedrooms: 3, bathrooms: 2, sqft: 1200, extras: extras as never, frequency: "onetime" },
    DEFAULT_PRICING
  );

/** The unit_amount, in dollars, of the session Stripe was asked to create. */
const chargedDollars = () => {
  const args = mockSessionCreate.mock.calls.at(-1)![0] as {
    line_items: { price_data: { unit_amount: number } }[];
  };
  return args.line_items[0]!.price_data.unit_amount / 100;
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockGetCouponByCode.mockResolvedValue(undefined);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetBookingByPayToken.mockResolvedValue(booking());
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loading the page", () => {
  it("returns the locked essentials the owner agreed on the phone", async () => {
    const result = await caller().get({ token: TOKEN });
    expect(result.state).toBe("awaiting_payment");
    expect(result.booking).toMatchObject({
      reference: "GFC-ABC123",
      date: OPEN_MONDAY,
      time: "10:00",
      address: "1 Main St, San Antonio, 78201",
    });
  });

  it("never returns the token back to the page", async () => {
    const result = await caller().get({ token: TOKEN });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("serves the page in the language the booking was taken in", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ locale: "es" }));
    const result = await caller().get({ token: TOKEN });
    expect(result.locale).toBe("es");
    expect(result.booking?.serviceName).toBe("Limpieza Residencial");
  });

  it("shows a bilingual notice for an unknown token instead of an error", async () => {
    mockGetBookingByPayToken.mockResolvedValue(undefined);
    const result = await caller().get({ token: "nope" });
    expect(result.state).toBe("notFound");
    expect(result.booking).toBeNull();
    expect(result.notice?.en.title).toMatch(/couldn't find/i);
    expect(result.notice?.es.title).toMatch(/No encontramos/i);
  });

  it("refuses to open a self-serve booking's row through this route", async () => {
    // Only admin-created bookings have deposit links; a token colliding with a
    // self-serve row must not expose it.
    mockGetBookingByPayToken.mockResolvedValue(booking({ kind: "self_serve" }));
    const result = await caller().get({ token: TOKEN });
    expect(result.state).toBe("notFound");
  });

  it("says the deposit is already paid once the booking is confirmed", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ status: "confirmed" }));
    const result = await caller().get({ token: TOKEN });
    expect(result.state).toBe("paid");
    expect(result.booking).toBeNull();
  });

  it("says the link expired once the window has closed", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      booking({ payTokenExpiresAt: new Date(Date.now() - 60_000) })
    );
    const result = await caller().get({ token: TOKEN });
    expect(result.state).toBe("expired");
    expect(result.booking).toBeNull();
  });

  it("hands the page the config it needs to preview a tapped extra", async () => {
    const result = await caller().get({ token: TOKEN });
    expect(result.booking?.pricing.extras.oven).toBeGreaterThan(0);
    expect(result.booking?.quote).toMatchObject({ type: "residential", sqft: 1200 });
  });

  it("withholds coupon terms the server would not honour", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ couponCode: "OLD20" }));
    mockGetCouponByCode.mockResolvedValue({
      id: 1,
      code: "OLD20",
      active: false,
      percentOff: 20,
      amountOff: null,
      timesRedeemed: 0,
      maxRedemptions: null,
      expiresAt: null,
    });
    const result = await caller().get({ token: TOKEN });
    // Showing a discount that vanishes at checkout is worse than showing none.
    expect(result.booking?.coupon).toBeNull();
  });
});

describe("paying — the money is recomputed, never accepted", () => {
  it("charges the base deposit when no extras are chosen", async () => {
    await caller().createSession({ token: TOKEN, extras: [] });
    expect(chargedDollars()).toBe(depositFor(priceWith([]).total, DEFAULT_PRICING.depositRate));
  });

  it("charges more once the customer adds extras", async () => {
    await caller().createSession({ token: TOKEN, extras: ["oven", "windows"] });
    const expected = depositFor(priceWith(["oven", "windows"]).total, DEFAULT_PRICING.depositRate);
    expect(chargedDollars()).toBe(expected);
    expect(expected).toBeGreaterThan(depositFor(priceWith([]).total, DEFAULT_PRICING.depositRate));
  });

  it("ignores an amount smuggled into the payload", async () => {
    await caller().createSession({
      // @ts-expect-error the schema has no amount field — that is the point
      token: TOKEN,
      extras: ["oven"],
      total: 1,
      deposit: 1,
      amount: 1,
      unit_amount: 100,
    });
    expect(chargedDollars()).toBe(depositFor(priceWith(["oven"]).total, DEFAULT_PRICING.depositRate));
    expect(chargedDollars()).toBeGreaterThan(1);
  });

  it("ignores a price smuggled in as an extra", async () => {
    await expect(
      // @ts-expect-error extras are IDs from a fixed list
      caller().createSession({ token: TOKEN, extras: [{ id: "oven", price: 0 }] })
    ).rejects.toThrow();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects an extra that is not on the list", async () => {
    await expect(
      // @ts-expect-error not a real extra
      caller().createSession({ token: TOKEN, extras: ["freeStuff"] })
    ).rejects.toThrow();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("writes the recomputed figures onto the booking", async () => {
    await caller().createSession({ token: TOKEN, extras: ["oven"] });
    const patch = mockUpdateBooking.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.extras).toBe(JSON.stringify(["oven"]));
    expect(patch.totalAmount).toBe(priceWith(["oven"]).total);
    expect(patch.depositAmount).toBe(depositFor(priceWith(["oven"]).total, DEFAULT_PRICING.depositRate));
  });

  it("applies the booking's coupon on top of base and extras", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ couponCode: "SAVE20" }));
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
    await caller().createSession({ token: TOKEN, extras: ["oven"] });
    const gross = priceWith(["oven"]).total;
    const discounted = gross - Math.round((gross * 20) / 100);
    expect(chargedDollars()).toBe(depositFor(discounted, DEFAULT_PRICING.depositRate));
  });

  it("does not honour an expired coupon stored on the booking", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ couponCode: "GONE" }));
    mockGetCouponByCode.mockResolvedValue({
      id: 1,
      code: "GONE",
      active: true,
      percentOff: 50,
      amountOff: null,
      timesRedeemed: 0,
      maxRedemptions: null,
      expiresAt: "2020-01-01",
    });
    await caller().createSession({ token: TOKEN, extras: [] });
    expect(chargedDollars()).toBe(depositFor(priceWith([]).total, DEFAULT_PRICING.depositRate));
  });
});

describe("re-minting", () => {
  it("creates a fresh session on every attempt", async () => {
    await caller().createSession({ token: TOKEN, extras: [] });
    await caller().createSession({ token: TOKEN, extras: ["oven"] });
    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
  });

  it("prices the second attempt from the new extras, not the first ones", async () => {
    await caller().createSession({ token: TOKEN, extras: ["oven", "windows"] });
    const first = chargedDollars();
    await caller().createSession({ token: TOKEN, extras: [] });
    const second = chargedDollars();
    expect(second).toBeLessThan(first);
    expect(second).toBe(depositFor(priceWith([]).total, DEFAULT_PRICING.depositRate));
  });

  it("records the newest session id on the booking", async () => {
    mockSessionCreate.mockResolvedValue({ id: "cs_second", url: "https://stripe.test/2" });
    await caller().createSession({ token: TOKEN, extras: [] });
    const patches = mockUpdateBooking.mock.calls.map(c => c[1] as Record<string, unknown>);
    expect(patches.at(-1)).toMatchObject({ stripeSessionId: "cs_second" });
  });
});

describe("the token's validity window", () => {
  it("refuses to mint once the window has closed", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      booking({ payTokenExpiresAt: new Date(Date.now() - 1000) })
    );
    await expect(caller().createSession({ token: TOKEN, extras: [] })).rejects.toThrow(/expired/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("refuses to charge a deposit twice", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ status: "confirmed" }));
    await expect(caller().createSession({ token: TOKEN, extras: [] })).rejects.toThrow(/already been paid/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("says so in Spanish for a Spanish booking", async () => {
    mockGetBookingByPayToken.mockResolvedValue(
      booking({ locale: "es", payTokenExpiresAt: new Date(Date.now() - 1000) })
    );
    await expect(caller().createSession({ token: TOKEN, extras: [] })).rejects.toThrow(/ha expirado/i);
  });

  it("refuses an unknown token outright", async () => {
    mockGetBookingByPayToken.mockResolvedValue(undefined);
    await expect(caller().createSession({ token: "nope", extras: [] })).rejects.toThrow(/not found/i);
  });

  it("never lets a Stripe session outlive the slot hold", async () => {
    const remaining = 2 * 3_600_000;
    mockGetBookingByPayToken.mockResolvedValue(
      booking({ payTokenExpiresAt: new Date(Date.now() + remaining) })
    );
    await caller().createSession({ token: TOKEN, extras: [] });
    const args = mockSessionCreate.mock.calls[0]![0] as { expires_at: number };
    expect(args.expires_at).toBeLessThanOrEqual(Math.floor((Date.now() + remaining) / 1000) + 1);
  });

  it("clamps a session to what Stripe accepts", () => {
    const now = new Date();
    // Stripe's floor is 30 minutes and its ceiling is 24 hours.
    expect(depositSessionSeconds(new Date(now.getTime() + 60_000), now)).toBe(30 * 60);
    expect(depositSessionSeconds(new Date(now.getTime() + 90 * 3_600_000), now)).toBe(24 * 3_600);
  });
});

describe("payment lands in the normal flow", () => {
  it("carries the metadata the webhook finalizes on", async () => {
    await caller().createSession({ token: TOKEN, extras: [] });
    const args = mockSessionCreate.mock.calls[0]![0] as {
      metadata: Record<string, string>;
      client_reference_id: string;
    };
    // stripeWebhook.ts reads booking_id (falling back to client_reference_id)
    // and calls finalizeBooking — the same path a self-serve deposit takes,
    // confirmation email and all.
    expect(args.metadata.booking_id).toBe("99");
    expect(args.client_reference_id).toBe("99");
    expect(args.metadata.payment_type).toBeUndefined();
  });

  it("returns the customer to the booking confirmation page in their language", async () => {
    mockGetBookingByPayToken.mockResolvedValue(booking({ locale: "es" }));
    await caller().createSession({ token: TOKEN, extras: [] });
    const args = mockSessionCreate.mock.calls[0]![0] as { success_url: string; cancel_url: string };
    expect(args.success_url).toContain("/es/reservar");
    expect(args.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(args.cancel_url).toContain(`/pay/deposit/${TOKEN}`);
  });
});

describe("link status", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const future = new Date(now.getTime() + 3_600_000);
  const past = new Date(now.getTime() - 3_600_000);
  /** A row with every fact settled — status questions only, no completeness noise. */
  const complete = {
    serviceType: "residential",
    sqft: 1200,
    scheduledDate: OPEN_MONDAY,
    scheduledTime: "10:00",
  };

  it("is none for a self-serve booking that never had a link", () => {
    expect(depositLinkStatus({ ...complete, status: "pending_deposit", hasPayToken: false }, now)).toBe("none");
  });

  it("is awaiting payment while the window is open and every fact is settled", () => {
    expect(
      depositLinkStatus({ ...complete, status: "pending_deposit", hasPayToken: true, payTokenExpiresAt: future }, now)
    ).toBe("awaiting_payment");
  });

  it("is incomplete while a fact is still the customer's to choose", () => {
    expect(
      depositLinkStatus(
        { ...complete, scheduledDate: null, scheduledTime: null, status: "pending_deposit", hasPayToken: true, payTokenExpiresAt: future },
        now
      )
    ).toBe("incomplete");
  });

  it("is expired once it closes unpaid — even when also incomplete", () => {
    expect(
      depositLinkStatus({ ...complete, status: "pending_deposit", hasPayToken: true, payTokenExpiresAt: past }, now)
    ).toBe("expired");
    // A dead link outranks an unfinished one: whatever is missing, the fix is
    // the same — resend.
    expect(
      depositLinkStatus(
        { ...complete, serviceType: null, status: "pending_deposit", hasPayToken: true, payTokenExpiresAt: past },
        now
      )
    ).toBe("expired");
  });

  it("is paid once the booking is confirmed, however long ago the window closed", () => {
    expect(
      depositLinkStatus({ ...complete, status: "confirmed", hasPayToken: true, payTokenExpiresAt: past }, now)
    ).toBe("paid");
  });

  it("expires the window exactly at the end of the slot hold", () => {
    const created = new Date("2026-07-16T12:00:00Z");
    expect(depositLinkExpiresAt(created, 24 * 60).toISOString()).toBe("2026-07-17T12:00:00.000Z");
  });
});
