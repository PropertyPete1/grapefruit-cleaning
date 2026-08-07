/**
 * Price formatting.
 *
 * The estimate panel showed a rounded headline over an exact line item —
 * "$113" above "$112.99" — because the animated headline rendered
 * Math.round() while the breakdown printed the raw number. Both now go through
 * the same formatter, so they cannot disagree.
 */
import { describe, expect, it } from "vitest";

import { formatPrice, priceDecimals } from "@/lib/formatPrice";
import { DEFAULT_PRICING, calculateQuote, type CleaningType } from "@shared/pricing";

describe("formatPrice", () => {
  it("keeps cents rather than rounding them away", () => {
    expect(formatPrice(112.99)).toBe("112.99");
    expect(formatPrice(79.99)).toBe("79.99");
    expect(formatPrice(0.5)).toBe("0.50");
  });

  it("leaves whole amounts whole, with no trailing .00", () => {
    expect(formatPrice(80)).toBe("80");
    expect(formatPrice(0)).toBe("0");
    expect(formatPrice(20)).toBe("20");
  });

  it("groups thousands", () => {
    expect(formatPrice(1234.5)).toBe("1,234.50");
    expect(formatPrice(2000)).toBe("2,000");
  });

  it("honours an explicit precision, so digits hold steady mid-animation", () => {
    // The headline counts up toward a target; the target's precision is fixed
    // for the whole count so decimals don't flicker in and out.
    expect(formatPrice(45.333, 2)).toBe("45.33");
    expect(formatPrice(45.333, 0)).toBe("45");
    expect(formatPrice(80, 2)).toBe("80.00");
  });

  it("derives precision from the value", () => {
    expect(priceDecimals(112.99)).toBe(2);
    expect(priceDecimals(80)).toBe(0);
    // Floating point noise must not invent cents.
    expect(priceDecimals(0.1 + 0.2 - 0.3)).toBe(0);
  });
});

describe("headline and line item agree", () => {
  const types: CleaningType[] = ["residential", "deep", "moveinout", "airbnb", "commercial", "office"];

  /** Reads a rendered figure back as a number, the way a customer would. */
  const parseRendered = (rendered: string) => Number(rendered.replace(/,/g, ""));

  it("renders every quote figure without changing its value", () => {
    for (const type of types) {
      for (const sqft of [200, 500, 699, 1200, 2500, 4000]) {
        const q = calculateQuote(
          { type, bedrooms: 1, bathrooms: 1, sqft, extras: ["oven", "windows"], frequency: "weekly" },
          DEFAULT_PRICING
        );
        // Every figure the panel prints — headline and line items alike.
        for (const [label, value] of Object.entries({
          total: q.total,
          base: q.base,
          extrasTotal: q.extrasTotal,
          discount: q.discount,
        })) {
          expect(parseRendered(formatPrice(value)), `${type} @ ${sqft}: ${label}`).toBe(value);
        }
      }
    }
  });

  it("the headline uses the same precision rule as the line items", () => {
    for (const value of [79.99, 112.99, 80, 249.99, 1234.5]) {
      // AnimatedPrice fixes precision from the target via priceDecimals; a line
      // item calls formatPrice directly. Both must land on the same string.
      expect(formatPrice(value, priceDecimals(value))).toBe(formatPrice(value));
    }
  });

  it("a .99 tier price never displays as the next whole dollar", () => {
    const q = calculateQuote(
      { type: "residential", bedrooms: 1, bathrooms: 1, sqft: 1200, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(q.total).toBe(112.99);
    expect(formatPrice(q.total)).toBe("112.99");
    expect(formatPrice(q.total)).not.toBe("113");
  });
});
