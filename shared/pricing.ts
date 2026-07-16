/**
 * Grapefruit Cleaning Co. — shared pricing engine.
 * Single source of truth used by the quote calculator, booking flow, and server.
 *
 * FIXED PRICING STRUCTURE (per owner specification — do not estimate or
 * generate different values):
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
  /** Upper bound of the tier in sq ft; sqft < maxSqft matches this tier. Infinity = top tier. */
  maxSqft: number;
  /** Fixed price in USD. */
  price: number;
  /** True when the price is a "starting at" figure. */
  startingAt?: boolean;
  /** True when the tier requires a custom quote (no online price). */
  customQuote?: boolean;
}

/** FIXED tier tables — the exact prices provided by the owner. NEVER alter. */
export const PRICING_TIERS: Partial<Record<CleaningType, PricingTier[]>> = {
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
};

/**
 * Airbnb cleanings follow the residential tier table; commercial and office
 * spaces vary too widely for fixed tiers and always use a custom-quote
 * baseline, with the listed price as the service-visit minimum.
 */
export const BASE_PRICES: Record<CleaningType, number> = {
  residential: 99.99,
  commercial: 179.99,
  airbnb: 99.99,
  moveinout: 169.99,
  deep: 179.99,
  office: 179.99,
};

export const EXTRA_PRICES: Record<ExtraId, number> = {
  pets: 20,
  deepClean: 60,
  moveOut: 70,
  oven: 35,
  refrigerator: 35,
  windows: 45,
  laundry: 30,
  garage: 40,
  organization: 50,
};

export const FREQUENCY_DISCOUNTS: Record<Frequency, number> = {
  onetime: 0,
  weekly: 0.2,
  biweekly: 0.15,
  monthly: 0.1,
};

/** Deposit rate charged at booking (20%). */
export const DEPOSIT_RATE = 0.2;

/** Resolve the fixed tier for a cleaning type + square footage. */
export function getTier(type: CleaningType, sqft: number): PricingTier | null {
  const table = PRICING_TIERS[type === "airbnb" ? "residential" : type];
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

export function calculateQuote(input: QuoteInput): QuoteBreakdown {
  const sqft = Math.max(200, Math.min(20000, input.sqft));
  const tier = getTier(input.type, sqft);

  let base: number;
  let startingAt = false;
  let customQuote = false;

  if (tier) {
    if (tier.customQuote) {
      customQuote = true;
      // Use the last priced tier as the reference floor for deposit-free display.
      base = 249.99;
      startingAt = true;
    } else {
      base = tier.price;
      startingAt = Boolean(tier.startingAt);
    }
  } else {
    // Commercial / office: custom-quote baseline with service-visit minimum.
    base = BASE_PRICES[input.type] ?? BASE_PRICES.residential;
    startingAt = true;
  }

  // Fixed tier pricing already accounts for home size; bedrooms/bathrooms do
  // not change the base. (Kept in the breakdown as 0 for UI compatibility.)
  const rooms = 0;
  const sqftCharge = 0;
  const extrasTotal = input.extras.reduce((sum, id) => sum + (EXTRA_PRICES[id] ?? 0), 0);
  const subtotal = round2(base + extrasTotal);
  const discountRate = FREQUENCY_DISCOUNTS[input.frequency] ?? 0;
  const discount = round2(subtotal * discountRate);
  const total = round2(subtotal - discount);
  const deposit = round2(total * DEPOSIT_RATE);
  return { base, rooms, sqftCharge, extrasTotal, subtotal, discount, total, deposit, startingAt, customQuote };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const TIME_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"] as const;

export function generateBookingReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GFC-";
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}
