import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListElapsed = vi.fn();
const mockExpireElapsed = vi.fn();
const mockRetrieve = vi.fn();
const mockExpireSession = vi.fn();

vi.mock("./db", () => ({
  listElapsedDepositBookings: (...args: unknown[]) => mockListElapsed(...args),
  expireElapsedDepositBooking: (...args: unknown[]) => mockExpireElapsed(...args),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: (...args: unknown[]) => mockRetrieve(...args),
        expire: (...args: unknown[]) => mockExpireSession(...args),
      },
    },
  }),
}));

import { releaseExpiredCheckoutHolds } from "./checkoutHolds";

const NOW = new Date("2026-09-01T16:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "GFC-HOLD42",
  stripeSessionId: "cs_live_hold42",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockListElapsed.mockResolvedValue([]);
  mockExpireElapsed.mockResolvedValue(true);
  mockRetrieve.mockResolvedValue({ status: "open", payment_status: "unpaid", payment_intent: null });
  mockExpireSession.mockResolvedValue({ status: "expired" });
});

describe("releaseExpiredCheckoutHolds", () => {
  it("closes an open Stripe Checkout before releasing the database slot", async () => {
    mockListElapsed.mockResolvedValue([row()]);

    const result = await releaseExpiredCheckoutHolds(NOW, vi.fn());

    expect(mockRetrieve).toHaveBeenCalledWith("cs_live_hold42");
    expect(mockExpireSession).toHaveBeenCalledWith("cs_live_hold42");
    expect(mockExpireElapsed).toHaveBeenCalledWith(42, NOW);
    expect(mockExpireSession.mock.invocationCallOrder[0]).toBeLessThan(mockExpireElapsed.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ scanned: 1, released: 1, recoveredPaid: 0, skipped: 0, errors: [] });
  });

  it("releases a provider-free admin hold without calling Stripe", async () => {
    mockListElapsed.mockResolvedValue([row({ stripeSessionId: null })]);

    const result = await releaseExpiredCheckoutHolds(NOW, vi.fn());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockExpireElapsed).toHaveBeenCalledWith(42, NOW);
    expect(result.released).toBe(1);
  });

  it("recovers a paid-session race instead of releasing its slot", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    mockListElapsed.mockResolvedValue([row()]);
    mockRetrieve.mockResolvedValue({ status: "complete", payment_status: "paid", payment_intent: "pi_paid" });

    const result = await releaseExpiredCheckoutHolds(NOW, finalize);

    expect(finalize).toHaveBeenCalledWith(42, "pi_paid");
    expect(mockExpireSession).not.toHaveBeenCalled();
    expect(mockExpireElapsed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recoveredPaid: 1, released: 0 });
  });

  it("keeps a paid session blocked during an on-demand sweep with no finalizer", async () => {
    mockListElapsed.mockResolvedValue([row()]);
    mockRetrieve.mockResolvedValue({ status: "complete", payment_status: "paid", payment_intent: "pi_paid" });

    const result = await releaseExpiredCheckoutHolds(NOW);

    expect(mockExpireElapsed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, released: 0, recoveredPaid: 0 });
  });

  it("retains the DB hold if Stripe cannot prove the session is closed", async () => {
    mockListElapsed.mockResolvedValue([row()]);
    mockRetrieve.mockRejectedValue(new Error("Stripe unavailable"));

    const result = await releaseExpiredCheckoutHolds(NOW, vi.fn());

    expect(mockExpireElapsed).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      { bookingId: 42, reference: "GFC-HOLD42", error: "Stripe unavailable" },
    ]);
  });

  it("reports a concurrent webhook win as skipped, not released", async () => {
    mockListElapsed.mockResolvedValue([row({ stripeSessionId: null })]);
    mockExpireElapsed.mockResolvedValue(false);

    const result = await releaseExpiredCheckoutHolds(NOW, vi.fn());

    expect(result).toMatchObject({ skipped: 1, released: 0, errors: [] });
  });
});
