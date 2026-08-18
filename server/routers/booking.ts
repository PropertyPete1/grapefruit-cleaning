import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  calculateQuote,
  EXTRA_IDS,
  generateBookingReference,
  parsePricingConfig,
  PRICING_SETTING_KEY,
  type PricingConfig,
} from "@shared/pricing";
import {
  isSlotBookable,
  overlapsAny,
  slotAvailability,
  type AvailabilityContext,
  type OccupiedInterval,
} from "@shared/availability";
import {
  DURATION_SETTING_KEY,
  durationHoursFor,
  parseDurationConfig,
  type DurationConfig,
} from "@shared/duration";
import { LEAD_TIME_SETTING_KEY, parseLeadTimeHours } from "@shared/leadTime";
import { LUNCH_SETTING_KEY, parseLunchBreak, parseSchedule, SCHEDULE_SETTING_KEY } from "@shared/schedule";
import * as db from "../db";
import { assertRateLimit, clientIp } from "../antiSpam";
import { blocksSlot, STALE_DEPOSIT_MINUTES } from "../bookingRules";
import { parseAdminProvided } from "../depositLinkRules";
import { composeAddress, plausibleVerifiedSqft, PROPERTY_TYPES } from "@shared/property";
import { sendBookingEmails } from "../emails";
import { lookupPropertySqft } from "../property";
import { publicOrigin } from "../publicOrigin";
import { getStripe } from "../stripe";
import { publicProcedure, router } from "../_core/trpc";

const quoteInputSchema = z.object({
  type: z.enum(["residential", "commercial", "airbnb", "moveinout", "deep", "office"]),
  bedrooms: z.number().int().min(0).max(10),
  bathrooms: z.number().int().min(1).max(10),
  sqft: z.number().min(200).max(10000),
  extras: z.array(z.enum(EXTRA_IDS)),
  frequency: z.enum(["onetime", "weekly", "biweekly", "monthly"]),
});

export const SERVICE_NAMES: Record<string, { en: string; es: string }> = {
  residential: { en: "Residential Cleaning", es: "Limpieza Residencial" },
  commercial: { en: "Commercial Cleaning", es: "Limpieza Comercial" },
  airbnb: { en: "Airbnb Cleaning", es: "Limpieza Airbnb" },
  moveinout: { en: "Move In/Out Cleaning", es: "Limpieza de Mudanza" },
  deep: { en: "Deep Cleaning", es: "Limpieza Profunda" },
  office: { en: "Office Cleaning", es: "Limpieza de Oficinas" },
};

export const FREQUENCY_NAMES: Record<string, { en: string; es: string }> = {
  onetime: { en: "One-time", es: "Una sola vez" },
  weekly: { en: "Weekly", es: "Semanal" },
  biweekly: { en: "Every two weeks", es: "Quincenal" },
  monthly: { en: "Monthly", es: "Mensual" },
};

export const EXTRA_NAMES: Record<string, { en: string; es: string }> = {
  pets: { en: "Home with pets", es: "Hogar con mascotas" },
  deepClean: { en: "Deep cleaning", es: "Limpieza profunda" },
  moveOut: { en: "Move out condition", es: "Condición de mudanza" },
  oven: { en: "Inside oven", es: "Interior del horno" },
  refrigerator: { en: "Inside refrigerator", es: "Interior del refrigerador" },
  windows: { en: "Interior windows", es: "Ventanas interiores" },
  laundry: { en: "Laundry & folding", es: "Lavandería y doblado" },
  garage: { en: "Garage sweep", es: "Barrido de cochera" },
  organization: { en: "Home organization", es: "Organización del hogar" },
};

/** Load the live pricing configuration from settings (fallback: defaults). */
export async function loadPricingConfig(): Promise<PricingConfig> {
  return parsePricingConfig(await db.getSetting(PRICING_SETTING_KEY));
}

/** Load the live job-duration ladders from settings (fallback: defaults). */
export async function loadDurationConfig(): Promise<DurationConfig> {
  return parseDurationConfig(await db.getSetting(DURATION_SETTING_KEY));
}

/**
 * Every setting a scheduling decision reads, fetched together.
 *
 * One loader for all of them, used by the public calendar, booking.create and
 * the admin create form alike: a caller that assembles its own subset is a
 * caller that can disagree with the calendar about what is bookable.
 */
export async function loadSchedulingRules() {
  const [scheduleRaw, lunchRaw, leadTimeRaw, durationRaw] = await Promise.all([
    db.getSetting(SCHEDULE_SETTING_KEY),
    db.getSetting(LUNCH_SETTING_KEY),
    db.getSetting(LEAD_TIME_SETTING_KEY),
    db.getSetting(DURATION_SETTING_KEY),
  ]);
  return {
    schedule: parseSchedule(scheduleRaw),
    lunchBreak: parseLunchBreak(lunchRaw),
    leadTimeHours: parseLeadTimeHours(leadTimeRaw),
    durations: parseDurationConfig(durationRaw),
  };
}

/**
 * The spans live bookings occupy on a date.
 *
 * Each booking's duration is the one pinned when it was made. Rows written
 * before durations existed have none, and fall back to what the current ladder
 * says a job that size would take — which is the best guess available, and
 * strictly better than the old behaviour of blocking only the start hour.
 */
/**
 * Adds the resolved duration to booking rows for the dashboards.
 *
 * `estimatedHours` is NULL on anything booked before durations existed, and the
 * dashboards should still show a span for those rather than nothing — so the
 * fallback to the current ladder happens here, once, instead of in every view.
 * The raw column is left untouched beside it.
 */
export async function withDurationHours<
  T extends { serviceType: string | null; sqft: number | null; estimatedHours: number | null },
>(rows: T[]): Promise<(T & { durationHours: number })[]> {
  if (rows.length === 0) return [];
  const durations = await loadDurationConfig();
  return rows.map(row => ({
    ...row,
    durationHours: row.estimatedHours ?? durationHoursFor(row.serviceType, row.sqft, durations),
  }));
}

export function occupiedIntervals(
  rows: { time: string; serviceType: string | null; sqft: number | null; estimatedHours: number | null }[],
  durations: DurationConfig
): OccupiedInterval[] {
  return rows.map(row => ({
    time: row.time,
    hours: row.estimatedHours ?? durationHoursFor(row.serviceType, row.sqft, durations),
  }));
}

export const bookingRouter = router({
  /** Server-side authoritative quote calculation. */
  calculate: publicProcedure.input(quoteInputSchema).query(async ({ input }) => {
    const config = await loadPricingConfig();
    return calculateQuote(input, config);
  }),

  /** Live pricing configuration (tiers, extras, discounts, deposit rate) for public pages. */
  pricingConfig: publicProcedure.query(async () => loadPricingConfig()),

  /**
   * Verify a property's square footage against public county records
   * (Bexar County Appraisal District GIS). Best-effort — returns
   * { verified: false } when no record is found so the flow never blocks.
   */
  verifyProperty: publicProcedure
    .input(
      z.object({
        address: z.string().min(3).max(255),
        city: z.string().max(120).optional(),
        zip: z.string().max(20).optional(),
      })
    )
    .query(async ({ input }) => lookupPropertySqft(input.address, input.city, input.zip)),

  /**
   * Available time slots for a given date.
   *
   * The service type and size are optional so the calendar still works before
   * a quote is complete, but the client sends them once it has them: they are
   * what lets the closing-time rule keep a job from starting too late to
   * finish. Unavailable slots are returned flagged rather than dropped — an
   * empty list is how the calendar says "closed that day", which would be the
   * wrong thing to say about a day that is open but fully committed.
   */
  availability: publicProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        serviceType: z.enum(["residential", "commercial", "airbnb", "moveinout", "deep", "office"]).optional(),
        sqft: z.number().min(200).max(20000).optional(),
      })
    )
    .query(async ({ input }) => {
      const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
      const rows = await db.getOccupiedBookings(input.date);
      return slotAvailability({
        date: input.date,
        schedule,
        lunchBreak,
        leadTimeHours,
        occupied: occupiedIntervals(rows, durations),
        jobHours:
          input.serviceType && input.sqft !== undefined
            ? durationHoursFor(input.serviceType, input.sqft, durations)
            : undefined,
      });
    }),

  /**
   * Weekly booking schedule (public) so the calendar can disable closed days,
   * plus the lunch-break flag so it can explain the gap at noon rather than
   * leaving a hole in the hours with no reason given.
   */
  schedule: publicProcedure.query(async () => {
    const [scheduleRaw, lunchRaw] = await Promise.all([
      db.getSetting(SCHEDULE_SETTING_KEY),
      db.getSetting(LUNCH_SETTING_KEY),
    ]);
    return { days: parseSchedule(scheduleRaw), lunchBreak: parseLunchBreak(lunchRaw) };
  }),

  /** Validate a coupon code and return the discount. */
  validateCoupon: publicProcedure.input(z.object({ code: z.string().min(1).max(40) })).query(async ({ input }) => {
    const coupon = await db.getCouponByCode(input.code.trim().toUpperCase());
    if (!coupon || !coupon.active) return { valid: false as const };
    if (coupon.expiresAt && coupon.expiresAt < new Date().toISOString().slice(0, 10)) return { valid: false as const };
    if (coupon.maxRedemptions && coupon.timesRedeemed >= coupon.maxRedemptions) return { valid: false as const };
    return {
      valid: true as const,
      code: coupon.code,
      percentOff: coupon.percentOff,
      amountOff: coupon.amountOff,
      description: coupon.description,
    };
  }),

  /** Create booking + Stripe Checkout session for the deposit. */
  create: publicProcedure
    .input(
      z.object({
        quote: quoteInputSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email().max(320),
        phone: z.string().min(7).max(40),
        address: z.string().min(1).max(255),
        /** House verifies against county records; apartment/condo never does. */
        propertyType: z.enum(PROPERTY_TYPES).default("house"),
        unitNumber: z.string().max(20).optional(),
        city: z.string().min(1).max(100),
        zip: z.string().min(3).max(20),
        notes: z.string().max(2000).optional(),
        locale: z.enum(["en", "es"]),
        couponCode: z.string().max(40).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Nuisance-bot protection: max 5 booking attempts per IP per minute.
      assertRateLimit("booking", clientIp(ctx), 5, 60_000);
      // Enforce every scheduling rule server-side: the admin-defined hours
      // (e.g. Sundays when closed), the minimum lead time, the hours other
      // bookings have already committed for their full duration, and whether
      // this job finishes before closing. The calendar hides all four, so this
      // is what stops a crafted request.
      const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
      /** The one message a customer ever sees for an unavailable slot. */
      const slotUnavailable = () =>
        new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.locale === "es"
              ? "El horario seleccionado no está disponible. Por favor elija otro."
              : "The selected time is not available for booking. Please choose another.",
        });
      /** The same rules the calendar renders from, against a given occupancy. */
      const bookableNow = async (jobHours: number) => {
        const rows = await db.getOccupiedBookings(input.date);
        const context: AvailabilityContext = {
          date: input.date,
          schedule,
          lunchBreak,
          leadTimeHours,
          occupied: occupiedIntervals(rows, durations),
          jobHours,
        };
        return isSlotBookable(context, input.time);
      };

      // Fast fail on what the entered size implies, before spending a network
      // round trip on the county records. The authoritative check is the second
      // one, immediately before the insert.
      if (!(await bookableNow(durationHoursFor(input.quote.type, input.quote.sqft, durations)))) {
        throw slotUnavailable();
      }
      // Verify square footage against public property records (best-effort).
      // If the county record prices into a higher tier than the entered sqft,
      // charge from the verified square footage so understated entries can't
      // lower the price.
      //
      // Apartments and condos skip the lookup outright: county parcels are
      // building-level, and "the whole complex" is not this customer's home.
      // Houses keep the plausibility guard for the same false positive
      // arriving by another road — a record more than 4x the entered size is
      // a failed lookup, not a reprice.
      const pricing = await loadPricingConfig();
      const property =
        input.propertyType === "apartment"
          ? ({ verified: false, addressVerified: false } as Awaited<ReturnType<typeof lookupPropertySqft>>)
          : await lookupPropertySqft(input.address, input.city, input.zip);
      let effectiveSqft = input.quote.sqft;
      let sqftMismatch = false;
      if (property.verified && property.sqft && plausibleVerifiedSqft(input.quote.sqft, property.sqft)) {
        const entered = calculateQuote(input.quote, pricing);
        const verified = calculateQuote({ ...input.quote, sqft: property.sqft }, pricing);
        if (verified.total > entered.total) {
          effectiveSqft = property.sqft;
          sqftMismatch = true;
        }
      }
      const effectiveQuote = { ...input.quote, sqft: effectiveSqft };
      const breakdown = calculateQuote(effectiveQuote, pricing);
      let total = breakdown.total;
      let discountApplied = 0;
      let couponCode: string | undefined;

      if (input.couponCode) {
        const coupon = await db.getCouponByCode(input.couponCode.trim().toUpperCase());
        const today = new Date().toISOString().slice(0, 10);
        const usable =
          coupon &&
          coupon.active &&
          (!coupon.expiresAt || coupon.expiresAt >= today) &&
          (!coupon.maxRedemptions || coupon.timesRedeemed < coupon.maxRedemptions);
        if (usable) {
          if (coupon.percentOff) discountApplied = Math.round((total * coupon.percentOff) / 100);
          else if (coupon.amountOff) discountApplied = Math.min(coupon.amountOff, total - 1);
          total = Math.max(1, total - discountApplied);
          couponCode = coupon.code;
        }
      }

      const deposit = Math.max(1, Math.round(total * pricing.depositRate));
      const reference = generateBookingReference();

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

      // The unique index on slotKey is what finally decides an identical start
      // time. Before reaching it, hand back any hold left by an abandoned
      // checkout on this slot — getOccupiedBookings already counts those as
      // free, but the row keeps the slot until its status changes, and the
      // index goes by the row.
      await db.expireStaleBookingsForSlot(input.date, input.time);

      // Re-check as close to the insert as this can get. Two things can have
      // moved since the first check: another booking may have taken overlapping
      // hours during the county lookup, and the verified square footage may have
      // pushed this job into a longer duration band that no longer fits.
      //
      // Interval overlap is APPLICATION-ENFORCED and cannot be otherwise. The
      // slotKey unique index expresses "one booking per exact start time" and
      // has no way to express "no booking whose span crosses mine" — MySQL has
      // no exclusion constraint. So the index remains the last-line guard for
      // two customers submitting the same start, and everything wider than that
      // is this check. The window between it and the insert is small but real;
      // a collision inside it costs an overlapping pair the owner has to
      // reschedule, the same outcome as the slot-conflict flag below.
      const estimatedHours = durationHoursFor(input.quote.type, effectiveSqft, durations);
      if (!(await bookableNow(estimatedHours))) {
        throw slotUnavailable();
      }

      let bookingId: number;
      try {
        bookingId = await db.createBooking({
          reference,
          customerId,
          serviceType: input.quote.type,
          frequency: input.quote.frequency,
          scheduledDate: input.date,
          scheduledTime: input.time,
          bedrooms: input.quote.bedrooms,
          bathrooms: input.quote.bathrooms,
          sqft: Math.round(effectiveSqft),
          // Pinned now, so a later edit to the duration ladder cannot change
          // the span this booking occupies once it is paid for.
          estimatedHours,
          extras: JSON.stringify(input.quote.extras),
          addressLine: input.address,
          unitNumber: input.unitNumber,
          propertyType: input.propertyType,
          city: input.city,
          zip: input.zip,
          notes: input.notes,
          locale: input.locale,
          totalAmount: total,
          depositAmount: deposit,
          status: "pending_deposit",
          couponCode,
          discountApplied,
          verifiedSqft: property.verified ? property.sqft : undefined,
          sqftSource: property.verified || property.addressVerified ? property.source : undefined,
          sqftMismatch,
        });
      } catch (error) {
        // Someone else took this slot between the check and the insert. That is
        // the race the index exists to stop; the customer just needs the normal
        // "pick another time" message, not a server error.
        if (db.isSlotTakenError(error)) throw slotUnavailable();
        throw error;
      }

      // Create Stripe Checkout session for the deposit
      const stripe = getStripe();
      const origin = publicOrigin(ctx.req);
      const serviceName = SERVICE_NAMES[input.quote.type][input.locale];
      // Where Stripe sends the customer back. These MUST match the client's
      // booking route for each locale (ROUTE_SLUGS.booking in
      // client/src/i18n/types.ts): an unrouted path falls through to the
      // catch-all redirect, which drops the query string, so the return-page
      // confirmation fallback never runs. Pinned by stripeReturn.test.ts.
      const bookingPath = input.locale === "es" ? "/es/reservar" : "/en/book";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: input.email,
        client_reference_id: String(bookingId),
        allow_promotion_codes: false,
        // The payment link dies when the booking goes stale and releases its
        // slot (STALE_DEPOSIT_MINUTES), so an old tab can't quietly pay for a
        // slot that has been given away. Stripe allows 30 min–24 h.
        expires_at: Math.floor(Date.now() / 1000) + STALE_DEPOSIT_MINUTES * 60,
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: deposit * 100,
              product_data: {
                name:
                  input.locale === "es"
                    ? `Depósito de reserva — ${serviceName}`
                    : `Booking deposit — ${serviceName}`,
                description:
                  input.locale === "es"
                    ? `Reserva ${reference} · ${input.date} a las ${input.time} · Total estimado $${total}`
                    : `Booking ${reference} · ${input.date} at ${input.time} · Estimated total $${total}`,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          booking_id: String(bookingId),
          booking_reference: reference,
          customer_email: input.email,
          customer_name: `${input.firstName} ${input.lastName}`,
          locale: input.locale,
        },
        success_url: `${origin}${bookingPath}?session_id={CHECKOUT_SESSION_ID}&ref=${reference}`,
        cancel_url: `${origin}${bookingPath}?cancelled=1&ref=${reference}`,
      });

      await db.updateBooking(bookingId, { stripeSessionId: session.id });

      return { bookingId, reference, checkoutUrl: session.url };
    }),

  /** Confirm a booking after Stripe checkout succeeds (fallback to webhook). */
  confirm: publicProcedure
    .input(z.object({ sessionId: z.string().min(1), reference: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const booking = await db.getBookingByReference(input.reference);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      if (booking.stripeSessionId !== input.sessionId)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Session mismatch" });

      if (booking.status === "pending_deposit" || booking.status === "expired") {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(input.sessionId);
        if (session.payment_status !== "paid") {
          return { confirmed: false as const };
        }
        await finalizeBooking(booking.id, (session.payment_intent as string) ?? null);
      }

      const updated = await db.getBookingById(booking.id);
      const customer = await db.getCustomerById(booking.customerId);
      return {
        confirmed: true as const,
        booking: {
          reference: updated.reference,
          serviceType: updated.serviceType ?? "residential",
          date: updated.scheduledDate ?? "",
          time: updated.scheduledTime ?? "",
          total: updated.totalAmount,
          deposit: updated.depositAmount,
          customerFirstName: customer?.firstName ?? "",
          email: customer?.email ?? "",
        },
      };
    }),

  /** Look up booking status by reference (post-payment confirmation page). */
  byReference: publicProcedure.input(z.object({ reference: z.string().min(1) })).query(async ({ input }) => {
    const booking = await db.getBookingByReference(input.reference);
    if (!booking) return null;
    return {
      reference: booking.reference,
      status: booking.status,
      serviceType: booking.serviceType,
      date: booking.scheduledDate,
      time: booking.scheduledTime,
      total: booking.totalAmount,
      deposit: booking.depositAmount,
    };
  }),
});

/**
 * Shared finalization: mark confirmed, record payment, redeem coupon, send emails.
 * Idempotent — only acts on unpaid bookings: pending_deposit, or expired
 * (a stale checkout whose Stripe payment arrived late still gets confirmed).
 */
/**
 * Whether any other live booking's span crosses this one's.
 *
 * Excludes the booking itself by id, so a row that does still hold its own
 * hours can never be reported as clashing with itself.
 */
async function overlapsLiveBooking(booking: {
  id: number;
  scheduledDate: string | null;
  scheduledTime: string | null;
  serviceType: string | null;
  sqft: number | null;
  estimatedHours: number | null;
}): Promise<boolean> {
  // No slot, no conflict: a booking that holds no hours cannot cross anyone's.
  if (!booking.scheduledDate || !booking.scheduledTime) return false;
  const durations = await loadDurationConfig();
  const others = (await db.getOccupiedBookings(booking.scheduledDate)).filter(row => row.id !== booking.id);
  const mine = {
    time: booking.scheduledTime,
    hours: booking.estimatedHours ?? durationHoursFor(booking.serviceType, booking.sqft, durations),
  };
  return overlapsAny(mine, occupiedIntervals(others, durations));
}

export async function finalizeBooking(bookingId: number, paymentIntentId: string | null): Promise<void> {
  const booking = await db.getBookingById(bookingId);
  if (!booking || (booking.status !== "pending_deposit" && booking.status !== "expired")) return;

  // Defense in depth for late (expired-recovery) payments: the slot may have
  // been retaken while this checkout sat unpaid. Still confirm — a paid
  // deposit is never dropped silently — but flag the conflict so the owner
  // notification asks them to reschedule one of the two bookings.
  //
  // Gated on whether this booking still holds its own slot, NOT on its status.
  // A pending_deposit row releases its slot on the clock, at
  // STALE_DEPOSIT_MINUTES, but only flips to "expired" when the daily cron
  // runs — so a status check misses every conflict in that window. While the
  // booking does still hold its slot, getOccupiedBookings would match itself.
  //
  // Overlap, not an identical start: while this checkout sat unpaid, a longer
  // job could have been booked earlier in the day and now runs across this
  // booking's hours without starting on them. That is just as much a clash for
  // the crew, and the owner needs the same warning.
  //
  // holdMinutes is passed along with the status and the clock: an admin-created
  // booking holds its slot for a day, not the hour a public checkout gets, and
  // asking without it would call a two-hour-old phone booking released — then
  // flag a conflict against a slot it is still legitimately holding.
  const slotConflict =
    !blocksSlot({
      status: booking.status,
      createdAt: booking.createdAt ?? null,
      holdMinutes: booking.holdMinutes,
    }) && (await overlapsLiveBooking(booking));

  // Claim the booking before doing anything with side effects. The status check
  // above is only a fast path — the webhook and the return-page confirmation
  // routinely arrive together, and both would pass it. This UPDATE is what
  // actually decides: it matches only while the booking is still unpaid, so
  // exactly one caller gets through to record the payment, redeem the coupon,
  // and send the confirmation emails.
  const claimed = await db.confirmUnpaidBooking(bookingId, {
    stripePaymentIntentId: paymentIntentId ?? undefined,
    slotConflict,
  });
  if (!claimed) return;

  await db.createPayment({
    bookingId,
    customerId: booking.customerId,
    amount: booking.depositAmount,
    kind: "deposit",
    method: "card",
    stripePaymentIntentId: paymentIntentId ?? undefined,
    status: "succeeded",
  });

  if (booking.couponCode) {
    const coupon = await db.getCouponByCode(booking.couponCode);
    if (coupon) await db.incrementCouponRedemptions(coupon.id);
  }

  const customer = await db.getCustomerById(booking.customerId);
  if (customer) {
    const locale = booking.locale as "en" | "es";
    const extras: string[] = JSON.parse(booking.extras ?? "[]");
    const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
    // Payment is gated on completeness (createSession refuses an unfinished
    // link, and the public flow never writes gaps), so a paid booking always
    // has these facts — the fallbacks are for the type system, not for life.
    const serviceType = booking.serviceType ?? "residential";
    // For a deposit link the owner sent by hand, the notification leads with
    // "your link was completed" and names what the CUSTOMER chose — the facts
    // the owner didn't lock at creation. He may have sent the link hours ago;
    // this is the moment he learns how the lead landed.
    let completedLink: { customerChose: string[] } | undefined;
    if (booking.kind === "admin") {
      const locked = parseAdminProvided(booking.adminProvided);
      const chose: string[] = [];
      if (!locked.has("service")) chose.push(`service: ${SERVICE_NAMES[serviceType].en}`);
      if (!locked.has("size") && booking.sqft != null) chose.push(`size: ${booking.sqft.toLocaleString()} sq ft`);
      if (!locked.has("slot")) chose.push(`time: ${booking.scheduledDate} at ${booking.scheduledTime}`);
      completedLink = { customerChose: chose };
    }
    await sendBookingEmails({
      completedLink,
      reference: booking.reference,
      serviceName: SERVICE_NAMES[serviceType][locale],
      date: booking.scheduledDate ?? "",
      time: booking.scheduledTime ?? "",
      frequencyLabel: FREQUENCY_NAMES[booking.frequency][locale],
      extras: extras.map(e => EXTRA_NAMES[e]?.[locale] ?? e),
      total: booking.totalAmount,
      deposit: booking.depositAmount,
      customerName: customer.firstName,
      customerEmail: customer.email ?? "",
      customerPhone: customer.phone ?? undefined,
      address: composeAddress(booking),
      notes: booking.notes ?? undefined,
      locale,
      bizPhone,
      slotConflict,
    });
  }
}
