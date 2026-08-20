/**
 * The advertised "from $X" figure.
 *
 * The homepage hero used to hardcode $89 while the cheapest bookable clean was
 * $79.99 — an overstatement that survived every pricing edit because nothing
 * connected the copy to the ladder. These tests pin the helper that closes
 * that gap, including the cases where a naive `Math.min` would go wrong.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING,
  lowestBookablePrice,
  parsePricingConfig,
  serializePricingConfig,
  startingPriceFor,
  type PricingConfig,
} from "@shared/pricing";

/** A config with one field replaced, leaving the rest of the ladder intact. */
function withTiers(tiers: Partial<PricingConfig["tiers"]>): PricingConfig {
  return { ...DEFAULT_PRICING, tiers: { ...DEFAULT_PRICING.tiers, ...tiers } };
}

describe("lowestBookablePrice", () => {
  it("reports the cheapest bookable clean in the default ladder", () => {
    // The residential entry tier, which is what the hero should advertise.
    expect(lowestBookablePrice()).toBe(79.99);
  });

  it("matches the residential entry price, since that is the cheapest service", () => {
    expect(lowestBookablePrice()).toBe(startingPriceFor("residential"));
  });

  it("follows an admin edit rather than a baked-in number", () => {
    const cheaper = withTiers({
      residential: [{ maxSqft: 700, price: 59 }, ...DEFAULT_PRICING.tiers.residential.slice(1)],
    });
    expect(lowestBookablePrice(cheaper)).toBe(59);

    // Lift the WHOLE residential ladder above deep's entry tier. Raising only
    // the first rung would leave $89.99 behind it and prove nothing.
    const dearer = withTiers({
      residential: DEFAULT_PRICING.tiers.residential.map(t =>
        t.customQuote ? t : { ...t, price: t.price + 200 }
      ),
    });
    // The headline must follow whichever service is now cheapest (move-in/out,
    // at $127.99) rather than staying pinned to residential.
    const cheapestOther = Math.min(
      startingPriceFor("deep", dearer),
      startingPriceFor("moveinout", dearer)
    );
    expect(lowestBookablePrice(dearer)).toBe(cheapestOther);
    expect(lowestBookablePrice(dearer)).toBeLessThan(startingPriceFor("residential", dearer));
  });

  it("ignores the $0 custom-quote catch-all tier", () => {
    // residential ends with { price: 0, customQuote: true }. A plain Math.min
    // over the ladder would advertise "from $0".
    expect(DEFAULT_PRICING.tiers.residential.some(t => t.customQuote && t.price === 0)).toBe(true);
    expect(lowestBookablePrice()).toBeGreaterThan(0);
  });

  it("ignores commercial and office, which are quote-only baselines", () => {
    const config = { ...DEFAULT_PRICING, basePrices: { ...DEFAULT_PRICING.basePrices, commercial: 5, office: 5 } };
    // $5 is an estimating baseline, not a rate anyone can book — advertising it
    // would promise a price the business never charges.
    expect(lowestBookablePrice(config)).toBe(79.99);
  });

  it("survives a round trip through the stored setting", () => {
    // The live value reaches the client as JSON via site_settings, so the
    // helper must agree on both sides of serialization.
    const parsed = parsePricingConfig(serializePricingConfig(DEFAULT_PRICING));
    expect(lowestBookablePrice(parsed)).toBe(lowestBookablePrice(DEFAULT_PRICING));
  });

  it("agrees with the production pricing_config currently in the database", () => {
    // Guards the specific regression: production's stored ladder opens at
    // 79.99, so the hero must render $79.99 — never the old hardcoded $89.
    const production = parsePricingConfig(
      JSON.stringify({
        tiers: {
          residential: [
            { maxSqft: 700, price: 79.99 },
            { maxSqft: 900, price: 89.99 },
            { maxSqft: 3500, price: 249.99, startingAt: true },
            { maxSqft: null, price: 0, customQuote: true },
          ],
          deep: [{ maxSqft: 700, price: 115.99 }],
          moveinout: [{ maxSqft: 700, price: 127.99 }],
        },
        basePrices: DEFAULT_PRICING.basePrices,
        extras: DEFAULT_PRICING.extras,
        frequencyDiscounts: DEFAULT_PRICING.frequencyDiscounts,
        depositRate: 0,
      })
    );
    expect(lowestBookablePrice(production)).toBe(79.99);
  });
});
