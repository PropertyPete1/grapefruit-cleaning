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

/** Every service that can be booked, in the order they are offered. */
export const CLEANING_TYPES = [
  "residential",
  "commercial",
  "airbnb",
  "moveinout",
  "deep",
  "office",
] as const;

export type CleaningType = (typeof CLEANING_TYPES)[number];

/** Every booking cadence, in the order they are offered. */
export const FREQUENCIES = ["onetime", "weekly", "biweekly", "monthly"] as const;

export type Frequency = (typeof FREQUENCIES)[number];

/**
 * Every add-on a customer may choose, in the order they are offered.
 *
 * The one list. The quote form renders it, the booking input validates against
 * it, and the deposit pay page prices from it — a second copy anywhere is a
 * copy that eventually accepts an extra the pricing config has no price for.
 */
export const EXTRA_IDS = [
  "pets",
  "deepClean",
  "moveOut",
  "oven",
  "refrigerator",
  "windows",
  "laundry",
  "garage",
  "organization",
] as const;

export type ExtraId = (typeof EXTRA_IDS)[number];

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

/** The discount terms of a coupon, without the bookkeeping around it. */
export interface CouponTerms {
  percentOff?: number | null;
  amountOff?: number | null;
}

/**
 * Applies a coupon's discount to a total, in whole dollars.
 *
 * Shared so the deposit pay page can preview a price the instant an extra is
 * tapped and still be showing the figure the server will charge. The server
 * decides whether a coupon is usable at all (active, in date, not exhausted);
 * this is only the arithmetic, and both sides run this exact function.
 *
 * A percentage rounds to the nearest dollar; a fixed amount never takes the
 * total below $1, so a generous coupon leaves something to charge rather than
 * producing a zero-dollar Stripe session.
 */
export function applyCouponToTotal(
  total: number,
  coupon: CouponTerms | null | undefined
): { total: number; discountApplied: number } {
  if (!coupon) return { total, discountApplied: 0 };
  let discountApplied = 0;
  if (coupon.percentOff) discountApplied = Math.round((total * coupon.percentOff) / 100);
  else if (coupon.amountOff) discountApplied = Math.min(coupon.amountOff, total - 1);
  return { total: Math.max(1, total - discountApplied), discountApplied };
}

/**
 * The deposit owed on a total, in whole dollars.
 *
 * A positive rate never charges less than $1 (Stripe cannot mint a $0
 * session). A rate of 0 is a real mode, not a degenerate rate: no deposit is
 * owed, checkout skips Stripe, and the booking confirms on submit — so 0 must
 * come back as 0, never rounded up to a dollar.
 */
export function depositFor(total: number, depositRate: number): number {
  if (depositRate <= 0) return 0;
  return Math.max(1, Math.round(total * depositRate));
}

/** Setting key under which the pricing override JSON is stored. */
export const PRICING_SETTING_KEY = "pricing_config";

/**
 * Owner-specified default pricing (fallback when no valid override stored).
 *
 * Tiers step roughly every 200 sq ft so the county-verified square footage the
 * booking flow looks up lands on a price that actually fits the home, instead
 * of rounding into a 500 sq ft band. Residential is the anchor ladder, starting
 * at $79.99 for a 1 bed / 1 bath apartment; deep cleans run ~1.8x residential
 * and move in/out ~1.6x, matching the ratios those services have always had.
 */
export const DEFAULT_PRICING: PricingConfig = {
  tiers: {
    residential: [
      { maxSqft: 700, price: 79.99 },
      { maxSqft: 900, price: 89.99 },
      { maxSqft: 1100, price: 99.99 },
      { maxSqft: 1300, price: 112.99 },
      { maxSqft: 1500, price: 124.99 },
      { maxSqft: 1700, price: 136.99 },
      { maxSqft: 1900, price: 149.99 },
      { maxSqft: 2100, price: 162.99 },
      { maxSqft: 2300, price: 176.99 },
      { maxSqft: 2500, price: 189.99 },
      { maxSqft: 2800, price: 209.99 },
      { maxSqft: 3100, price: 229.99 },
      { maxSqft: 3500, price: 249.99, startingAt: true },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ],
    deep: [
      { maxSqft: 700, price: 143.99 },
      { maxSqft: 900, price: 161.99 },
      { maxSqft: 1100, price: 179.99 },
      { maxSqft: 1300, price: 202.99 },
      { maxSqft: 1500, price: 224.99 },
      { maxSqft: 1700, price: 246.99 },
      { maxSqft: 1900, price: 269.99 },
      { maxSqft: 2100, price: 292.99 },
      { maxSqft: 2300, price: 318.99 },
      { maxSqft: 2500, price: 341.99 },
      { maxSqft: 2800, price: 377.99 },
      { maxSqft: 3100, price: 413.99 },
      { maxSqft: 3500, price: 449.99 },
      { maxSqft: Infinity, price: 485.99, startingAt: true },
    ],
    moveinout: [
      { maxSqft: 700, price: 127.99 },
      { maxSqft: 900, price: 143.99 },
      { maxSqft: 1100, price: 159.99 },
      { maxSqft: 1300, price: 180.99 },
      { maxSqft: 1500, price: 199.99 },
      { maxSqft: 1700, price: 218.99 },
      { maxSqft: 1900, price: 239.99 },
      { maxSqft: 2100, price: 260.99 },
      { maxSqft: 2300, price: 282.99 },
      { maxSqft: 2500, price: 303.99 },
      { maxSqft: 2800, price: 335.99 },
      { maxSqft: 3100, price: 367.99 },
      { maxSqft: 3500, price: 399.99 },
      { maxSqft: Infinity, price: 431.99, startingAt: true },
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
  // 0 is deliberate: it turns deposits off entirely (bookings confirm without
  // payment). The dial the owner can turn back up later.
  depositRate: z.number().min(0).max(1),
});

// ---------------------------------------------------------------------------
// Strict validation (write path)
// ---------------------------------------------------------------------------

/**
 * Hard cap on tiers per service. Generous enough for 100 sq ft steps across the
 * whole range, low enough that a runaway config can't wedge the pricing table.
 */
export const MAX_TIERS_PER_SERVICE = 25;

/** A tier as stored in JSON, before null → Infinity conversion. */
const storedTierSchema = z.object({
  maxSqft: z.union([z.number(), z.null()]),
  price: z.number().min(0).max(100000),
  startingAt: z.boolean().optional(),
  customQuote: z.boolean().optional(),
});

type StoredTier = z.infer<typeof storedTierSchema>;

/**
 * Enforces the tier-ladder invariants the quote engine relies on: boundaries
 * strictly increasing positive whole numbers, and exactly one unbounded tier
 * sitting at the end so every home size resolves to a price.
 *
 * The read path (parsePricingConfig) deliberately stays lenient — this runs on
 * writes, where a bad config must be rejected rather than silently ignored.
 */
function validateTierLadder(table: StoredTier[], ctx: z.RefinementCtx): void {
  const unboundedAt = table.flatMap((tier, index) => (tier.maxSqft === null ? [index] : []));
  if (unboundedAt.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "the last tier must be unbounded (no max sq ft) so every home size has a price",
    });
  } else if (unboundedAt.length > 1) {
    ctx.addIssue({ code: "custom", message: "only one unbounded tier is allowed" });
  } else if (unboundedAt[0] !== table.length - 1) {
    ctx.addIssue({ code: "custom", message: "the unbounded tier must be the last one in the table" });
  }

  let previous = 0;
  table.forEach((tier, index) => {
    if (tier.customQuote && index !== table.length - 1) {
      ctx.addIssue({
        code: "custom",
        path: [index, "customQuote"],
        message: `tier ${index + 1}: only the last tier may be a custom quote`,
      });
    }
    if (tier.maxSqft === null) return;
    if (!Number.isInteger(tier.maxSqft) || tier.maxSqft <= 0) {
      ctx.addIssue({
        code: "custom",
        path: [index, "maxSqft"],
        message: `tier ${index + 1}: max sq ft must be a positive whole number`,
      });
      return;
    }
    if (tier.maxSqft <= previous) {
      ctx.addIssue({
        code: "custom",
        path: [index, "maxSqft"],
        message: `tier ${index + 1}: max sq ft (${tier.maxSqft}) must be greater than the previous tier's ${previous}`,
      });
      return;
    }
    previous = tier.maxSqft;
  });
}

const strictTierTableSchema = z
  .array(storedTierSchema)
  .min(1, "at least one tier is required")
  .max(MAX_TIERS_PER_SERVICE, `at most ${MAX_TIERS_PER_SERVICE} tiers are allowed`)
  .superRefine(validateTierLadder)
  .transform(table => table.map(t => ({ ...t, maxSqft: t.maxSqft === null ? Infinity : t.maxSqft })));

const strictPricingConfigSchema = pricingConfigSchema.extend({
  tiers: z.object({
    residential: strictTierTableSchema,
    deep: strictTierTableSchema,
    moveinout: strictTierTableSchema,
  }),
});

export type PricingValidation =
  | { ok: true; config: PricingConfig }
  | { ok: false; errors: string[] };

/**
 * Validates a pricing config on the way IN (admin save). Accepts either a JSON
 * string or a plain object and returns readable errors instead of silently
 * falling back to defaults, so an admin never saves a config the site would
 * then ignore.
 */
export function validatePricingConfig(raw: unknown): PricingValidation {
  let candidate = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["pricing config is not valid JSON"] };
    }
  }
  const parsed = strictPricingConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { ok: false, errors };
  }
  return { ok: true, config: parsed.data };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Entry price to advertise for a service ("from $X per visit").
 *
 * Tiered services (and Airbnb, which follows the residential table) start at
 * their cheapest tier — derived from the ladder rather than basePrices, which
 * is only a custom-quote baseline for commercial and office work.
 */
export function startingPriceFor(type: CleaningType, config: PricingConfig = DEFAULT_PRICING): number {
  const key = type === "airbnb" ? "residential" : type;
  const table = key === "residential" || key === "deep" || key === "moveinout" ? config.tiers[key] : null;
  const priced = table?.filter(tier => !tier.customQuote) ?? [];
  if (priced.length === 0) return config.basePrices[type] ?? config.basePrices.residential;
  return Math.min(...priced.map(tier => tier.price));
}

/**
 * Human label for a tier's square-footage band, derived from the tier itself
 * and the one below it — never from hard-coded boundaries, so it stays correct
 * however the admin reshapes the ladder.
 */
export function tierRangeLabel(
  tier: PricingTier,
  previous: PricingTier | undefined,
  labels: { under: string; over: string; sqft: string; anySize: string }
): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (!previous) {
    return tier.maxSqft === Infinity ? labels.anySize : `${labels.under} ${fmt(tier.maxSqft)} ${labels.sqft}`;
  }
  if (tier.maxSqft === Infinity) return `${labels.over} ${fmt(previous.maxSqft)} ${labels.sqft}`;
  return `${fmt(previous.maxSqft)}–${fmt(tier.maxSqft)} ${labels.sqft}`;
}

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
