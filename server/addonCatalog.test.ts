import { describe, expect, it } from "vitest";
import {
  ALL_ADDON_SEED,
  CATALOG_CATEGORY_SEED,
  LEGACY_ADDON_SEED,
  NEW_ADDON_SEED,
  addonCatalogFlagEnabled,
  addonStartingPriceLabel,
  addonSubtotalCents,
} from "@shared/addonCatalog";
import { calculateCatalogQuote, DEFAULT_PRICING } from "@shared/pricing";

describe("dynamic add-on catalog seed and money rules", () => {
  it("seeds the existing nine exactly, including current prices", () => {
    expect(LEGACY_ADDON_SEED.map(item => [item.key, item.startingPriceCents])).toEqual([
      ["pets", 2000],
      ["deepClean", 6000],
      ["moveOut", 7000],
      ["oven", 3500],
      ["refrigerator", 3500],
      ["windows", 4500],
      ["laundry", 3000],
      ["garage", 4000],
      ["organization", 5000],
    ]);
    expect(LEGACY_ADDON_SEED.every(item => item.categoryKey === "legacy-general" && item.priceMode === "fixed")).toBe(true);
  });

  it("contains every approved new option with complete bilingual names", () => {
    expect(NEW_ADDON_SEED).toHaveLength(11);
    expect(ALL_ADDON_SEED).toHaveLength(20);
    expect(NEW_ADDON_SEED.every(item => item.nameEn.trim() && item.nameEs.trim())).toBe(true);
    expect(CATALOG_CATEGORY_SEED.every(item => item.nameEn.trim() && item.nameEs.trim())).toBe(true);
  });

  it("keeps sectional starting-at and pet/balcony fixed but may-vary", () => {
    expect(NEW_ADDON_SEED.find(item => item.key === "sectional-steam-cleaning")).toMatchObject({
      priceMode: "starting_at",
      startingPriceCents: 12999,
      mayVary: true,
    });
    expect(NEW_ADDON_SEED.find(item => item.key === "pet-odor-walls-floors")).toMatchObject({
      priceMode: "fixed",
      startingPriceCents: 7999,
      mayVary: true,
    });
    expect(NEW_ADDON_SEED.filter(item => item.categoryKey === "balcony-cleaning").every(item => item.priceMode === "fixed" && item.mayVary)).toBe(true);
  });

  it("sums multiple selected items once and supports exact cents", () => {
    const addons = ALL_ADDON_SEED.map((item, index) => ({ ...item, id: index + 1, categoryId: 1, isEnabled: true, archivedAt: null }));
    expect(addonSubtotalCents(["queen-mattress-steam-cleaning", "chair-steam-cleaning"], addons)).toBe(10998);
    expect(addonSubtotalCents(["chair-steam-cleaning", "chair-steam-cleaning"], addons)).toBe(3999);
  });

  it("formats price-mode labels naturally in both languages", () => {
    expect(addonStartingPriceLabel({ priceMode: "starting_at", startingPriceCents: 12999 }, "en")).toBe("Starting at $129.99");
    expect(addonStartingPriceLabel({ priceMode: "starting_at", startingPriceCents: 12999 }, "es")).toBe("Desde $129.99");
  });

  it("requires an explicit true feature flag", () => {
    expect(addonCatalogFlagEnabled("true")).toBe(true);
    expect(addonCatalogFlagEnabled(" TRUE ")).toBe(true);
    expect(addonCatalogFlagEnabled("false")).toBe(false);
    expect(addonCatalogFlagEnabled(null)).toBe(false);
  });

  it("includes add-ons in discount and deposit math without floating-point drift", () => {
    const config = {
      ...DEFAULT_PRICING,
      tiers: { ...DEFAULT_PRICING.tiers, residential: [{ maxSqft: Infinity, price: 79.99 }] },
      frequencyDiscounts: { ...DEFAULT_PRICING.frequencyDiscounts, weekly: 0.1 },
      depositRate: 0.2,
    };
    const quote = calculateCatalogQuote(
      { type: "residential", bedrooms: 1, bathrooms: 1, sqft: 500, frequency: "weekly" },
      10998,
      config
    );
    expect(quote.baseCents).toBe(7999);
    expect(quote.subtotalCents).toBe(18997);
    expect(quote.discountCents).toBe(1900);
    expect(quote.totalCents).toBe(17097);
    expect(quote.depositCents).toBe(3419);
  });
});
