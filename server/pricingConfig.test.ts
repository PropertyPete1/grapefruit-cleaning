import { describe, expect, it } from "vitest";
import {
  calculateQuote,
  DEFAULT_PRICING,
  parsePricingConfig,
  serializePricingConfig,
  type PricingConfig,
} from "@shared/pricing";

const baseInput = {
  type: "residential" as const,
  bedrooms: 2,
  bathrooms: 1,
  sqft: 1200,
  extras: [] as never[],
  frequency: "onetime" as const,
};

describe("parsePricingConfig", () => {
  it("falls back to defaults for null/undefined/empty", () => {
    expect(parsePricingConfig(null)).toBe(DEFAULT_PRICING);
    expect(parsePricingConfig(undefined)).toBe(DEFAULT_PRICING);
    expect(parsePricingConfig("")).toBe(DEFAULT_PRICING);
  });

  it("falls back to defaults for garbage JSON", () => {
    expect(parsePricingConfig("not json{{")).toBe(DEFAULT_PRICING);
  });

  it("falls back to defaults for structurally invalid payloads", () => {
    expect(parsePricingConfig(JSON.stringify({ tiers: {} }))).toBe(DEFAULT_PRICING);
    // Negative price is rejected
    const bad = JSON.parse(serializePricingConfig(DEFAULT_PRICING));
    bad.extras.pets = -5;
    expect(parsePricingConfig(JSON.stringify(bad))).toBe(DEFAULT_PRICING);
    // Tier table missing an unbounded top tier is rejected
    const noTop = JSON.parse(serializePricingConfig(DEFAULT_PRICING));
    noTop.tiers.deep = [{ maxSqft: 1000, price: 100 }];
    expect(parsePricingConfig(JSON.stringify(noTop))).toBe(DEFAULT_PRICING);
  });

  it("round-trips Infinity through serialize/parse (null in JSON)", () => {
    const json = serializePricingConfig(DEFAULT_PRICING);
    expect(json).not.toContain("Infinity");
    const parsed = parsePricingConfig(json);
    const top = parsed.tiers.residential[parsed.tiers.residential.length - 1];
    expect(top.maxSqft).toBe(Infinity);
    expect(top.customQuote).toBe(true);
    // Full equivalence of totals
    expect(calculateQuote(baseInput, parsed)).toEqual(calculateQuote(baseInput, DEFAULT_PRICING));
  });

  it("sorts tier tables by maxSqft regardless of stored order", () => {
    const cfg = JSON.parse(serializePricingConfig(DEFAULT_PRICING));
    cfg.tiers.deep.reverse();
    const parsed = parsePricingConfig(JSON.stringify(cfg));
    expect(parsed.tiers.deep[0].maxSqft).toBe(1000);
    expect(parsed.tiers.deep[parsed.tiers.deep.length - 1].maxSqft).toBe(Infinity);
  });
});

describe("calculateQuote with custom config", () => {
  const customConfig = (): PricingConfig =>
    parsePricingConfig(
      serializePricingConfig({
        ...DEFAULT_PRICING,
        tiers: {
          ...DEFAULT_PRICING.tiers,
          residential: [
            { maxSqft: 1000, price: 120 },
            { maxSqft: 1500, price: 150 },
            { maxSqft: Infinity, price: 300, startingAt: true },
          ],
        },
        extras: { ...DEFAULT_PRICING.extras, pets: 25 },
        frequencyDiscounts: { ...DEFAULT_PRICING.frequencyDiscounts, weekly: 0.25 },
        depositRate: 0.3,
      })
    );

  it("uses overridden tier prices", () => {
    const q = calculateQuote(baseInput, customConfig());
    expect(q.base).toBe(150); // 1200 sqft → 1000–1500 tier at $150
    expect(q.total).toBe(150);
  });

  it("uses overridden extras and discounts", () => {
    const q = calculateQuote(
      { ...baseInput, extras: ["pets"] as never, frequency: "weekly" },
      customConfig()
    );
    expect(q.extrasTotal).toBe(25);
    expect(q.subtotal).toBe(175);
    expect(q.discount).toBe(43.75); // 25% of 175
    expect(q.total).toBe(131.25);
  });

  it("applies the overridden deposit rate", () => {
    const q = calculateQuote(baseInput, customConfig());
    expect(q.deposit).toBe(45); // 30% of 150
  });

  it("defaults still price the canonical example correctly", () => {
    const q = calculateQuote(baseInput);
    expect(q.base).toBe(129.99);
    expect(q.deposit).toBe(26); // 20% of 129.99 = 25.998 → 26.00 rounded
  });
});
