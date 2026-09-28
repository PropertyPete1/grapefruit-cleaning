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
  calculateCatalogQuote,
  calculateQuote,
  depositFor,
  depositRateFor,
  EXTRA_IDS,
  generateBookingReference,
  type PricingConfig,
} from "@shared/pricing";
import { depositCents, dollarsToCents } from "@shared/money";
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
import { lockAppliesTo, lockFromCustomer, type PriceLock } from "@shared/priceLock";
import { findGrandfatheredCustomer, grandfatheredColumns } from "./priceLock";
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
  /**
   * Book for this exact customer row, skipping the find-or-create matching
   * entirely — the brain write API's passthrough, for the operator who picked
   * the record by id rather than spelling out contact info. The caller has
   * already verified the row exists and fills the identity fields below from
   * it, so the booking, its emails, and its link all carry the right name.
   */
  customerId?: number;
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
  /** Set when the price came from the customer's grandfathered rate, not the catalog. */
  grandfathered: { customerName: string; basePrice: number } | null;
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
  extras: ExtraId[] = [],
  lock: PriceLock | null = null
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
    pricing,
    lock
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
  /** A grandfathered rate: the size then changes nothing about the price. */
  lock?: PriceLock | null;
}): { sqft: number | null; corrected: boolean } {
  const { enteredSqft } = args;
  // A record wildly larger than the entered figure — or larger than any home
  // at all — is a complex parcel or a mismatch, not this home: a failed lookup,
  // never a reprice, and never a size the booking takes on its own.
  const verifiedSqft =
    args.verifiedSqft != null && plausibleVerifiedSqft(enteredSqft, args.verifiedSqft) ? args.verifiedSqft : null;
  if (enteredSqft == null && verifiedSqft == null) return { sqft: null, corrected: false };
  if (enteredSqft == null) return { sqft: verifiedSqft, corrected: false };
  if (verifiedSqft == null) return { sqft: enteredSqft, corrected: false };
  const price = (sqft: number) =>
    computeBasePrice({ serviceType: args.serviceType, frequency: args.frequency }, sqft, args.pricing, [], args.lock ?? null)
      .total;
  return price(verifiedSqft) > price(enteredSqft)
    ? { sqft: verifiedSqft, corrected: true }
    : { sqft: enteredSqft, corrected: false };
}

/**
 * Re-prices an existing booking from its own facts — service, size, extras
 * snapshot, frequency, coupon — at a grandfathered rate (or, with null, back at
 * the catalog). The extras keep the amount they were booked at. A deposit the
 * customer has already paid is kept as paid; one still owed follows the new
 * total (and stays zero for a cash choice).
 */
export async function repriceBookingMoney(
  booking: {
    serviceType: string | null;
    frequency: string;
    bedrooms: number;
    bathrooms: number;
    sqft: number | null;
    extras: string | null;
    addonsAmountCents: number | null;
    couponCode: string | null;
    status: string;
    depositAmount: number;
    depositAmountCents: number | null;
    stripePaymentIntentId: string | null;
    paymentPreference: string | null;
  },
  lock: PriceLock | null
): Promise<{
  totalCents: number;
  depositCents: number;
  depositKept: boolean;
  discountAppliedCents: number;
  baseCents: number;
} | null> {
  if (!booking.serviceType || booking.sqft == null) return null;
  const pricing = await loadPricingConfig();
  const serviceType = booking.serviceType as CleaningType;
  const frequency = booking.frequency as Frequency;
  const quoteInput = {
    type: serviceType,
    bedrooms: booking.bedrooms,
    bathrooms: booking.bathrooms,
    sqft: booking.sqft,
    frequency,
  };
  let baseCents: number;
  let totalCents: number;
  if (booking.addonsAmountCents != null) {
    const breakdown = calculateCatalogQuote(quoteInput, booking.addonsAmountCents, pricing, lock);
    baseCents = breakdown.baseCents;
    totalCents = breakdown.totalCents;
  } else {
    // Rows older than the exact-cents columns: extras from their ids at today's
    // catalog prices, the same arithmetic the legacy path has always run.
    const ids: string[] = JSON.parse(booking.extras ?? "[]");
    const allowed = new Set<string>(EXTRA_IDS);
    const breakdown = calculateQuote(
      { ...quoteInput, extras: ids.filter(id => allowed.has(id)) as ExtraId[] },
      pricing,
      lock
    );
    baseCents = dollarsToCents(breakdown.base);
    totalCents = dollarsToCents(breakdown.total);
  }
  let discountAppliedCents = 0;
  const coupon = await usableCoupon(booking.couponCode);
  if (coupon?.percentOff) discountAppliedCents = Math.round((totalCents * coupon.percentOff) / 100);
  else if (coupon?.amountOff) discountAppliedCents = Math.min(coupon.amountOff * 100, totalCents - 100);
  totalCents = Math.max(100, totalCents - discountAppliedCents);

  const paidDepositCents = booking.depositAmountCents ?? dollarsToCents(booking.depositAmount);
  const depositKept =
    booking.stripePaymentIntentId != null || (booking.status !== "pending_deposit" && paidDepositCents > 0);
  const depositCentsNow = depositKept
    ? paidDepositCents
    : booking.paymentPreference === "cash"
      ? 0
      : depositCents(totalCents, depositRateFor(serviceType, pricing));
  return { totalCents, depositCents: depositCentsNow, depositKept, discountAppliedCents, baseCents };
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
  // With a customerId the record is already chosen; its row is the source of
  // contact truth, and a row with neither email nor phone still books (the
  // owner can read the link aloud or fix the profile after).
  if (input.customerId == null && !input.email && !input.phone) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Enter an email or a phone number — the link needs a way to reach them." });
  }
  const hasSlot = Boolean(input.date && input.time);
  if (Boolean(input.date) !== Boolean(input.time)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A held time needs both a date and a time — or leave both blank and let them pick." });
  }

  const pricing = await loadPricingConfig();

  // Grandfathered pricing: the chosen record's rate, or the rate of whichever
  // original client these contact details identify. Applies only to the
  // service the rate was set for; everyone else prices from the catalog.
  const lockedCustomer =
    input.customerId != null
      ? await db.getCustomerById(input.customerId)
      : await findGrandfatheredCustomer({ email: input.email, phone: input.phone });
  const lockCandidate = lockFromCustomer(lockedCustomer);
  const priceLock = lockAppliesTo(lockCandidate, input.serviceType) ? lockCandidate : null;

  // County verification runs whenever there is an address to look up, exactly
  // as the public flow does — the verified figure can settle the size question
  // even when the owner left sqft blank. Never for apartments: parcels are
  // building-level, and the complex's figure is nobody's home.
  const property =
    input.address && input.propertyType !== "apartment"
      ? await lookupPropertySqft(input.address, input.city, input.zip)
      : ({ verified: false, addressVerified: false } as Awaited<ReturnType<typeof lookupPropertySqft>>);
  // A record more than 4x the typed size, or larger than any home, is the
  // building or a mismatch — a failed lookup, whether or not a size was typed.
  const believableRecord = Boolean(
    property.verified && property.sqft && plausibleVerifiedSqft(input.sqft ?? null, property.sqft)
  );

  let effectiveSqft: number | null = input.sqft ?? null;
  let sqftMismatch = false;
  if (input.serviceType && believableRecord && property.sqft) {
    const resolved = resolveEffectiveSqft({
      enteredSqft: input.sqft ?? null,
      verifiedSqft: property.sqft,
      serviceType: input.serviceType,
      frequency: input.frequency,
      pricing,
      lock: priceLock,
    });
    effectiveSqft = resolved.sqft;
    sqftMismatch = resolved.corrected;
  } else if (effectiveSqft == null && believableRecord && property.sqft) {
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
        pricing,
        [],
        priceLock
      )
    : null;
  const coupon = breakdown ? await applyCoupon(breakdown.total, input.couponCode) : null;
  // Per-type rate: an Airbnb turnover prices its deposit at 0 whatever the dial says.
  const deposit = coupon ? depositFor(coupon.total, depositRateFor(input.serviceType, pricing)) : null;

  const holdMinutes = adminHoldMinutes(await db.getSetting(ADMIN_HOLD_SETTING_KEY));
  const reference = generateBookingReference();
  const payToken = generateDepositToken();
  const createdAt = new Date();
  // One window, two meanings that coincide: with a slot it is the hold AND the
  // link's life; without one it is only how long the link works — no inventory
  // is at stake, and the stale-release machinery skips slotless rows entirely.
  const expiresAt = depositLinkExpiresAt(createdAt, holdMinutes);

  // A recognised grandfathered client books on her own record, whatever
  // contact she was entered under this time — and a customer the owner picked
  // from the list books on that record, with the contact fields he saw (and
  // may have corrected) refreshed onto it. Only a caller that named the row
  // and nothing else skips the refresh: there is nothing to refresh from.
  const customerId =
    input.customerId != null && !input.email && !input.phone
      ? input.customerId
      : await db.findOrCreateCustomer({
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          address: input.address,
          city: input.city,
          zip: input.zip,
          preferredLocale: input.locale ?? "en",
          customerId: input.customerId ?? lockedCustomer?.id,
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
      verifiedSqft: believableRecord ? property.sqft : undefined,
      sqftSource: property.verified || property.addressVerified ? property.source : undefined,
      sqftMismatch,
      ...grandfatheredColumns(priceLock),
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
    grandfathered: priceLock
      ? { customerName: priceLock.customerName, basePrice: priceLock.basePriceCents / 100 }
      : null,
  };
}
