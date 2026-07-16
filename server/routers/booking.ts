import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  calculateQuote,
  generateBookingReference,
  parsePricingConfig,
  PRICING_SETTING_KEY,
  type PricingConfig,
} from "@shared/pricing";
import { parseSchedule, slotsForDate, SCHEDULE_SETTING_KEY } from "@shared/schedule";
import * as db from "../db";
import { assertRateLimit, clientIp } from "../antiSpam";
import { sendBookingEmails } from "../emails";
import { lookupPropertySqft } from "../property";
import { getStripe } from "../stripe";
import { publicProcedure, router } from "../_core/trpc";

const quoteInputSchema = z.object({
  type: z.enum(["residential", "commercial", "airbnb", "moveinout", "deep", "office"]),
  bedrooms: z.number().int().min(0).max(10),
  bathrooms: z.number().int().min(1).max(10),
  sqft: z.number().min(200).max(10000),
  extras: z.array(
    z.enum(["pets", "deepClean", "moveOut", "oven", "refrigerator", "windows", "laundry", "garage", "organization"])
  ),
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

  /** Available time slots for a given date. */
  availability: publicProcedure
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .query(async ({ input }) => {
      const schedule = parseSchedule(await db.getSetting(SCHEDULE_SETTING_KEY));
      const slots = slotsForDate(input.date, schedule);
      if (slots.length === 0) return [];
      const booked = await db.getBookedSlots(input.date);
      return slots.map(slot => ({ time: slot, available: !booked.includes(slot) }));
    }),

  /** Weekly booking schedule (public) so the calendar can disable closed days. */
  schedule: publicProcedure.query(async () =>
    parseSchedule(await db.getSetting(SCHEDULE_SETTING_KEY))
  ),

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
      // Enforce the configured booking schedule server-side: reject any
      // date/time outside the admin-defined hours (e.g. Sundays when closed).
      const schedule = parseSchedule(await db.getSetting(SCHEDULE_SETTING_KEY));
      const validSlots = slotsForDate(input.date, schedule);
      if (!validSlots.includes(input.time)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.locale === "es"
              ? "El horario seleccionado no está disponible. Por favor elija otro."
              : "The selected time is not available for booking. Please choose another.",
        });
      }
      // Verify square footage against public property records (best-effort).
      // If the county record prices into a higher tier than the entered sqft,
      // charge from the verified square footage so understated entries can't
      // lower the price.
      const pricing = await loadPricingConfig();
      const property = await lookupPropertySqft(input.address, input.city, input.zip);
      let effectiveSqft = input.quote.sqft;
      let sqftMismatch = false;
      if (property.verified && property.sqft) {
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

      const bookingId = await db.createBooking({
        reference,
        customerId,
        serviceType: input.quote.type,
        frequency: input.quote.frequency,
        scheduledDate: input.date,
        scheduledTime: input.time,
        bedrooms: input.quote.bedrooms,
        bathrooms: input.quote.bathrooms,
        sqft: Math.round(effectiveSqft),
        extras: JSON.stringify(input.quote.extras),
        addressLine: input.address,
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

      // Create Stripe Checkout session for the deposit
      const stripe = getStripe();
      const origin = (ctx.req.headers.origin as string) || `${ctx.req.protocol}://${ctx.req.headers.host}`;
      const serviceName = SERVICE_NAMES[input.quote.type][input.locale];
      const bookingPath = input.locale === "es" ? "/es/reservar" : "/booking";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: input.email,
        client_reference_id: String(bookingId),
        allow_promotion_codes: false,
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

      if (booking.status === "pending_deposit") {
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
          serviceType: updated.serviceType,
          date: updated.scheduledDate,
          time: updated.scheduledTime,
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

/** Shared finalization: mark confirmed, record payment, redeem coupon, send emails. */
export async function finalizeBooking(bookingId: number, paymentIntentId: string | null): Promise<void> {
  const booking = await db.getBookingById(bookingId);
  if (!booking || booking.status !== "pending_deposit") return;

  await db.updateBooking(bookingId, {
    status: "confirmed",
    stripePaymentIntentId: paymentIntentId ?? undefined,
  });

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
    await sendBookingEmails({
      reference: booking.reference,
      serviceName: SERVICE_NAMES[booking.serviceType][locale],
      date: booking.scheduledDate,
      time: booking.scheduledTime,
      frequencyLabel: FREQUENCY_NAMES[booking.frequency][locale],
      extras: extras.map(e => EXTRA_NAMES[e]?.[locale] ?? e),
      total: booking.totalAmount,
      deposit: booking.depositAmount,
      customerName: customer.firstName,
      customerEmail: customer.email,
      customerPhone: customer.phone ?? undefined,
      address: [booking.addressLine, booking.city, booking.zip].filter(Boolean).join(", "),
      locale,
      bizPhone,
    });
  }
}
