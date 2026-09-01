import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetToken, mockGetByHash } = vi.hoisted(() => ({
  mockSetToken: vi.fn(),
  mockGetByHash: vi.fn(),
}));

vi.mock("./db", () => ({
  setBookingRescheduleToken: (...args: unknown[]) => mockSetToken(...args),
  getBookingByRescheduleTokenHash: (...args: unknown[]) => mockGetByHash(...args),
}));
vi.mock("./publicOrigin", () => ({ publicOrigin: () => "https://grapeclean.com" }));

import {
  getBookingRescheduleAccess,
  hashRescheduleToken,
  mintBookingRescheduleUrl,
  rescheduleRequestPath,
} from "./rescheduleAccess";

beforeEach(() => {
  vi.clearAllMocks();
  mockSetToken.mockResolvedValue(undefined);
});

describe("reschedule access credentials", () => {
  it("stores only a 64-character SHA-256 hash and returns a localized absolute URL", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const result = await mintBookingRescheduleUrl({ bookingId: 41, locale: "es", now });
    const token = result.url.split("/").pop()!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.url).toBe(`https://grapeclean.com/es/reprogramar/${token}`);
    expect(mockSetToken).toHaveBeenCalledWith(41, hashRescheduleToken(token), result.expiresAt);
    expect(mockSetToken.mock.calls[0]![1]).not.toBe(token);
  });

  it("uses distinct English and Spanish routes", () => {
    expect(rescheduleRequestPath("en", "abc")).toBe("/en/reschedule/abc");
    expect(rescheduleRequestPath("es", "abc")).toBe("/es/reprogramar/abc");
  });

  it("rejects malformed, expired, and non-confirmed links", async () => {
    await expect(getBookingRescheduleAccess("not-a-token")).resolves.toBeUndefined();
    expect(mockGetByHash).not.toHaveBeenCalled();

    const token = "a".repeat(64);
    mockGetByHash.mockResolvedValue({
      booking: { status: "confirmed", rescheduleTokenExpiresAt: new Date("2026-08-31T00:00:00Z") },
      customer: null,
    });
    await expect(getBookingRescheduleAccess(token, new Date("2026-09-01T00:00:00Z"))).resolves.toBeUndefined();

    mockGetByHash.mockResolvedValue({
      booking: { status: "completed", rescheduleTokenExpiresAt: new Date("2027-01-01T00:00:00Z") },
      customer: null,
    });
    await expect(getBookingRescheduleAccess(token, new Date("2026-09-01T00:00:00Z"))).resolves.toBeUndefined();
  });
});
