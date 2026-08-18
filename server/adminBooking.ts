/**
 * Admin-created bookings and their deposit links.
 *
 * Many customers ask for pricing by phone or text and never touch the website.
 * The owner enters the basics here, and the CUSTOMER finishes the job on a
 * personal link: they pick their own extras, watch the price move, and pay the
 * deposit. That split is the whole point — the owner should not have to
 * interrogate someone about oven cleaning while writing down their address.
 *
 * Two rules hold this together:
 *
 *   1. Money is never taken from the client. The admin form sends no prices,
 *      and the pay page sends only extra IDs. Every dollar figure is computed
 *      here from the live pricing config, at creation and again at payment.
 *
 *   2. The booking is a real booking from the moment it is created. It holds
 *      its slot as pending_deposit against the same unique index and the same
 *      overlap rules as a self-serve one, so the owner can promise the
 *      appointment on the phone and have that promise mean something.
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
import { depositLinkExpiresAt, depositPayUrl } from "./depositLinkRules";
import { lookupPropertySqft } from "./property";
import { loadPricingConfig, loadSchedulingRules, occupiedIntervals } from "./routers/booking";

/** A deposit-link token: 24 random bytes, the same strength as an invoice's. */
export function generateDepositToken(): string {
  return randomBytes(24).toString("hex");
}

/** What the owner fills in. Note the absence of extras and of any price. */
export interface AdminBookingInput {
  serviceType: CleaningType;
  frequency: Frequency;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  date: string;
  time: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  notes?: string;
  /** Drives the language of their email and their pay page. */
  locale: "en" | "es";
  couponCode?: string;
  /**
   * Admin-only escape from the minimum-notice rule, for the customer standing
   * in the kitchen asking for tomorrow morning when the rule says three days.
   *
   * It relaxes the notice requirement to zero — it does not open the past. A
   * slot that has already begun is still refused, because booking a cleaning
   * for nine this morning at half past four is a mistake however it is entered.
   * Every other rule (open hours, lunch, taken slots, closing time) still
   * applies: this overrides one rule, not the scheduler.
   */
  overrideNotice?: boolean;
}

export interface AdminBookingResult {
  bookingId: number;
  reference: string;
  payToken: string;
  payUrl: string;
  /** Base price before the customer's own extras, in whole dollars. */
  basePrice: number;
  depositEstimate: number;
  expiresAt: Date;
  /** True when county records priced the home above what the owner typed. */
  sqftCorrected: boolean;
  sqft: number;
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
 * go through, with the same occupancy: an admin booking that ignored the rules
 * would produce exactly the overlapping pair the owner would then have to
 * untangle by hand.
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
 * The base price of an admin-created booking: the quote with no extras.
 *
 * Extras are the customer's to choose on the pay page, so the figure stored at
 * creation is a floor, not a total. Frequency discount and coupon are applied
 * here as well as at payment, so the owner sees on screen what the customer
 * will see in their email.
 */
export function computeBasePrice(
  input: Pick<AdminBookingInput, "serviceType" | "frequency" | "bedrooms" | "bathrooms">,
  sqft: number,
  pricing: PricingConfig,
  extras: ExtraId[] = []
) {
  return calculateQuote(
    {
      type: input.serviceType,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft,
      extras,
      frequency: input.frequency,
    },
    pricing
  );
}

/**
 * Applies a coupon to a total, server-side, returning the discounted total.
 *
 * Lifted out of booking.create's body so the admin flow and the pay page apply
 * a coupon the same way rather than each growing their own arithmetic. An
 * unusable coupon (missing, inactive, expired, exhausted) is silently no
 * discount, exactly as it is in the public flow.
 */
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
 * Creates the booking, holds the slot, and issues the deposit link.
 *
 * Mirrors booking.create step for step — county sqft verification, the
 * check-verify-recheck sandwich around the network call, the stale-hold
 * release before the insert, the unique-index catch — because the failure
 * modes are identical and solving them twice, differently, is how the two
 * paths drift apart.
 */
export async function createAdminBooking(
  input: AdminBookingInput,
  origin: string
): Promise<AdminBookingResult> {
  const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
  const overrideNotice = input.overrideNotice === true;

  const bookable = (jobHours: number) =>
    adminSlotBookable({
      date: input.date,
      time: input.time,
      jobHours,
      overrideNotice,
      schedule,
      lunchBreak,
      leadTimeHours,
      durations,
    });

  // Fast fail on the entered size, before spending a round trip on the county
  // records. The authoritative check is the second one, before the insert.
  if (!(await bookable(durationHoursFor(input.serviceType, input.sqft, durations)))) {
    throw slotUnavailableError();
  }

  // Same verification the public flow runs: if county records price the home
  // into a higher tier than the entered figure, the verified square footage
  // wins, so an understated guess on the phone cannot lower the price.
  const pricing = await loadPricingConfig();
  const property = await lookupPropertySqft(input.address, input.city, input.zip);
  let effectiveSqft = input.sqft;
  let sqftMismatch = false;
  if (property.verified && property.sqft) {
    const entered = computeBasePrice(input, input.sqft, pricing);
    const verified = computeBasePrice(input, property.sqft, pricing);
    if (verified.total > entered.total) {
      effectiveSqft = property.sqft;
      sqftMismatch = true;
    }
  }

  const breakdown = computeBasePrice(input, effectiveSqft, pricing);
  const coupon = await applyCoupon(breakdown.total, input.couponCode);
  const deposit = depositFor(coupon.total, pricing.depositRate);

  const holdMinutes = adminHoldMinutes(await db.getSetting(ADMIN_HOLD_SETTING_KEY));
  const reference = generateBookingReference();
  const payToken = generateDepositToken();
  const createdAt = new Date();
  const expiresAt = depositLinkExpiresAt(createdAt, holdMinutes);

  const customerId = await db.findOrCreateCustomer({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    address: input.address,
    city: input.city,
    zip: input.zip,
    preferredLocale: input.locale,
  });

  await db.expireStaleBookingsForSlot(input.date, input.time);

  const estimatedHours = durationHoursFor(input.serviceType, effectiveSqft, durations);
  if (!(await bookable(estimatedHours))) throw slotUnavailableError();

  let bookingId: number;
  try {
    bookingId = await db.createBooking({
      reference,
      customerId,
      serviceType: input.serviceType,
      frequency: input.frequency,
      scheduledDate: input.date,
      scheduledTime: input.time,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft: Math.round(effectiveSqft),
      estimatedHours,
      // Empty until the customer chooses on the pay page. The owner is
      // deliberately not asked to guess on their behalf.
      extras: JSON.stringify([]),
      addressLine: input.address,
      city: input.city,
      zip: input.zip,
      notes: input.notes,
      locale: input.locale,
      totalAmount: coupon.total,
      depositAmount: deposit,
      status: "pending_deposit",
      couponCode: coupon.couponCode,
      discountApplied: coupon.discountApplied,
      verifiedSqft: property.verified ? property.sqft : undefined,
      sqftSource: property.verified || property.addressVerified ? property.source : undefined,
      sqftMismatch,
      kind: "admin",
      holdMinutes,
      payToken,
      payTokenExpiresAt: expiresAt,
    });
  } catch (error) {
    if (db.isSlotTakenError(error)) throw slotUnavailableError();
    throw error;
  }

  return {
    bookingId,
    reference,
    payToken,
    payUrl: depositPayUrl(origin, payToken),
    basePrice: coupon.total,
    depositEstimate: deposit,
    expiresAt,
    sqftCorrected: sqftMismatch,
    sqft: Math.round(effectiveSqft),
  };
}
