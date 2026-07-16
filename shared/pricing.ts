/**
 * Grapefruit Cleaning Co. — shared pricing engine.
 * Single source of truth used by the quote calculator, booking flow, and server.
 *
 * Pricing is CONFIGURABLE from the admin panel (setting key "pricing_config").
 * The values below are the owner-specified DEFAULTS used when no override is
 * stored or the stored JSON is invalid:
 *
 * RESIDENTIAL CLEANING
 * - Under 1,000 sq ft: $99.99
 * - 1,000–1,500 sq ft: $129.99
 * - 1,500–2,000 sq ft: $159.99
 * - 2,000–2,500 sq ft: $199.99
 * - 2,500–3,500 sq ft: Starting at $249.99
 * - 3,500+ sq ft: Custom Quote
 *
 * DEEP CLEANING
 * - Under 1,000 sq ft: $179.99
 * - 1,000–1,500 sq ft: $229.99
 * - 1,500–2,500 sq ft: $299.99
 * - 2,500+ sq ft: Starting at $399.99
 *
 * MOVE-IN / MOVE-OUT CLEANING
 * - Under 1,000 sq ft: $169.99
 * - 1,000–1,500 sq ft: $199.99
 * - 1,500–2,000 sq ft: $249.99
 * - 2,000–2,500 sq ft: $299.99
 * - 2,500+ sq ft: Starting at $349.99
 */

import { z } from "zod";

export type CleaningType = "residential" | "commercial" | "airbnb" | "moveinout" | "deep" | "office";
export type Frequency = "onetime" | "weekly" | "biweekly" | "monthly";
export type ExtraId =
  | "pets"
  | "deepClean"
  | "moveOut"
  | "oven"
  | "refrigerator"
  | "windows"
  | "laundry"
  | "garage"
  | "organization";

export interface QuoteInput {
  type: CleaningType;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  extras: ExtraId[];
  frequency: Frequency;
}

/** A single fixed pricing tier keyed by max square footage (exclusive). */
export interface PricingTier {
  /** Upper bound of the tier in sq ft; sqft < tier.maxSqft matches this tier. Infinity = top tier. */
  maxSqft: number;
  /** Fixed price in USD. */
  price: number;
  /** True when the price is a "starting at" figure. */
  startingAt?: boolean;
  /** True when the tier requires a custom quote (no online price). */
  customQuote?: boolean;
}

/** Types of cleaning that have their own tier table. */
export type TieredType = "residential" | "deep" | "moveinout";

/** Full pricing configuration — everything the admin can edit. */
export interface PricingConfig {
  tiers: Record<TieredType, PricingTier[]>;
  /** Custom-quote baselines / service-visit minimums for non-tiered types. */
  basePrices: Record<CleaningType, number>;
  extras: Record<ExtraId, number>;
  frequencyDiscounts: Record<Frequency, number>;
  depositRate: number;
}

/** Setting key under which the pricing override JSON is stored. */
export const PRICING_SETTING_KEY = "pricing_config";

/** Owner-specified default pricing (fallback when no valid override stored). */
export const DEFAULT_PRICING: PricingConfig = {
  tiers: {
    residential: [
      { maxSqft: 1000, price: 99.99 },
      { maxSqft: 1500, price: 129.99 },
      { maxSqft: 2000, price: 159.99 },
      { maxSqft: 2500, price: 199.99 },
      { maxSqft: 3500, price: 249.99, startingAt: true },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ],
    deep: [
      { maxSqft: 1000, price: 179.99 },
      { maxSqft: 1500, price: 229.99 },
      { maxSqft: 2500, price: 299.99 },
      { maxSqft: Infinity, price: 399.99, startingAt: true },
    ],
    moveinout: [
      { maxSqft: 1000, price: 169.99 },
      { maxSqft: 1500, price: 199.99 },
      { maxSqft: 2000, price: 249.99 },
      { maxSqft: 2500, price: 299.99 },
      { maxSqft: Infinity, price: 349.99, startingAt: true },
    ],
  },
  basePrices: {
    residential: 99.99,
    commercial: 179.99,
    airbnb: 99.99,
    moveinout: 169.99,
    deep: 179.99,
    office: 179.99,
  },
  extras: {
    pets: 20,
    deepClean: 60,
    moveOut: 70,
    oven: 35,
    refrigerator: 35,
    windows: 45,
    laundry: 30,
    garage: 40,
    organization: 50,
  },
  frequencyDiscounts: {
    onetime: 0,
    weekly: 0.2,
    biweekly: 0.15,
    monthly: 0.1,
  },
  depositRate: 0.2,
};

// ---------------------------------------------------------------------------
// Config parsing / validation
// ---------------------------------------------------------------------------

/**
 * JSON can't encode Infinity, so the top tier is serialized with maxSqft: null.
 * The zod schema accepts number | null and maps null → Infinity.
 */
const tierSchema = z.object({
  maxSqft: z
    .union([z.number().positive(), z.null()])
    .transform(v => (v === null ? Infinity : v)),
  price: z.number().min(0).max(100000),
  startingAt: z.boolean().optional(),
  customQuote: z.boolean().optional(),
});

const tierTableSchema = z
  .array(tierSchema)
  .min(1)
  .refine(
    table => table.some(t => !Number.isFinite(t.maxSqft)),
    { message: "tier table must end with an unbounded (null maxSqft) tier" }
  );

const pricingConfigSchema = z.object({
  tiers: z.object({
    residential: tierTableSchema,
    deep: tierTableSchema,
    moveinout: tierTableSchema,
  }),
  basePrices: z.object({
    residential: z.number().min(0),
    commercial: z.number().min(0),
    airbnb: z.number().min(0),
    moveinout: z.number().min(0),
    deep: z.number().min(0),
    office: z.number().min(0),
  }),
  extras: z.object({
    pets: z.number().min(0),
    deepClean: z.number().min(0),
    moveOut: z.number().min(0),
    oven: z.number().min(0),
    refrigerator: z.number().min(0),
    windows: z.number().min(0),
    laundry: z.number().min(0),
    garage: z.number().min(0),
    organization: z.number().min(0),
  }),
  frequencyDiscounts: z.object({
    onetime: z.number().min(0).max(0.95),
    weekly: z.number().min(0).max(0.95),
    biweekly: z.number().min(0).max(0.95),
    monthly: z.number().min(0).max(0.95),
  }),
  depositRate: z.number().min(0.01).max(1),
});

/**
 * Parse a stored pricing_config JSON string. Any missing/invalid payload
 * falls back to DEFAULT_PRICING so pricing can never break the site.
 */
export function parsePricingConfig(raw: string | null | undefined): PricingConfig {
  if (!raw) return DEFAULT_PRICING;
  try {
    const parsed = pricingConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_PRICING;
    // Sort tier tables by maxSqft so lookup order is always correct.
    const sortTable = (t: PricingTier[]) => [...t].sort((a, b) => a.maxSqft - b.maxSqft);
    const cfg = parsed.data;
    return {
      ...cfg,
      tiers: {
        residential: sortTable(cfg.tiers.residential),
        deep: sortTable(cfg.tiers.deep),
        moveinout: sortTable(cfg.tiers.moveinout),
      },
    };
  } catch {
    return DEFAULT_PRICING;
  }
}

/** Serialize a PricingConfig to JSON (Infinity → null for the top tiers). */
export function serializePricingConfig(config: PricingConfig): string {
  return JSON.stringify(config, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? null : value
  );
}

// ---------------------------------------------------------------------------
// Backward-compatible constant exports (all derived from DEFAULT_PRICING)
// ---------------------------------------------------------------------------

/** @deprecated read from a PricingConfig instead; kept for compatibility. */
export const PRICING_TIERS: Partial<Record<CleaningType, PricingTier[]>> = DEFAULT_PRICING.tiers;

/**
 * Airbnb cleanings follow the residential tier table; commercial and office
 * spaces vary too widely for fixed tiers and always use a custom-quote
 * baseline, with the listed price as the service-visit minimum.
 */
export const BASE_PRICES: Record<CleaningType, number> = DEFAULT_PRICING.basePrices;

export const EXTRA_PRICES: Record<ExtraId, number> = DEFAULT_PRICING.extras;

export const FREQUENCY_DISCOUNTS: Record<Frequency, number> = DEFAULT_PRICING.frequencyDiscounts;

/** Deposit rate charged at booking (20%). */
export const DEPOSIT_RATE = DEFAULT_PRICING.depositRate;

/** Resolve the tier for a cleaning type + square footage under a config. */
export function getTier(
  type: CleaningType,
  sqft: number,
  config: PricingConfig = DEFAULT_PRICING
): PricingTier | null {
  const key = type === "airbnb" ? "residential" : type;
  const table = key === "residential" || key === "deep" || key === "moveinout" ? config.tiers[key] : null;
  if (!table) return null;
  for (const tier of table) {
    if (sqft < tier.maxSqft) return tier;
  }
  return table[table.length - 1];
}

export interface QuoteBreakdown {
  base: number;
  rooms: number;
  sqftCharge: number;
  extrasTotal: number;
  subtotal: number;
  discount: number;
  total: number;
  deposit: number;
  /** True when the base price is a "starting at" figure. */
  startingAt: boolean;
  /** True when the size requires a custom quote (residential 3,500+ sq ft). */
  customQuote: boolean;
}

export function calculateQuote(input: QuoteInput, config: PricingConfig = DEFAULT_PRICING): QuoteBreakdown {
  const sqft = Math.max(200, Math.min(20000, input.sqft));
  const tier = getTier(input.type, sqft, config);

  let base: number;
  let startingAt = false;
  let customQuote = false;

  if (tier) {
    if (tier.customQuote) {
      customQuote = true;
      // Use the last priced tier as the reference floor for display purposes.
      const table = config.tiers[input.type === "airbnb" ? "residential" : (input.type as TieredType)];
      const lastPriced = [...table].reverse().find(t => !t.customQuote);
      base = lastPriced?.price ?? 0;
      startingAt = true;
    } else {
      base = tier.price;
      startingAt = Boolean(tier.startingAt);
    }
  } else {
    // Commercial / office: custom-quote baseline with service-visit minimum.
    base = config.basePrices[input.type] ?? config.basePrices.residential;
    startingAt = true;
  }

  // Fixed tier pricing already accounts for home size; bedrooms/bathrooms do
  // not change the base. (Kept in the breakdown as 0 for UI compatibility.)
  const rooms = 0;
  const sqftCharge = 0;
  const extrasTotal = input.extras.reduce((sum, id) => sum + (config.extras[id] ?? 0), 0);
  const subtotal = round2(base + extrasTotal);
  const discountRate = config.frequencyDiscounts[input.frequency] ?? 0;
  const discount = round2(subtotal * discountRate);
  const total = round2(subtotal - discount);
  const deposit = round2(total * config.depositRate);
  return { base, rooms, sqftCharge, extrasTotal, subtotal, discount, total, deposit, startingAt, customQuote };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function generateBookingReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GFC-";
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}
