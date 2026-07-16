/**
 * Stale unpaid bookings: abandoned Stripe checkouts (pending_deposit) must
 * release their calendar slot after STALE_DEPOSIT_MINUTES, get auto-expired
 * by the reminder cron, and still recover to confirmed if the customer pays
 * late from an old checkout tab.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockUpdateBooking = vi.fn();
const mockCreatePayment = vi.fn();
const mockExpireStale = vi.fn();
const mockGetBookedSlots = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
  createPayment: (...args: unknown[]) => mockCreatePayment(...args),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  incrementCouponRedemptions: vi.fn(),
  getCustomerById: vi.fn().mockResolvedValue(undefined),
  expireStaleDepositBookings: (...args: unknown[]) => mockExpireStale(...args),
  listUpcomingConfirmedBookings: vi.fn().mockResolvedValue([]),
  getBookedSlots: (...args: unknown[]) => mockGetBookedSlots(...args),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  createBooking: vi.fn().mockResolvedValue(99),
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: (...args: unknown[]) => mockSessionCreate(...args),
      },
    },
  }),
}));

import { blocksSlot, STALE_DEPOSIT_MINUTES } from "./bookingRules";
import { bookingRouter, finalizeBooking } from "./routers/booking";
import { sendDueReminders } from "./reminders";
import type { TrpcContext } from "./_core/context";

const NOW = new Date("2026-07-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeEach(() => {
  mockGetBookingById.mockReset();
  mockUpdateBooking.mockReset();
  mockCreatePayment.mockReset();
  mockExpireStale.mockReset();
  mockGetBookedSlots.mockReset().mockResolvedValue([]);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_test_123", url: "https://stripe.test/pay" });
});

describe("blocksSlot (slot release for unpaid checkouts)", () => {
  it("blocks the slot for a fresh pending_deposit booking", () => {
    expect(blocksSlot({ status: "pending_deposit", createdAt: minutesAgo(5) }, NOW)).toBe(true);
  });

  it("releases the slot once a pending_deposit booking is older than the cutoff", () => {
    expect(
      blocksSlot({ status: "pending_deposit", createdAt: minutesAgo(STALE_DEPOSIT_MINUTES + 1) }, NOW)
    ).toBe(false);
  });

  it("never blocks for expired or cancelled bookings, regardless of age", () => {
    expect(blocksSlot({ status: "expired", createdAt: minutesAgo(1) }, NOW)).toBe(false);
    expect(blocksSlot({ status: "cancelled", createdAt: minutesAgo(1) }, NOW)).toBe(false);
  });

  it("always blocks for paid statuses, even old ones", () => {
    expect(blocksSlot({ status: "confirmed", createdAt: minutesAgo(10_000) }, NOW)).toBe(true);
    expect(blocksSlot({ status: "in_progress", createdAt: minutesAgo(10_000) }, NOW)).toBe(true);
  });
});

describe("finalizeBooking (late-payment recovery)", () => {
  const baseBooking = {
    id: 42,
    customerId: 7,
    depositAmount: 33,
    couponCode: null,
    extras: "[]",
    reference: "GFC-TEST42",
    scheduledDate: "2026-07-20",
    scheduledTime: "10:00",
  };

  it("confirms an expired booking when the Stripe payment lands late (free slot: no conflict flag)", async () => {
    mockGetBookingById.mockResolvedValue({ ...baseBooking, status: "expired" });
    mockGetBookedSlots.mockResolvedValue([]);
    await finalizeBooking(42, "pi_late_123");
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ status: "confirmed", stripePaymentIntentId: "pi_late_123", slotConflict: false })
    );
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, kind: "deposit", status: "succeeded" })
    );
  });

  it("flags slotConflict when the late payment lands after another booking retook the slot", async () => {
    mockGetBookingById.mockResolvedValue({ ...baseBooking, status: "expired" });
    mockGetBookedSlots.mockResolvedValue(["09:00", "10:00"]);
    await finalizeBooking(42, "pi_late_456");
    expect(mockGetBookedSlots).toHaveBeenCalledWith("2026-07-20");
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ status: "confirmed", slotConflict: true })
    );
    expect(mockCreatePayment).toHaveBeenCalled();
  });

  it("confirms a pending_deposit booking (normal path) without a slot-conflict check", async () => {
    mockGetBookingById.mockResolvedValue({ ...baseBooking, status: "pending_deposit" });
    await finalizeBooking(42, "pi_123");
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ status: "confirmed", slotConflict: false })
    );
    // A fresh pending_deposit row would match its own slot — must not be checked.
    expect(mockGetBookedSlots).not.toHaveBeenCalled();
  });

  it("is idempotent: already-confirmed and cancelled bookings are untouched", async () => {
    for (const status of ["confirmed", "cancelled", "completed", "in_progress"]) {
      mockGetBookingById.mockResolvedValue({ ...baseBooking, status });
      await finalizeBooking(42, "pi_dup");
    }
    expect(mockUpdateBooking).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });
});

describe("booking.create checkout session", () => {
  const caller = () =>
    bookingRouter.createCaller({
      user: null,
      req: { protocol: "https", headers: { origin: "https://example.com" } } as unknown as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    });

  const createInput = {
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
    locale: "en" as const,
  };

  it("sets expires_at so the payment link dies when the booking goes stale", async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await caller().create(createInput);
    const after = Math.floor(Date.now() / 1000);
    expect(result.checkoutUrl).toBe("https://stripe.test/pay");
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const session = mockSessionCreate.mock.calls[0]![0] as { expires_at: number; allow_promotion_codes: boolean };
    expect(session.allow_promotion_codes).toBe(false);
    expect(session.expires_at).toBeGreaterThanOrEqual(before + STALE_DEPOSIT_MINUTES * 60);
    expect(session.expires_at).toBeLessThanOrEqual(after + STALE_DEPOSIT_MINUTES * 60);
  });

  it("rejects a booking whose slot is already taken", async () => {
    mockGetBookedSlots.mockResolvedValue(["10:00"]);
    await expect(caller().create(createInput)).rejects.toThrow(/not available/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

describe("reminder cron expiry", () => {
  it("expires stale pending_deposit bookings on every cron run", async () => {
    mockExpireStale.mockResolvedValue(3);
    const summary = await sendDueReminders("2026-07-16");
    expect(mockExpireStale).toHaveBeenCalledTimes(1);
    expect(summary.expired).toBe(3);
  });
});
