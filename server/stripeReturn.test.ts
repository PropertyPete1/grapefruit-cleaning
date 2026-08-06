/**
 * Stripe return URLs must land on a real client route.
 *
 * The success_url is where the deposit flow's fallback confirmation runs: the
 * Booking page reads session_id + ref off the query string and calls
 * booking.confirm, which is what saves the booking when the webhook is slow,
 * misconfigured, or down. A path with no matching route falls through to the
 * catch-all redirect in App.tsx, which rewrites the URL to the locale home and
 * drops the query string — so the confirmation silently never happens and, once
 * the slot goes stale, a paid booking expires.
 *
 * These tests pin both locales against the client's own route table so the two
 * can never drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookedSlots: vi.fn().mockResolvedValue([]),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  createBooking: vi.fn().mockResolvedValue(99),
  updateBooking: vi.fn(),
  expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
  isSlotTakenError: () => false,
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionCreate(...args) } },
  }),
}));

import { ROUTE_SLUGS } from "@/i18n/types";
import { _resetRateLimits } from "./antiSpam";
import { bookingRouter } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";

const caller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const baseInput = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [],
    frequency: "onetime" as const,
  },
  date: "2026-07-20", // Monday — open under the default schedule
  time: "10:00",
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  address: "1 Main St",
  city: "San Antonio",
  zip: "78201",
};

/** The client route the Booking page is mounted at, per locale. */
const clientBookingPath = (locale: "en" | "es") => {
  const slug = ROUTE_SLUGS.booking[locale];
  return `/${locale}${slug ? `/${slug}` : ""}`;
};

beforeEach(() => {
  // These assert the return URL built from the request's own Origin header, so
  // PUBLIC_BASE_URL must be unset — it takes priority inside publicOrigin, and
  // the deploy environment exports it. (vitest.setup.ts clears it suite-wide;
  // this keeps the file self-contained.)
  vi.stubEnv("PUBLIC_BASE_URL", undefined);
  // booking.create is rate limited to 5/min per IP, and every case here shares
  // the same synthetic client.
  _resetRateLimits();
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_test_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe deposit return URLs", () => {
  for (const locale of ["en", "es"] as const) {
    it(`${locale}: success_url and cancel_url point at the real booking route`, async () => {
      await caller().create({ ...baseInput, locale });
      const session = mockSessionCreate.mock.calls[0]![0] as {
        success_url: string;
        cancel_url: string;
      };
      const expected = `${ORIGIN}${clientBookingPath(locale)}`;

      expect(session.success_url.startsWith(`${expected}?`)).toBe(true);
      expect(session.cancel_url.startsWith(`${expected}?`)).toBe(true);
    });

    it(`${locale}: success_url carries session_id and ref so the fallback confirm can run`, async () => {
      await caller().create({ ...baseInput, locale });
      const { success_url, cancel_url } = mockSessionCreate.mock.calls[0]![0] as {
        success_url: string;
        cancel_url: string;
      };
      expect(success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
      expect(success_url).toMatch(/[?&]ref=GFC-[A-Z0-9]{6}/);
      expect(cancel_url).toContain("cancelled=1");
      expect(cancel_url).toMatch(/[?&]ref=GFC-[A-Z0-9]{6}/);
    });
  }

  it("never returns a bare unrouted path like /booking", async () => {
    for (const locale of ["en", "es"] as const) {
      mockSessionCreate.mockClear();
      await caller().create({ ...baseInput, locale });
      const { success_url } = mockSessionCreate.mock.calls[0]![0] as { success_url: string };
      const path = new URL(success_url).pathname;
      // Every customer route is locale-prefixed; anything else is unrouted.
      expect(path).toMatch(/^\/(en|es)\//);
    }
  });
});
