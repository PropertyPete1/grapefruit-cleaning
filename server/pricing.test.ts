import { describe, expect, it } from "vitest";
import {
  BASE_PRICES,
  DEPOSIT_RATE,
  EXTRA_PRICES,
  FREQUENCY_DISCOUNTS,
  PER_BATHROOM,
  PER_BEDROOM,
  PER_500_SQFT,
  calculateQuote,
  generateBookingReference,
} from "../shared/pricing";

describe("pricing engine", () => {
  it("calculates a base residential quote with bedrooms and bathrooms", () => {
    const result = calculateQuote({
      type: "residential",
      bedrooms: 2,
      bathrooms: 1,
      sqft: 500,
      extras: [],
      frequency: "onetime",
    });
    expect(result.total).toBe(BASE_PRICES.residential + 2 * PER_BEDROOM + 1 * PER_BATHROOM);
    expect(result.discount).toBe(0);
  });

  it("adds square footage surcharge above 500 sqft", () => {
    const base = calculateQuote({
      type: "residential",
      bedrooms: 0,
      bathrooms: 1,
      sqft: 500,
      extras: [],
      frequency: "onetime",
    });
    const larger = calculateQuote({
      type: "residential",
      bedrooms: 0,
      bathrooms: 1,
      sqft: 1500,
      extras: [],
      frequency: "onetime",
    });
    expect(larger.total - base.total).toBe(2 * PER_500_SQFT);
  });

  it("adds extras to the subtotal", () => {
    const without = calculateQuote({
      type: "deep",
      bedrooms: 1,
      bathrooms: 1,
      sqft: 800,
      extras: [],
      frequency: "onetime",
    });
    const withExtras = calculateQuote({
      type: "deep",
      bedrooms: 1,
      bathrooms: 1,
      sqft: 800,
      extras: ["oven", "refrigerator"],
      frequency: "onetime",
    });
    expect(withExtras.total - without.total).toBe(EXTRA_PRICES.oven + EXTRA_PRICES.refrigerator);
  });

  it("applies frequency discounts", () => {
    const onetime = calculateQuote({
      type: "residential",
      bedrooms: 3,
      bathrooms: 2,
      sqft: 1500,
      extras: ["pets"],
      frequency: "onetime",
    });
    const weekly = calculateQuote({
      type: "residential",
      bedrooms: 3,
      bathrooms: 2,
      sqft: 1500,
      extras: ["pets"],
      frequency: "weekly",
    });
    expect(weekly.total).toBeLessThan(onetime.total);
    const expectedDiscount = Math.round(onetime.subtotal * FREQUENCY_DISCOUNTS.weekly);
    expect(weekly.discount).toBe(expectedDiscount);
  });

  it("computes deposit as 20% of the total", () => {
    const result = calculateQuote({
      type: "moveinout",
      bedrooms: 2,
      bathrooms: 2,
      sqft: 1200,
      extras: ["moveOut"],
      frequency: "onetime",
    });
    expect(result.deposit).toBe(Math.round(result.total * DEPOSIT_RATE));
    expect(result.deposit).toBeGreaterThan(0);
    expect(result.deposit).toBeLessThan(result.total);
  });

  it("clamps out-of-range inputs safely", () => {
    const result = calculateQuote({
      type: "residential",
      bedrooms: -5,
      bathrooms: 99,
      sqft: 999999,
      extras: [],
      frequency: "onetime",
    });
    expect(result.total).toBeGreaterThan(0);
    expect(Number.isFinite(result.total)).toBe(true);
  });

  it("generates booking references in GFC-XXXXXX format", () => {
    const ref = generateBookingReference();
    expect(ref).toMatch(/^GFC-[A-Z2-9]{6}$/);
  });
});
