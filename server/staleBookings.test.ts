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
}));

import { blocksSlot, STALE_DEPOSIT_MINUTES } from "./bookingRules";
import { finalizeBooking } from "./routers/booking";
import { sendDueReminders } from "./reminders";

const NOW = new Date("2026-07-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeEach(() => {
  mockGetBookingById.mockReset();
  mockUpdateBooking.mockReset();
  mockCreatePayment.mockReset();
  mockExpireStale.mockReset();
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
  };

  it("confirms an expired booking when the Stripe payment lands late", async () => {
    mockGetBookingById.mockResolvedValue({ ...baseBooking, status: "expired" });
    await finalizeBooking(42, "pi_late_123");
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ status: "confirmed", stripePaymentIntentId: "pi_late_123" })
    );
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, kind: "deposit", status: "succeeded" })
    );
  });

  it("confirms a pending_deposit booking (normal path)", async () => {
    mockGetBookingById.mockResolvedValue({ ...baseBooking, status: "pending_deposit" });
    await finalizeBooking(42, "pi_123");
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, expect.objectContaining({ status: "confirmed" }));
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

describe("reminder cron expiry", () => {
  it("expires stale pending_deposit bookings on every cron run", async () => {
    mockExpireStale.mockResolvedValue(3);
    const summary = await sendDueReminders("2026-07-16");
    expect(mockExpireStale).toHaveBeenCalledTimes(1);
    expect(summary.expired).toBe(3);
  });
});
