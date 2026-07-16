import { afterEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { assertRateLimit, looksLikeSpam, _resetRateLimits } from "./antiSpam";

afterEach(() => _resetRateLimits());

describe("assertRateLimit", () => {
  it("allows up to the limit within a window", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => assertRateLimit("test", "1.2.3.4", 5, 60_000)).not.toThrow();
    }
  });

  it("throws TOO_MANY_REQUESTS beyond the limit", () => {
    for (let i = 0; i < 5; i++) assertRateLimit("test", "1.2.3.4", 5, 60_000);
    try {
      assertRateLimit("test", "1.2.3.4", 5, 60_000);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    }
  });

  it("tracks IPs independently", () => {
    for (let i = 0; i < 5; i++) assertRateLimit("test", "1.1.1.1", 5, 60_000);
    expect(() => assertRateLimit("test", "2.2.2.2", 5, 60_000)).not.toThrow();
  });

  it("tracks scopes independently", () => {
    for (let i = 0; i < 5; i++) assertRateLimit("contact", "1.2.3.4", 5, 60_000);
    expect(() => assertRateLimit("review", "1.2.3.4", 5, 60_000)).not.toThrow();
  });

  it("resets after the window elapses", () => {
    // Use a tiny window so the bucket expires immediately.
    for (let i = 0; i < 5; i++) assertRateLimit("test", "1.2.3.4", 5, -1);
    expect(() => assertRateLimit("test", "1.2.3.4", 5, -1)).not.toThrow();
  });
});

describe("looksLikeSpam", () => {
  it("flags a filled honeypot", () => {
    expect(looksLikeSpam({ website: "https://spam.example" })).toBe(true);
    expect(looksLikeSpam({ website: "  x  " })).toBe(true);
  });

  it("ignores an empty honeypot", () => {
    expect(looksLikeSpam({ website: "" })).toBe(false);
    expect(looksLikeSpam({ website: "   " })).toBe(false);
    expect(looksLikeSpam({})).toBe(false);
  });

  it("flags implausibly fast submissions", () => {
    expect(looksLikeSpam({ formRenderedAt: Date.now() - 500 })).toBe(true);
  });

  it("accepts submissions after the minimum fill time", () => {
    expect(looksLikeSpam({ formRenderedAt: Date.now() - 10_000 })).toBe(false);
  });

  it("does not flag missing or bogus timestamps", () => {
    expect(looksLikeSpam({ formRenderedAt: undefined })).toBe(false);
    expect(looksLikeSpam({ formRenderedAt: 0 })).toBe(false);
    expect(looksLikeSpam({ formRenderedAt: NaN })).toBe(false);
    // Future timestamp (clock skew) — do not punish real users.
    expect(looksLikeSpam({ formRenderedAt: Date.now() + 60_000 })).toBe(false);
  });
});
