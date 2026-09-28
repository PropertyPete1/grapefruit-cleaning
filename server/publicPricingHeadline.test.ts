/**
 * Hotfix: the public pricing page advertised recurring-plan prices as if they
 * were the catalog price.
 *
 * The page opened on the bi-weekly tab, so every residential tier showed 15%
 * off — $67.99 where the catalog says $79.99 — and on phones the "Save 15%"
 * tag that would have explained it is hidden. Customers saw a cheaper number
 * than they would be quoted.
 *
 * What this file pins:
 *   - the page opens on the one-time frequency, in both languages;
 *   - at that frequency every tier's headline IS its catalog price, and the
 *     Airbnb "starting at" figure too;
 *   - the helper still knows the recurring discounts — the booking form applies
 *     them for a returning customer (see returningCustomers.test.ts);
 *   - the other public surfaces (home hero, service pages, quote, booking)
 *     never apply a frequency discount to an advertised figure.
 *
 * PR C2 then removed the toggle altogether: recurring plans are for returning
 * customers, so the pricing page shows one-time prices only and says so. The
 * pins below follow that — the page has no tabs to open on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, FREQUENCIES, startingPriceFor, type Frequency } from "@shared/pricing";
import { DEFAULT_PUBLIC_FREQUENCY, publicTierPrice } from "@shared/publicPricing";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

describe("the public pricing headline", () => {
  it("opens on the one-time catalog price, never a discounted plan", () => {
    expect(DEFAULT_PUBLIC_FREQUENCY).toBe("onetime");
    expect(DEFAULT_PRICING.frequencyDiscounts[DEFAULT_PUBLIC_FREQUENCY]).toBe(0);
  });

  it("at one-time, every tier's headline is exactly the catalog price", () => {
    for (const service of ["residential", "deep", "moveinout"] as const) {
      for (const tier of DEFAULT_PRICING.tiers[service]) {
        if (tier.customQuote) continue;
        expect(publicTierPrice(tier.price, DEFAULT_PUBLIC_FREQUENCY, DEFAULT_PRICING), `${service} ${tier.maxSqft}`).toBe(tier.price);
      }
    }
    // The residential entry tier — the number the report was about.
    expect(DEFAULT_PRICING.tiers.residential[0]!.price).toBe(79.99);
    expect(publicTierPrice(79.99, "onetime", DEFAULT_PRICING)).toBe(79.99);
    // Airbnb prices off the residential ladder and advertises the same entry figure.
    expect(publicTierPrice(startingPriceFor("airbnb", DEFAULT_PRICING), "onetime", DEFAULT_PRICING)).toBe(79.99);
  });

  it("publicTierPrice still knows the recurring discounts — the booking form applies them for returning customers", () => {
    expect(publicTierPrice(79.99, "biweekly", DEFAULT_PRICING)).toBe(67.99);
    expect(publicTierPrice(79.99, "monthly", DEFAULT_PRICING)).toBe(71.99);
    expect(publicTierPrice(79.99, "weekly", DEFAULT_PRICING)).toBe(63.99);
    // A config that removes a discount shows the catalog price on that tab too.
    const noBiweekly = { ...DEFAULT_PRICING, frequencyDiscounts: { ...DEFAULT_PRICING.frequencyDiscounts, biweekly: 0 } };
    expect(publicTierPrice(79.99, "biweekly", noBiweekly)).toBe(79.99);
    for (const frequency of FREQUENCIES as readonly Frequency[]) {
      expect(publicTierPrice(100, frequency, DEFAULT_PRICING)).toBeLessThanOrEqual(100);
    }
  });
});

describe("the pricing page reads the shared default and helper", () => {
  const page = source("../client/src/pages/Pricing.tsx");

  it("prices at the shared one-time default, with no state that could drift to a recurring tab", () => {
    expect(page).toContain("const frequency: Frequency = DEFAULT_PUBLIC_FREQUENCY;");
    expect(page).not.toContain("useState<Frequency>");
  });

  it("prices every tier row and the Airbnb figure through publicTierPrice", () => {
    expect(page).toContain("publicTierPrice(tier.price, frequency, pricing)");
    expect(page).toContain('publicTierPrice(startingPriceFor("airbnb", pricing), frequency, pricing)');
    // The old inline arithmetic that baked the discount into the headline is gone.
    expect(page).not.toContain("* (1 - discountRate)");
  });

  it("offers a first-time visitor no frequency toggle at all, and says why", () => {
    expect(page).not.toContain("aria-pressed={frequency === f.id}");
    expect(page).not.toContain("freqTabs");
    expect(page).toContain("RECURRING_UNLOCK_NOTE[locale]");
  });

  it("both languages label the one-time tab", () => {
    expect(source("../client/src/i18n/translations/en.ts")).toContain('onetime: "One-time"');
    expect(source("../client/src/i18n/translations/es.ts")).toContain('onetime: "Una vez"');
  });
});

describe("no other public surface bakes a frequency discount into an advertised price", () => {
  it("the quote and booking forms start at one-time", () => {
    expect(source("../client/src/pages/Quote.tsx")).toContain('const frequency: Frequency = "onetime";');
    expect(source("../client/src/pages/Booking.tsx")).toContain('(q as Frequency) : "onetime"');
  });

  it("the home hero and the service pages advertise catalog figures only", () => {
    for (const rel of ["../client/src/pages/Home.tsx", "../client/src/pages/ServiceDetail.tsx", "../client/src/pages/Services.tsx"]) {
      const text = source(rel);
      expect(text, rel).not.toContain("frequencyDiscounts");
      expect(text, rel).not.toMatch(/\* \(1 - /);
    }
    expect(source("../client/src/pages/Home.tsx")).toContain("lowestBookablePrice(pricing)");
    expect(source("../client/src/pages/ServiceDetail.tsx")).toContain("startingPriceFor(serviceId, pricing)");
  });
});
