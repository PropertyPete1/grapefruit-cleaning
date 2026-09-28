/**
 * What the public site advertises.
 *
 * The pricing page shows the tier ladders with a frequency toggle. The number
 * a first-time visitor sees must be the one-time catalog price — the figure
 * they will actually be quoted — not a recurring plan's discounted price
 * presented as if it were the base. The page once opened on the bi-weekly tab,
 * so every tier showed 15% off ($67.99 where the catalog says $79.99), and on
 * phones the "Save 15%" tag that explained it is hidden.
 *
 * Pure and shared so the page, the tests and any future surface agree on both
 * the default and the arithmetic. Recurring pricing is still available behind
 * the toggle; hiding it from first-time visitors altogether is a separate
 * change.
 */
import type { Frequency, PricingConfig } from "./pricing";

/** The tab the public pricing page opens on: the catalog price, undiscounted. */
export const DEFAULT_PUBLIC_FREQUENCY: Frequency = "onetime";

/**
 * A tier's headline price at a frequency. At the one-time frequency this is
 * the catalog price itself — the multiplication is skipped, so no rounding can
 * ever move it off the number in Admin → Services & Pricing.
 */
export function publicTierPrice(price: number, frequency: Frequency, config: PricingConfig): number {
  const rate = config.frequencyDiscounts[frequency] ?? 0;
  if (rate <= 0) return price;
  return Math.round(price * (1 - rate) * 100) / 100;
}
