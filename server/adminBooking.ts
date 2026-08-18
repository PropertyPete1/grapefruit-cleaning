/**
 * Admin-created bookings and their deposit links.
 *
 * Real phone leads arrive in every state of completeness: sometimes the owner
 * has the whole job scoped, sometimes he has a first name and a number typed
 * with his thumb between calls. The form requires exactly what a link cannot
 * work without — a name and a way to reach them — and everything else is
 * optional. Whatever the owner locks is settled; whatever he leaves blank, the
 * CUSTOMER fills in on the link, watching the price assemble as they go.
 *
 * Two rules hold this together, unchanged from the first version:
 *
 *   1. Money is never taken from a client. Neither form sends a price; the pay
 *      page sends selections. Every dollar figure is computed here from the
 *      live pricing config — at creation when possible, at each step, and
 *      finally at payment.
 *
 *   2. Holding a slot means holding it for real. A booking created WITH a time
 *      occupies it under the same unique index and overlap rules as a
 *      self-serve one. A booking created WITHOUT one holds nothing — inventory
 *      is claimed the moment the customer picks, not the moment the owner
 *      guesses.
 */
import { TRPCError } from "@trpc/server";
import { randomBytes } from "node:crypto";
import {
  applyCouponToTotal,
  calculateQuote,
  depositFor,
  generateBookingReference,
  type PricingConfig,
} from "@shared/pricing";
import { isSlotBookable, type AvailabilityContext } from "@shared/availability";
import { durationHoursFor, type DurationConfig } from "@shared/duration";
import { ADMIN_HOLD_SETTING_KEY, adminHoldMinutes } from "@shared/holdWindow";
import type { CleaningType, ExtraId, Frequency } from "@shared/pricing";
import * as db from "./db";
import {
  depositLinkExpiresAt,
  depositPayUrl,
  serializeAdminProvided,
  type ProvidedFact,
} from "./depositLinkRules";
import { lookupPropertySqft } from "./property";
import { plausibleVerifiedSqft, type PropertyType } from "@shared/property";
import { loadPricingConfig, loadSchedulingRules, occupiedIntervals } from "./routers/booking";

/** A deposit-link token: 24 random bytes, the same strength as an invoice's. */
export function generateDepositToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * What the owner fills in. Required: a name and one way to reach the
 * customer. Everything else is what he happens to know — note the continued
 * absence of extras and of any price.
 */
export interface AdminBookingInput {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  serviceType?: CleaningType;
  frequency?: Frequency;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  date?: string;
  time?: string;
  address?: string;
  /** House verifies against county records; apartment/condo never does. */
  propertyType?: PropertyType;
  unitNumber?: string;
  city?: string;
  zip?: string;
  notes?: string;
  /** Drives the language of their email and their pay page. */
  locale?: "en" | "es";
  couponCode?: string;
  /**
   * Admin-only escape from the minimum-notice rule, for the customer standing
   * in the kitchen asking for tomorrow morning when the rule says three days.
   * Only meaningful when the owner picks the time himself; a customer claiming
   * a slot through the link always gets the public rules.
   *
   * It relaxes the notice requirement to zero — it does not open the past, and
   * every other rule (open hours, lunch, taken slots, closing time) still
   * applies.
   */
  overrideNotice?: boolean;
}

export interface AdminBookingResult {
  bookingId: number;
  reference: string;
  payToken: string;
  payUrl: string;
  /** Base price before extras, or null while a pricing fact is still missing. */
  basePrice: number | null;
  depositEstimate: number | null;
  expiresAt: Date;
  /** True when county records priced the home above what the owner typed. */
  sqftCorrected: boolean;
  sqft: number | null;
  /** The facts the customer will be asked for on the link. */
  customerWillChoose: string[];
}

/** The one message the owner sees when the slot will not take this booking. */
export function slotUnavailableError(): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "That date and time is not bookable — the hours, the notice period, or another booking rules it out.",
  });
}

/**
 * Whether this slot may be booked, under every scheduling rule.
 *
 * Deliberately the same isSlotBookable the public calendar and booking.create
 * go through, with the same occupancy: a hand-entered booking that ignored the
 * rules would produce exactly the overlapping pair the owner would then have
 * to untangle by hand.
 */
export async function adminSlotBookable(args: {
  date: string;
  time: string;
  jobHours: number;
  overrideNotice: boolean;
  schedule: AvailabilityContext["schedule"];
  lunchBreak: boolean;
  leadTimeHours: number;
  durations: DurationConfig;
  excludeBookingId?: number;
}): Promise<boolean> {
  const rows = (await db.getOccupiedBookings(args.date)).filter(
    row => row.id !== args.excludeBookingId
  );
  return isSlotBookable(
    {
      date: args.date,
      schedule: args.schedule,
      lunchBreak: args.lunchBreak,
      leadTimeHours: args.overrideNotice ? 0 : args.leadTimeHours,
      occupied: occupiedIntervals(rows, args.durations),
      jobHours: args.jobHours,
    },
    args.time
  );
}

/**
 * The quote for a booking's known facts plus a set of extras.
 *
 * Bedrooms and bathrooms default to the schema's own defaults — they are crew
 * information, not price inputs, under fixed tier pricing.
 */
export function computeBasePrice(
  input: { serviceType: CleaningType; frequency?: Frequency | null; bedrooms?: number | null; bathrooms?: number | null },
  sqft: number,
  pricing: PricingConfig,
  extras: ExtraId[] = []
) {
  return calculateQuote(
    {
      type: input.serviceType,
      bedrooms: input.bedrooms ?? 2,
      bathrooms: input.bathrooms ?? 1,
      sqft,
      extras,
      frequency: input.frequency ?? "onetime",
    },
    pricing
  );
}

/** A coupon row, only when the server would actually honour it right now. */
export async function usableCoupon(couponCode: string | null | undefined) {
  if (!couponCode) return undefined;
  const coupon = await db.getCouponByCode(couponCode.trim().toUpperCase());
  const today = new Date().toISOString().slice(0, 10);
  const usable =
    coupon &&
    coupon.active &&
    (!coupon.expiresAt || coupon.expiresAt >= today) &&
    (!coupon.maxRedemptions || coupon.timesRedeemed < coupon.maxRedemptions);
  return usable ? coupon : undefined;
}

/** Applies a coupon to a total, server-side, returning the discounted total. */
export async function applyCoupon(
  total: number,
  couponCode: string | null | undefined
): Promise<{ total: number; discountApplied: number; couponCode?: string }> {
  const coupon = await usableCoupon(couponCode);
  if (!coupon) return { total, discountApplied: 0 };
  // The arithmetic itself is shared with the pay page's live preview, so what
  // the customer watches update is what they are charged.
  const applied = applyCouponToTotal(total, coupon);
  return { ...applied, couponCode: coupon.code };
}

/**
 * Resolves the effective square footage from what the owner typed and what the
 * county records say, under the standing rule: when both exist, the figure
 * that prices higher wins, so an understated guess cannot lower the price.
 * With only one source, that source is simply the answer.
 */
export function resolveEffectiveSqft(args: {
  enteredSqft: number | null;
  verifiedSqft: number | null;
  serviceType: CleaningType;
  frequency?: Frequency | null;
  pricing: PricingConfig;
}): { sqft: number | null; corrected: boolean } {
  const { enteredSqft, verifiedSqft } = args;
  if (enteredSqft == null && verifiedSqft == null) return { sqft: null, corrected: false };
  if (enteredSqft == null) return { sqft: verifiedSqft, corrected: false };
  if (verifiedSqft == null) return { sqft: enteredSqft, corrected: false };
  // A record wildly larger than the entered figure is a complex parcel or a
  // mismatch, not this home — a failed lookup, never a reprice.
  if (!plausibleVerifiedSqft(enteredSqft, verifiedSqft)) {
    return { sqft: enteredSqft, corrected: false };
  }
  const price = (sqft: number) =>
    computeBasePrice({ serviceType: args.serviceType, frequency: args.frequency }, sqft, args.pricing).total;
  return price(verifiedSqft) > price(enteredSqft)
    ? { sqft: verifiedSqft, corrected: true }
    : { sqft: enteredSqft, corrected: false };
}

/**
 * Creates the booking in whatever state of completeness the owner has, and
 * issues the deposit link.
 *
 * With a slot: the same check-verify-recheck sandwich, stale-hold release and
 * unique-index catch as the public flow, and the slot is held for the admin
 * window. Without one: no scheduling checks run and no inventory is touched —
 * the row's scheduledDate/Time stay NULL, its generated slotKey stays NULL,
 * and the unique index ignores it entirely.
 */
export async function createAdminBooking(
  input: AdminBookingInput,
  origin: string
): Promise<AdminBookingResult> {
  if (!input.email && !input.phone) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Enter an email or a phone number — the link needs a way to reach them." });
  }
  const hasSlot = Boolean(input.date && input.time);
  if (Boolean(input.date) !== Boolean(input.time)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A held time needs both a date and a time — or leave both blank and let them pick." });
  }

  const pricing = await loadPricingConfig();

  // County verification runs whenever there is an address to look up, exactly
  // as the public flow does — the verified figure can settle the size question
  // even when the owner left sqft blank. Never for apartments: parcels are
  // building-level, and the complex's figure is nobody's home.
  const property =
    input.address && input.propertyType !== "apartment"
      ? await lookupPropertySqft(input.address, input.city, input.zip)
      : ({ verified: false, addressVerified: false } as Awaited<ReturnType<typeof lookupPropertySqft>>);

  let effectiveSqft: number | null = input.sqft ?? null;
  let sqftMismatch = false;
  if (input.serviceType && property.verified && property.sqft) {
    const resolved = resolveEffectiveSqft({
      enteredSqft: input.sqft ?? null,
      verifiedSqft: property.sqft,
      serviceType: input.serviceType,
      frequency: input.frequency,
      pricing,
    });
    effectiveSqft = resolved.sqft;
    sqftMismatch = resolved.corrected;
  } else if (effectiveSqft == null && property.verified && property.sqft) {
    // Size known from records alone; without a service there is nothing to
    // price yet, but the fact itself is settled.
    effectiveSqft = property.sqft;
  }

  const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
  const overrideNotice = input.overrideNotice === true;
  const priceable = Boolean(input.serviceType && effectiveSqft != null);

  // Duration for slot checks: from the real facts when known, the ladder
  // fallback otherwise (an hour — the same floor the public calendar uses
  // before a quote is complete).
  const estimatedHours =
    input.serviceType != null && effectiveSqft != null
      ? durationHoursFor(input.serviceType, effectiveSqft, durations)
      : null;

  if (hasSlot) {
    const bookable = await adminSlotBookable({
      date: input.date!,
      time: input.time!,
      jobHours: estimatedHours ?? 1,
      overrideNotice,
      schedule,
      lunchBreak,
      leadTimeHours,
      durations,
    });
    if (!bookable) throw slotUnavailableError();
  }

  const breakdown = priceable
    ? computeBasePrice(
        { serviceType: input.serviceType!, frequency: input.frequency, bedrooms: input.bedrooms, bathrooms: input.bathrooms },
        effectiveSqft!,
        pricing
      )
    : null;
  const coupon = breakdown ? await applyCoupon(breakdown.total, input.couponCode) : null;
  const deposit = coupon ? depositFor(coupon.total, pricing.depositRate) : null;

  const holdMinutes = adminHoldMinutes(await db.getSetting(ADMIN_HOLD_SETTING_KEY));
  const reference = generateBookingReference();
  const payToken = generateDepositToken();
  const createdAt = new Date();
  // One window, two meanings that coincide: with a slot it is the hold AND the
  // link's life; without one it is only how long the link works — no inventory
  // is at stake, and the stale-release machinery skips slotless rows entirely.
  const expiresAt = depositLinkExpiresAt(createdAt, holdMinutes);

  const customerId = await db.findOrCreateCustomer({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    address: input.address,
    city: input.city,
    zip: input.zip,
    preferredLocale: input.locale ?? "en",
  });

  // Provenance: the facts the OWNER locked. Everything else is the customer's
  // to fill in — and to re-edit until they pay.
  const provided: ProvidedFact[] = [];
  if (input.serviceType) provided.push("service");
  if (effectiveSqft != null) provided.push("size");
  if (input.address) provided.push("address");
  if (hasSlot) provided.push("slot");

  if (hasSlot) {
    await db.expireStaleBookingsForSlot(input.date!, input.time!);
    const stillBookable = await adminSlotBookable({
      date: input.date!,
      time: input.time!,
      jobHours: estimatedHours ?? 1,
      overrideNotice,
      schedule,
      lunchBreak,
      leadTimeHours,
      durations,
    });
    if (!stillBookable) throw slotUnavailableError();
  }

  let bookingId: number;
  try {
    bookingId = await db.createBooking({
      reference,
      customerId,
      serviceType: input.serviceType ?? null,
      frequency: input.frequency ?? "onetime",
      scheduledDate: input.date ?? null,
      scheduledTime: input.time ?? null,
      bedrooms: input.bedrooms ?? 2,
      bathrooms: input.bathrooms ?? 1,
      sqft: effectiveSqft != null ? Math.round(effectiveSqft) : null,
      estimatedHours,
      // Empty until the customer chooses on the pay page. The owner is
      // deliberately not asked to guess on their behalf.
      extras: JSON.stringify([]),
      addressLine: input.address,
      unitNumber: input.unitNumber,
      propertyType: input.propertyType ?? "house",
      city: input.city,
      zip: input.zip,
      notes: input.notes,
      locale: input.locale ?? "en",
      // Zero while unpriceable — recomputed the moment the missing fact
      // arrives, and again at payment. Never shown to anyone as a price.
      totalAmount: coupon?.total ?? 0,
      depositAmount: deposit ?? 0,
      status: "pending_deposit",
      couponCode: coupon?.couponCode ?? input.couponCode?.trim().toUpperCase(),
      discountApplied: coupon?.discountApplied ?? 0,
      verifiedSqft: property.verified ? property.sqft : undefined,
      sqftSource: property.verified || property.addressVerified ? property.source : undefined,
      sqftMismatch,
      kind: "admin",
      holdMinutes,
      payToken,
      payTokenExpiresAt: expiresAt,
      adminProvided: serializeAdminProvided(provided),
    });
  } catch (error) {
    if (db.isSlotTakenError(error)) throw slotUnavailableError();
    throw error;
  }

  const missing: string[] = [];
  if (!input.serviceType) missing.push("service");
  if (effectiveSqft == null) missing.push("size");
  if (!hasSlot) missing.push("time");

  return {
    bookingId,
    reference,
    payToken,
    payUrl: depositPayUrl(origin, payToken),
    basePrice: coupon?.total ?? null,
    depositEstimate: deposit,
    expiresAt,
    sqftCorrected: sqftMismatch,
    sqft: effectiveSqft != null ? Math.round(effectiveSqft) : null,
    customerWillChoose: missing,
  };
}
