/**
 * Grapefruit Cleaning Co. — shared pricing engine.
 * Single source of truth used by the quote calculator, booking flow, and server.
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

export const BASE_PRICES: Record<CleaningType, number> = {
  residential: 100,
  commercial: 160,
  airbnb: 110,
  moveinout: 180,
  deep: 150,
  office: 140,
};

export const PER_BEDROOM = 25;
export const PER_BATHROOM = 30;
/** price per 500 sqft above the first 500 */
export const PER_500_SQFT = 20;

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

export interface QuoteBreakdown {
  base: number;
  rooms: number;
  sqftCharge: number;
  extrasTotal: number;
  subtotal: number;
  discount: number;
  total: number;
  deposit: number;
}

export function calculateQuote(input: QuoteInput): QuoteBreakdown {
  const base = BASE_PRICES[input.type] ?? BASE_PRICES.residential;
  const bedrooms = Math.max(0, Math.min(10, Math.round(input.bedrooms)));
  const bathrooms = Math.max(1, Math.min(10, Math.round(input.bathrooms)));
  const sqft = Math.max(200, Math.min(10000, input.sqft));
  const rooms = bedrooms * PER_BEDROOM + bathrooms * PER_BATHROOM;
  const sqftCharge = Math.max(0, Math.ceil((sqft - 500) / 500)) * PER_500_SQFT;
  const extrasTotal = input.extras.reduce((sum, id) => sum + (EXTRA_PRICES[id] ?? 0), 0);
  const subtotal = base + rooms + sqftCharge + extrasTotal;
  const discountRate = FREQUENCY_DISCOUNTS[input.frequency] ?? 0;
  const discount = Math.round(subtotal * discountRate);
  const total = subtotal - discount;
  const deposit = Math.round(total * DEPOSIT_RATE);
  return { base, rooms, sqftCharge, extrasTotal, subtotal, discount, total, deposit };
}

export const TIME_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"] as const;

export function generateBookingReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GFC-";
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}
