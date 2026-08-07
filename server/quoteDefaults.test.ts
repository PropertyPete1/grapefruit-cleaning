/**
 * Where the quote and booking forms open.
 *
 * The panel used to show $112.99 before the visitor had entered anything,
 * because the form was prefilled at 2 bed / 1 bath / 1,200 sq ft — the middle
 * of the residential ladder. The first price anyone sees should be the entry
 * price of the service they picked.
 *
 * The rule under test is that the opening size always resolves to the cheapest
 * tier of the selected service, derived from the live pricing config rather
 * than a hardcoded figure — so it survives the owner reshaping the tiers in
 * Admin → Services.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ENTRY_BATHROOMS,
  ENTRY_BEDROOMS,
  MIN_QUOTE_SQFT,
  entrySqft,
} from "@/lib/quoteDefaults";
import {
  DEFAULT_PRICING,
  calculateQuote,
  getTier,
  parsePricingConfig,
  serializePricingConfig,
  type CleaningType,
  type PricingConfig,
} from "@shared/pricing";

const TIERED: CleaningType[] = ["residential", "deep", "moveinout", "airbnb"];

/** The cheapest price a service can quote: whatever the size floor resolves to. */
function cheapestPrice(type: CleaningType, config: PricingConfig): number {
  return calculateQuote(
    { type, bedrooms: ENTRY_BEDROOMS, bathrooms: ENTRY_BATHROOMS, sqft: MIN_QUOTE_SQFT, extras: [], frequency: "onetime" },
    config
  ).total;
}

/** What the form actually shows on open, for a service and a config. */
function openingQuote(type: CleaningType, config: PricingConfig) {
  return calculateQuote(
    {
      type,
      bedrooms: ENTRY_BEDROOMS,
      bathrooms: ENTRY_BATHROOMS,
      sqft: entrySqft(type, config),
      extras: [],
      frequency: "onetime",
    },
    config
  );
}

describe("entry configuration", () => {
  it("opens at the smallest home offered", () => {
    expect(ENTRY_BEDROOMS).toBe(1);
    expect(ENTRY_BATHROOMS).toBe(1);
  });

  it("never opens below the size the engine will price", () => {
    for (const type of TIERED) {
      expect(entrySqft(type, DEFAULT_PRICING)).toBeGreaterThanOrEqual(MIN_QUOTE_SQFT);
    }
  });
});

describe("the opening estimate is the entry price", () => {
  it("residential opens at the first tier, not a mid-ladder default", () => {
    const opening = openingQuote("residential", DEFAULT_PRICING);
    expect(opening.total).toBe(cheapestPrice("residential", DEFAULT_PRICING));
    // The regression this fixes: 1,200 sq ft landed in the 1,100–1,300 tier.
    const oldDefault = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(opening.total).toBeLessThan(oldDefault.total);
  });

  it("every tiered service opens on its own cheapest tier", () => {
    for (const type of TIERED) {
      const opening = openingQuote(type, DEFAULT_PRICING);
      expect(opening.total, `${type} should open at its entry price`).toBe(cheapestPrice(type, DEFAULT_PRICING));
    }
  });

  it("switching service before entering details moves to that service's entry price", () => {
    // Each service has its own ladder, so the figures must differ accordingly.
    const residential = openingQuote("residential", DEFAULT_PRICING).total;
    const deep = openingQuote("deep", DEFAULT_PRICING).total;
    const moveinout = openingQuote("moveinout", DEFAULT_PRICING).total;
    expect(deep).toBe(DEFAULT_PRICING.tiers.deep[0]!.price);
    expect(moveinout).toBe(DEFAULT_PRICING.tiers.moveinout[0]!.price);
    expect(residential).toBe(DEFAULT_PRICING.tiers.residential[0]!.price);
  });

  it("the opening size really does land in the first tier", () => {
    for (const type of TIERED) {
      const sqft = entrySqft(type, DEFAULT_PRICING);
      const tier = getTier(type, sqft, DEFAULT_PRICING);
      const cheapest = getTier(type, MIN_QUOTE_SQFT, DEFAULT_PRICING);
      expect(tier, `${type}`).toEqual(cheapest);
    }
  });

  it("never quotes a hardcoded 79.99 — it comes from the config", () => {
    const raised = structuredClone(DEFAULT_PRICING);
    raised.tiers.residential[0]!.price = 149.5;
    expect(openingQuote("residential", raised).total).toBe(149.5);
  });
});

describe("a custom stored config", () => {
  /** Round-trips through the same serialize/parse path the admin save uses. */
  const store = (config: PricingConfig) => parsePricingConfig(serializePricingConfig(config));

  it("follows a reshaped ladder whose first boundary is far below the old default", () => {
    const custom = structuredClone(DEFAULT_PRICING);
    custom.tiers.residential = [
      { maxSqft: 400, price: 59.99 },
      { maxSqft: 900, price: 119.99 },
      { maxSqft: Infinity, price: 199.99, startingAt: true },
    ];
    const config = store(custom);

    const sqft = entrySqft("residential", config);
    expect(sqft).toBeLessThan(400);
    expect(openingQuote("residential", config).total).toBe(59.99);
  });

  it("handles a first boundary tighter than the engine's own floor", () => {
    const custom = structuredClone(DEFAULT_PRICING);
    // Entirely below the 200 sq ft clamp: unreachable, so the cheapest price a
    // visitor can actually be quoted is the next tier up. The opening figure
    // must be that, not a number the engine would never return.
    custom.tiers.residential = [
      { maxSqft: 150, price: 19.99 },
      { maxSqft: 900, price: 89.99 },
      { maxSqft: Infinity, price: 199.99, startingAt: true },
    ];
    const config = store(custom);

    const opening = openingQuote("residential", config);
    expect(opening.total).toBe(89.99);
    expect(opening.total).toBe(cheapestPrice("residential", config));
  });

  it("handles a single unbounded tier", () => {
    const custom = structuredClone(DEFAULT_PRICING);
    custom.tiers.residential = [{ maxSqft: Infinity, price: 99.99, startingAt: true }];
    const config = store(custom);

    expect(openingQuote("residential", config).total).toBe(99.99);
  });

  it("stays on the cheapest tier no matter how the boundaries are redrawn", () => {
    for (const firstBoundary of [201, 250, 400, 501, 700, 1000, 5000]) {
      const custom = structuredClone(DEFAULT_PRICING);
      custom.tiers.residential = [
        { maxSqft: firstBoundary, price: 49.99 },
        { maxSqft: Infinity, price: 249.99, startingAt: true },
      ];
      const config = store(custom);
      expect(openingQuote("residential", config).total, `boundary ${firstBoundary}`).toBe(49.99);
    }
  });
});

/**
 * The derivation above is only worth anything if the pages actually use it.
 * These read the source because the bug being prevented is a literal creeping
 * back into the initial state — which no amount of testing entrySqft() alone
 * would catch.
 */
describe("the pages open from the derived size, not a literal", () => {
  const read = (file: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", "client", "src", "pages", file), "utf8");

  for (const file of ["Quote.tsx", "Booking.tsx"]) {
    it(`${file} derives its opening size`, () => {
      const source = read(file);
      expect(source).toContain("entrySqft(");
      expect(source).toContain("ENTRY_BEDROOMS");
      expect(source).toContain("ENTRY_BATHROOMS");
    });

    it(`${file} no longer prefills the old mid-ladder default`, () => {
      const source = read(file);
      // 1,200 sq ft sat in the middle of the residential ladder and was what
      // put $112.99 on screen before the visitor had entered anything.
      expect(source).not.toMatch(/\b1200\b/);
    });
  }
});

describe("untiered services", () => {
  it("commercial and office keep pricing off their base rate, unaffected by the opening size", () => {
    for (const type of ["commercial", "office"] as const) {
      const opening = openingQuote(type, DEFAULT_PRICING);
      expect(opening.total).toBe(DEFAULT_PRICING.basePrices[type]);
      expect(opening.startingAt).toBe(true);
    }
  });
});
