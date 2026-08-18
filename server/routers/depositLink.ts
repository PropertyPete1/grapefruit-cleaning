/**
 * The customer's side of an admin-created booking: /pay/deposit/:token
 *
 * The owner took the lead by phone, entered the basics, and sent this link.
 * Here the customer picks their own extras, watches the total and the deposit
 * move, and pays. Two procedures, both public — the token is the only
 * credential, exactly like the balance link and the staff invites.
 *
 * The security property that matters: THE CLIENT NEVER SENDS AN AMOUNT. It
 * sends a list of extra IDs. Everything — base price, extras, coupon, deposit —
 * is recomputed here from the live pricing config, and the Stripe session is
 * minted for that figure. A tampered payload can change which extras the
 * customer is buying; it cannot change what they cost.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { durationHoursFor } from "@shared/duration";
import { fitsBeforeClose } from "@shared/availability";
import { depositFor, EXTRA_IDS } from "@shared/pricing";
import * as db from "../db";
import { applyCoupon, computeBasePrice, usableCoupon } from "../adminBooking";
import { assertRateLimit, clientIp } from "../antiSpam";
import { depositLinkStatus, depositSessionSeconds } from "../depositLinkRules";
import { publicOrigin } from "../publicOrigin";
import { getStripe } from "../stripe";
import { publicProcedure, router } from "../_core/trpc";
import {
  loadPricingConfig,
  loadSchedulingRules,
  SERVICE_NAMES,
} from "./booking";

const extrasInput = z.array(z.enum(EXTRA_IDS)).max(EXTRA_IDS.length);

/** Bilingual copy for the states the page can be in besides "pay now". */
const NOTICES = {
  paid: {
    en: {
      title: "This deposit is already paid",
      body: "You're all set — your appointment is confirmed and a confirmation email is in your inbox. See you then!",
    },
    es: {
      title: "Este depósito ya está pagado",
      body: "¡Todo listo! Su cita está confirmada y le enviamos un correo de confirmación. ¡Nos vemos!",
    },
  },
  expired: {
    en: {
      title: "This booking link has expired",
      body: "No problem at all — give us a call or reply to your text and we'll check whether your time is still open and send a fresh link.",
    },
    es: {
      title: "Este enlace de reserva ha expirado",
      body: "No hay ningún problema — llámenos o responda a su mensaje y verificamos si su horario sigue disponible para enviarle un enlace nuevo.",
    },
  },
  notFound: {
    en: {
      title: "We couldn't find this booking link",
      body: "The link may be incomplete or may have been replaced by a newer one. Please check your most recent message from us, or give us a call.",
    },
    es: {
      title: "No encontramos este enlace de reserva",
      body: "Es posible que el enlace esté incompleto o haya sido reemplazado por uno más reciente. Revise el mensaje más reciente que le enviamos o llámenos.",
    },
  },
} as const;

/**
 * Recomputes the money for a booking with a given set of extras.
 *
 * One function for both the preview the page reads and the figure the Stripe
 * session is minted for, so what the customer is shown and what they are
 * charged cannot come apart.
 */
async function priceWithExtras(
  booking: {
    serviceType: string;
    frequency: string;
    bedrooms: number;
    bathrooms: number;
    sqft: number;
    couponCode: string | null;
  },
  extras: readonly string[]
) {
  const pricing = await loadPricingConfig();
  const breakdown = computeBasePrice(
    {
      serviceType: booking.serviceType as never,
      frequency: booking.frequency as never,
      bedrooms: booking.bedrooms,
      bathrooms: booking.bathrooms,
    },
    booking.sqft,
    pricing,
    extras as never
  );
  const coupon = await applyCoupon(breakdown.total, booking.couponCode);
  const deposit = depositFor(coupon.total, pricing.depositRate);
  return {
    pricing,
    breakdown,
    total: coupon.total,
    discountApplied: coupon.discountApplied,
    deposit,
  };
}

export const depositLinkRouter = router({
  /**
   * Everything the pay page renders: the locked essentials the owner agreed on
   * the phone, and the extras catalog the customer may still choose from.
   *
   * Returns a status rather than throwing for a dead link, so the page can show
   * a warm bilingual notice instead of an error boundary.
   */
  get: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input, ctx }) => {
      // The token is secret, but a guessing loop should still cost something.
      assertRateLimit("depositLinkGet", clientIp(ctx), 30, 60_000);
      const booking = await db.getBookingByPayToken(input.token);
      if (!booking || booking.kind !== "admin") {
        return {
          state: "notFound" as const,
          locale: "en" as const,
          notice: NOTICES.notFound,
          booking: null,
        };
      }
      const locale = (booking.locale as "en" | "es") ?? "en";
      const status = depositLinkStatus(booking);
      if (status !== "awaiting_payment") {
        const kind =
          status === "paid" ? ("paid" as const) : ("expired" as const);
        return { state: kind, locale, notice: NOTICES[kind], booking: null };
      }

      const selectedExtras: string[] = JSON.parse(booking.extras ?? "[]");
      const money = await priceWithExtras(booking, selectedExtras);
      const customer = await db.getCustomerById(booking.customerId);
      // Only the discount terms, and only when the coupon is one the server
      // would actually honour — an expired or exhausted code must not show the
      // customer a discount that vanishes at checkout.
      const coupon = await usableCoupon(booking.couponCode);

      // One consistent envelope for every state, with the payload nullable.
      // A discriminated union would be tidier to write here, but it does not
      // survive the tRPC client's type transformation intact — the page ends up
      // unable to narrow it, and every field reads as possibly undefined.
      return {
        state: "awaiting_payment" as const,
        locale,
        notice: null,
        booking: {
          reference: booking.reference,
          serviceType: booking.serviceType,
          serviceName:
            SERVICE_NAMES[booking.serviceType]?.[locale] ?? booking.serviceType,
          date: booking.scheduledDate,
          time: booking.scheduledTime,
          address: [booking.addressLine, booking.city, booking.zip]
            .filter(Boolean)
            .join(", "),
          customerFirstName: customer?.firstName ?? "",
          selectedExtras,
          /**
           * The live config and the quote inputs, so the page can price a tapped
           * extra instantly rather than waiting on a round trip. It is a preview
           * running the same shared calculateQuote and applyCouponToTotal the
           * server runs; the server recomputes from scratch when the session is
           * minted, and that figure is the one that gets charged.
           */
          pricing: money.pricing,
          quote: {
            type: booking.serviceType,
            bedrooms: booking.bedrooms,
            bathrooms: booking.bathrooms,
            sqft: booking.sqft,
            frequency: booking.frequency,
          },
          coupon: coupon
            ? { percentOff: coupon.percentOff, amountOff: coupon.amountOff }
            : null,
          basePrice: money.breakdown.base,
          total: money.total,
          deposit: money.deposit,
          expiresAt: booking.payTokenExpiresAt,
        },
      };
    }),

  /**
   * Recomputes the total from the chosen extras and mints a Stripe session for
   * exactly that deposit.
   *
   * A fresh session every time: the customer may change their mind about extras
   * and come back, and an old session would charge the old amount. The booking
   * row is updated first so the amount Stripe is asked for and the amount the
   * booking records are written from the same computation.
   */
  createSession: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128), extras: extrasInput }))
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("depositLinkPay", clientIp(ctx), 10, 60_000);
      const booking = await db.getBookingByPayToken(input.token);
      if (!booking || booking.kind !== "admin") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Booking link not found",
        });
      }
      const locale = (booking.locale as "en" | "es") ?? "en";
      const status = depositLinkStatus(booking);
      if (status !== "awaiting_payment") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            status === "paid"
              ? locale === "es"
                ? "Este depósito ya está pagado."
                : "This deposit has already been paid."
              : locale === "es"
                ? "Este enlace de reserva ha expirado. Llámenos y le enviamos uno nuevo."
                : "This booking link has expired. Give us a call and we'll send a fresh one.",
        });
      }

      // Extras could in principle push a job into a longer duration band, the
      // same way verified square footage does in booking.create. They do not
      // today — durationHoursFor reads service type and size only, and the
      // ladder config has no extras dimension — so this recompute is a no-op
      // for extras and exists for the case that does move: the owner editing
      // the duration ladder between the phone call and the payment. If extras
      // ever gain a duration effect, they enter durationHoursFor and this line
      // starts doing the work with no further change here.
      const { schedule, durations } = await loadSchedulingRules();
      const estimatedHours = durationHoursFor(
        booking.serviceType,
        booking.sqft,
        durations
      );
      if (
        !fitsBeforeClose(
          booking.scheduledTime,
          estimatedHours,
          booking.scheduledDate,
          schedule
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            locale === "es"
              ? "Su servicio ahora toma más tiempo del que queda ese día. Llámenos y con gusto le buscamos otro horario."
              : "Your service now takes longer than the time left that day. Give us a call and we'll find you another time.",
        });
      }

      const money = await priceWithExtras(booking, input.extras);

      await db.updateBooking(booking.id, {
        extras: JSON.stringify(input.extras),
        totalAmount: money.total,
        depositAmount: money.deposit,
        discountApplied: money.discountApplied,
        estimatedHours,
      });

      const stripe = getStripe();
      const origin = publicOrigin(ctx.req);
      const serviceName =
        SERVICE_NAMES[booking.serviceType]?.[locale] ?? booking.serviceType;
      const bookingPath = locale === "es" ? "/es/reservar" : "/en/book";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email:
          (await db.getCustomerById(booking.customerId))?.email ?? undefined,
        client_reference_id: String(booking.id),
        allow_promotion_codes: false,
        // Capped at the remaining hold, so a session can never outlive the slot
        // it is paying for.
        expires_at:
          Math.floor(Date.now() / 1000) +
          depositSessionSeconds(booking.payTokenExpiresAt),
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: money.deposit * 100,
              product_data: {
                name:
                  locale === "es"
                    ? `Depósito de reserva — ${serviceName}`
                    : `Booking deposit — ${serviceName}`,
                description:
                  locale === "es"
                    ? `Reserva ${booking.reference} · ${booking.scheduledDate} a las ${booking.scheduledTime} · Total estimado $${money.total}`
                    : `Booking ${booking.reference} · ${booking.scheduledDate} at ${booking.scheduledTime} · Estimated total $${money.total}`,
              },
            },
            quantity: 1,
          },
        ],
        // The same metadata a self-serve deposit carries, so the webhook and
        // the return-page confirmation finalize this booking through the
        // identical path — confirmation email and all.
        metadata: {
          booking_id: String(booking.id),
          booking_reference: booking.reference,
          locale,
        },
        success_url: `${origin}${bookingPath}?session_id={CHECKOUT_SESSION_ID}&ref=${booking.reference}`,
        cancel_url: `${origin}/pay/deposit/${input.token}?cancelled=1`,
      });

      await db.updateBooking(booking.id, { stripeSessionId: session.id });

      return {
        checkoutUrl: session.url,
        total: money.total,
        deposit: money.deposit,
      };
    }),
});
