import { describe, expect, it } from "vitest";
import {
  BASE_PRICES,
  DEPOSIT_RATE,
  EXTRA_PRICES,
  FREQUENCY_DISCOUNTS,
  PRICING_TIERS,
  calculateQuote,
  generateBookingReference,
  getTier,
} from "../shared/pricing";

describe("fixed tier pricing", () => {
  it("residential tiers match the owner's exact price list", () => {
    expect(getTier("residential", 650)?.price).toBe(79.99);
    expect(getTier("residential", 800)?.price).toBe(89.99);
    expect(getTier("residential", 1200)?.price).toBe(112.99);
    expect(getTier("residential", 1750)?.price).toBe(149.99);
    expect(getTier("residential", 2200)?.price).toBe(176.99);
    expect(getTier("residential", 3000)?.price).toBe(229.99);
    const large = getTier("residential", 3200);
    expect(large?.price).toBe(249.99);
    expect(large?.startingAt).toBe(true);
    expect(getTier("residential", 4000)?.customQuote).toBe(true);
  });

  it("deep cleaning tiers match the owner's exact price list", () => {
    expect(getTier("deep", 650)?.price).toBe(143.99);
    expect(getTier("deep", 900)?.price).toBe(179.99);
    expect(getTier("deep", 1400)?.price).toBe(224.99);
    expect(getTier("deep", 2000)?.price).toBe(292.99);
    expect(getTier("deep", 3000)?.price).toBe(413.99);
    const top = getTier("deep", 4000);
    expect(top?.price).toBe(485.99);
    expect(top?.startingAt).toBe(true);
  });

  it("move in/out tiers match the owner's exact price list", () => {
    expect(getTier("moveinout", 650)?.price).toBe(127.99);
    expect(getTier("moveinout", 900)?.price).toBe(159.99);
    expect(getTier("moveinout", 1200)?.price).toBe(180.99);
    expect(getTier("moveinout", 1800)?.price).toBe(239.99);
    expect(getTier("moveinout", 2300)?.price).toBe(303.99);
    expect(getTier("moveinout", 2600)?.price).toBe(335.99);
    const top = getTier("moveinout", 4000);
    expect(top?.price).toBe(431.99);
    expect(top?.startingAt).toBe(true);
  });

  it("tier boundaries are exclusive of the upper bound", () => {
    expect(getTier("residential", 899)?.price).toBe(89.99);
    expect(getTier("residential", 900)?.price).toBe(99.99);
    expect(getTier("residential", 901)?.price).toBe(99.99);
    expect(getTier("residential", 1500)?.price).toBe(136.99);
    expect(getTier("deep", 1500)?.price).toBe(246.99);
    expect(getTier("moveinout", 2500)?.price).toBe(335.99);
  });

  it("airbnb uses the residential tier table", () => {
    expect(getTier("airbnb", 800)?.price).toBe(89.99);
    expect(getTier("airbnb", 2200)?.price).toBe(176.99);
  });

  it("bedrooms and bathrooms do not change the fixed base price", () => {
    const small = calculateQuote({ type: "residential", bedrooms: 1, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" });
    const big = calculateQuote({ type: "residential", bedrooms: 5, bathrooms: 4, sqft: 1200, extras: [], frequency: "onetime" });
    expect(small.total).toBe(112.99);
    expect(big.total).toBe(112.99);
  });

  it("adds extras on top of the fixed base", () => {
    const q = calculateQuote({ type: "deep", bedrooms: 2, bathrooms: 2, sqft: 900, extras: ["oven", "windows"], frequency: "onetime" });
    expect(q.total).toBe(179.99 + EXTRA_PRICES.oven + EXTRA_PRICES.windows);
  });

  it("applies frequency discounts to the subtotal", () => {
    const q = calculateQuote({ type: "residential", bedrooms: 2, bathrooms: 1, sqft: 800, extras: [], frequency: "weekly" });
    const expected = Math.round(89.99 * (1 - FREQUENCY_DISCOUNTS.weekly) * 100) / 100;
    expect(q.total).toBe(expected);
  });

  it("computes the deposit as 20% of the total", () => {
    const q = calculateQuote({ type: "moveinout", bedrooms: 3, bathrooms: 2, sqft: 1800, extras: [], frequency: "onetime" });
    expect(q.deposit).toBe(Math.round(q.total * DEPOSIT_RATE * 100) / 100);
    expect(q.deposit).toBeGreaterThan(0);
    expect(q.deposit).toBeLessThan(q.total);
  });

  it("flags residential homes over 3,500 sq ft as custom quotes", () => {
    const q = calculateQuote({ type: "residential", bedrooms: 5, bathrooms: 4, sqft: 4200, extras: [], frequency: "onetime" });
    expect(q.customQuote).toBe(true);
  });

  it("uses starting-at baselines for commercial and office", () => {
    const q = calculateQuote({ type: "office", bedrooms: 0, bathrooms: 1, sqft: 2000, extras: [], frequency: "onetime" });
    expect(q.startingAt).toBe(true);
    expect(q.base).toBe(BASE_PRICES.office);
  });

  it("clamps out-of-range inputs safely", () => {
    const q = calculateQuote({ type: "deep", bedrooms: -5, bathrooms: 99, sqft: 999999, extras: [], frequency: "onetime" });
    expect(Number.isFinite(q.total)).toBe(true);
    expect(q.total).toBeGreaterThan(0);
  });

  it("defines tier tables only for the three fixed-price services", () => {
    expect(Object.keys(PRICING_TIERS).sort()).toEqual(["deep", "moveinout", "residential"]);
  });

  it("generates booking references in GFC-XXXXXX format", () => {
    expect(generateBookingReference()).toMatch(/^GFC-[A-Z2-9]{6}$/);
  });
});
