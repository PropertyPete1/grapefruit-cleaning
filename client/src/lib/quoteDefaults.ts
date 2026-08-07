/**
 * What the quote and booking forms open at, before the visitor enters anything.
 *
 * The first number a visitor sees is a first impression of what the company
 * costs, so it has to be the entry price — the cheapest tier of whichever
 * service is selected — not a mid-ladder default. These forms used to open
 * prefilled at 2 bed / 1 bath / 1,200 sq ft, which landed in the middle of the
 * residential ladder and quoted well above the real starting price.
 *
 * Everything here is derived from the live pricing config, so it stays correct
 * when the owner reshapes the tiers in Admin → Services. Nothing about the
 * pricing engine itself changes — this only decides where the form starts.
 */
import { getTier, type CleaningType, type PricingConfig } from "@shared/pricing";

/** Smallest home the quote engine will price — calculateQuote clamps to this. */
export const MIN_QUOTE_SQFT = 200;

/** Bedrooms/bathrooms the forms open at: the smallest configuration offered. */
export const ENTRY_BEDROOMS = 1;
export const ENTRY_BATHROOMS = 1;

/**
 * A friendlier opening figure than the bare 200 sq ft floor, used whenever it
 * still falls inside the cheapest tier. Reads like a real small home rather
 * than the engine's lower bound.
 */
const PREFERRED_ENTRY_SQFT = 500;

/**
 * Square footage to open at for a cleaning type.
 *
 * Tiers only ever get more expensive as they get bigger, so the cheapest price
 * is always whatever the floor resolves to. This returns a value guaranteed to
 * sit in that same cheapest tier: the preferred figure when it fits, otherwise
 * the largest size that still does.
 *
 * Untiered services (commercial, office) price off basePrices regardless of
 * size, so the figure is cosmetic there and the preferred one is used.
 */
export function entrySqft(type: CleaningType, config: PricingConfig): number {
  const cheapestTier = getTier(type, MIN_QUOTE_SQFT, config);
  if (!cheapestTier || !Number.isFinite(cheapestTier.maxSqft)) return PREFERRED_ENTRY_SQFT;

  // maxSqft is exclusive, so the last size still inside the tier is one below.
  const largestInTier = Math.floor(cheapestTier.maxSqft) - 1;
  return Math.max(MIN_QUOTE_SQFT, Math.min(PREFERRED_ENTRY_SQFT, largestInTier));
}
