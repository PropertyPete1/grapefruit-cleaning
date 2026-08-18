/**
 * The customer's side of an admin-created booking: /pay/deposit/:token
 *
 * The owner entered whatever he knew — maybe the whole job, maybe just a name
 * and a number — and sent this link. The page shows what he locked as settled
 * facts and asks ONLY for what is missing: service, then size, then time.
 * Extras and access notes are always the customer's. Then they pay.
 *
 * The security properties, unchanged from the first version and now enforced
 * per step:
 *
 *   - THE CLIENT NEVER SENDS AN AMOUNT. It sends selections — a service id, a
 *     square footage, a slot, extra ids. Every dollar figure is recomputed
 *     here from the live pricing config on every write and again at payment,
 *     and the Stripe session is minted for that figure.
 *
 *   - Inventory is honest. Picking a time claims the slot server-side under
 *     every scheduling rule and the same unique index as the public flow, the
 *     moment it happens. Until then the booking holds nothing.
 *
 *   - What the owner locked, the link cannot change. Provenance travels in
 *     the row (adminProvided), so a crafted request editing a locked fact is
 *     refused no matter what the page shows.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { durationHoursFor } from "@shared/duration";
import { fitsBeforeClose, isSlotBookable, overlapsAny } from "@shared/availability";
import { ADMIN_HOLD_SETTING_KEY, adminHoldMinutes } from "@shared/holdWindow";
import { CLEANING_TYPES, depositFor, EXTRA_IDS } from "@shared/pricing";
import * as db from "../db";
import { applyCoupon, computeBasePrice, resolveEffectiveSqft, usableCoupon } from "../adminBooking";
import { assertRateLimit, clientIp } from "../antiSpam";
import {
  bookingNeeds,
  depositLinkStatus,
  depositSessionSeconds,
  isBookingComplete,
  parseAdminProvided,
} from "../depositLinkRules";
import { customerNotesOf, mergeCustomerNotes } from "../notesMerge";
import { lookupPropertySqft } from "../property";
import { publicOrigin } from "../publicOrigin";
import { getStripe } from "../stripe";
import { publicProcedure, router } from "../_core/trpc";
import { loadPricingConfig, loadSchedulingRules, occupiedIntervals, SERVICE_NAMES } from "./booking";

const extrasInput = z.array(z.enum(EXTRA_IDS)).max(EXTRA_IDS.length);

/** Bilingual copy for the states the page can be in besides working the steps. */
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
      body: "No problem at all — give us a call or reply to your text and we'll send you a fresh link right away.",
    },
    es: {
      title: "Este enlace de reserva ha expirado",
      body: "No hay ningún problema — llámenos o responda a su mensaje y le enviamos un enlace nuevo de inmediato.",
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

type LinkLocale = "en" | "es";

const localized = (locale: LinkLocale, en: string, es: string) => (locale === "es" ? es : en);

/** BAD_REQUEST in the customer's own language. */
const refuse = (locale: LinkLocale, en: string, es: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message: localized(locale, en, es) });
};

/**
 * Loads a link's booking and refuses anything that is not an open, admin-kind
 * link. Every mutation goes through here, so a paid, expired, or foreign row
 * is rejected identically no matter which step the request claims to be on.
 */
async function openLinkBooking(token: string) {
  const booking = await db.getBookingByPayToken(token);
  if (!booking || booking.kind !== "admin") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Booking link not found" });
  }
  const locale = (booking.locale as LinkLocale) ?? "en";
  const status = depositLinkStatus(booking);
  if (status === "paid" || (status !== "incomplete" && status !== "awaiting_payment")) {
    refuse(
      locale,
      status === "paid"
        ? "This deposit has already been paid."
        : "This booking link has expired. Give us a call and we'll send a fresh one.",
      status === "paid"
        ? "Este depósito ya está pagado."
        : "Este enlace de reserva ha expirado. Llámenos y le enviamos uno nuevo."
    );
  }
  return { booking, locale };
}

/**
 * Recomputes the money for a booking with a given set of extras.
 *
 * One function for the stored totals, the page preview and the Stripe figure,
 * so what the customer watches update is what they are charged. Null while a
 * pricing fact is still missing.
 */
async function priceWithExtras(
  booking: {
    serviceType: string | null;
    frequency: string;
    bedrooms: number;
    bathrooms: number;
    sqft: number | null;
    couponCode: string | null;
  },
  extras: readonly string[]
) {
  const pricing = await loadPricingConfig();
  if (booking.serviceType == null || booking.sqft == null) {
    return { pricing, breakdown: null, total: null, discountApplied: 0, deposit: null };
  }
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
  return {
    pricing,
    breakdown,
    total: coupon.total,
    discountApplied: coupon.discountApplied,
    deposit: depositFor(coupon.total, pricing.depositRate),
  };
}

/** Persists freshly computed totals so the row never shows stale money. */
async function storeTotals(
  bookingId: number,
  money: { total: number | null; deposit: number | null; discountApplied: number }
) {
  if (money.total == null || money.deposit == null) return;
  await db.updateBooking(bookingId, {
    totalAmount: money.total,
    depositAmount: money.deposit,
    discountApplied: money.discountApplied,
  });
}

export const depositLinkRouter = router({
  /**
   * Everything the page renders: the facts the owner locked, the questions
   * still open, the customer's own prior answers, and the live pricing config
   * for instant previews.
   *
   * Returns a notice state rather than throwing for a dead link, so the page
   * can show a warm bilingual notice instead of an error boundary. The
   * envelope keys are constant across states — the payload is the
   * discriminant — because a discriminated union does not survive the tRPC
   * client's type transformation intact.
   *
   * Deliberately absent: the notes column. The admin part of it may say
   * things the customer must never see; only their own section comes back.
   */
  get: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input, ctx }) => {
      // The token is secret, but a guessing loop should still cost something.
      assertRateLimit("depositLinkGet", clientIp(ctx), 30, 60_000);
      const booking = await db.getBookingByPayToken(input.token);
      if (!booking || booking.kind !== "admin") {
        return { state: "notFound" as const, locale: "en" as const, notice: NOTICES.notFound, booking: null };
      }
      const locale = (booking.locale as LinkLocale) ?? "en";
      const status = depositLinkStatus(booking);
      if (status !== "awaiting_payment" && status !== "incomplete") {
        const kind = status === "paid" ? ("paid" as const) : ("expired" as const);
        return { state: kind, locale, notice: NOTICES[kind], booking: null };
      }

      const selectedExtras: string[] = JSON.parse(booking.extras ?? "[]");
      const money = await priceWithExtras(booking, selectedExtras);
      const customer = await db.getCustomerById(booking.customerId);
      // Only the discount terms, and only when the coupon is one the server
      // would actually honour — an expired or exhausted code must not show
      // the customer a discount that vanishes at checkout.
      const coupon = await usableCoupon(booking.couponCode);
      const locks = parseAdminProvided(booking.adminProvided);

      return {
        state: status,
        locale,
        notice: null,
        booking: {
          reference: booking.reference,
          customerFirstName: customer?.firstName ?? "",
          /** What still has to be answered before the deposit can be taken. */
          needs: bookingNeeds(booking),
          /** Which facts the owner locked — the page renders these as settled. */
          locks: {
            service: locks.has("service"),
            size: locks.has("size"),
            address: locks.has("address"),
            slot: locks.has("slot"),
          },
          serviceType: booking.serviceType,
          serviceName: booking.serviceType
            ? (SERVICE_NAMES[booking.serviceType]?.[locale] ?? booking.serviceType)
            : null,
          date: booking.scheduledDate,
          time: booking.scheduledTime,
          address: [booking.addressLine, booking.city, booking.zip].filter(Boolean).join(", ") || null,
          sqft: booking.sqft,
          sqftVerified: booking.verifiedSqft != null,
          selectedExtras,
          /** Their own prior note, never the owner's. */
          customerNote: customerNotesOf(booking.notes),
          /**
           * The live config and the quote inputs, so the page can price a
           * tapped extra instantly. It is a preview running the same shared
           * calculateQuote and applyCouponToTotal the server runs; the server
           * recomputes from scratch at every write and at payment, and that
           * figure is the one that gets charged.
           */
          pricing: money.pricing,
          quote: {
            type: booking.serviceType,
            bedrooms: booking.bedrooms,
            bathrooms: booking.bathrooms,
            sqft: booking.sqft,
            frequency: booking.frequency,
          },
          coupon: coupon ? { percentOff: coupon.percentOff, amountOff: coupon.amountOff } : null,
          basePrice: money.breakdown?.base ?? null,
          total: money.total,
          deposit: money.deposit,
          expiresAt: booking.payTokenExpiresAt,
        },
      };
    }),

  /**
   * The customer answers the service and size questions — and may revise
   * their own answers until they pay. Facts the owner locked are refused
   * regardless of what the request claims.
   *
   * When an address arrives, county verification runs right here, the same
   * lookup the public flow uses: a verified figure settles the size question
   * (against an understated slider value, the higher-pricing figure wins),
   * an unverified one leaves the slider open.
   */
  updateDetails: publicProcedure
    .input(
      z.object({
        token: z.string().min(1).max(128),
        serviceType: z.enum(CLEANING_TYPES).optional(),
        sqft: z.number().min(200).max(10000).optional(),
        address: z.string().min(3).max(255).optional(),
        city: z.string().max(120).optional(),
        zip: z.string().max(20).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("depositLinkEdit", clientIp(ctx), 30, 60_000);
      const { booking, locale } = await openLinkBooking(input.token);
      const locks = parseAdminProvided(booking.adminProvided);

      if (input.serviceType && locks.has("service")) {
        refuse(locale, "The service was set when your booking was created — give us a call to change it.", "El servicio se definió al crear su reserva — llámenos para cambiarlo.");
      }
      if (input.sqft !== undefined && locks.has("size")) {
        refuse(locale, "The home size was set when your booking was created — give us a call to change it.", "El tamaño se definió al crear su reserva — llámenos para cambiarlo.");
      }
      if (input.address && locks.has("address")) {
        refuse(locale, "The address was set when your booking was created — give us a call to change it.", "La dirección se definió al crear su reserva — llámenos para cambiarla.");
      }

      const patch: Parameters<typeof db.updateBooking>[1] = {};
      const serviceType = input.serviceType ?? booking.serviceType;
      if (input.serviceType) patch.serviceType = input.serviceType;

      let sqft = booking.sqft;
      let verified = booking.verifiedSqft;
      let sizeVerified = false;
      if (input.address) {
        const property = await lookupPropertySqft(input.address, input.city, input.zip);
        patch.addressLine = input.address;
        patch.city = input.city;
        patch.zip = input.zip;
        if (property.verified && property.sqft) {
          verified = property.sqft;
          sizeVerified = true;
          patch.verifiedSqft = property.sqft;
          patch.sqftSource = property.source;
        } else if (property.addressVerified) {
          patch.sqftSource = property.source;
        }
      }
      if (input.sqft !== undefined || sizeVerified) {
        if (serviceType) {
          const pricing = await loadPricingConfig();
          const resolved = resolveEffectiveSqft({
            enteredSqft: input.sqft ?? booking.sqft,
            verifiedSqft: verified ?? null,
            serviceType: serviceType as never,
            frequency: booking.frequency as never,
            pricing,
          });
          sqft = resolved.sqft;
          patch.sqftMismatch = resolved.corrected;
        } else {
          // No service yet, so no prices to compare: the verified figure wins
          // outright when there is one, the slider otherwise.
          sqft = verified ?? input.sqft ?? booking.sqft;
        }
        patch.sqft = sqft != null ? Math.round(sqft) : null;
      }

      // Duration ripple: a bigger home or a heavier service stretches the job,
      // and a slot chosen for the old span may no longer fit — against closing
      // time, or against the neighbours the longer span now reaches into.
      let slotCleared = false;
      if (serviceType && sqft != null) {
        const { schedule, durations } = await loadSchedulingRules();
        const estimatedHours = durationHoursFor(serviceType, sqft, durations);
        patch.estimatedHours = estimatedHours;
        if (booking.scheduledDate && booking.scheduledTime) {
          const others = (await db.getOccupiedBookings(booking.scheduledDate)).filter(
            row => row.id !== booking.id
          );
          const stillFits =
            fitsBeforeClose(booking.scheduledTime, estimatedHours, booking.scheduledDate, schedule) &&
            !overlapsAny(
              { time: booking.scheduledTime, hours: estimatedHours },
              occupiedIntervals(others, durations)
            );
          if (!stillFits && locks.has("slot")) {
            // The owner picked this time; the page cannot move it. Refuse the
            // edit rather than leave a job that cannot fit its own slot.
            refuse(
              locale,
              "That change makes the job too long for your booked time. Give us a call and we'll sort it out.",
              "Ese cambio hace el trabajo demasiado largo para su horario reservado. Llámenos y lo resolvemos."
            );
          }
          if (!stillFits) {
            // The customer picked it, so the customer can pick again: release
            // the slot and re-ask the time question with the new duration.
            patch.scheduledDate = null;
            patch.scheduledTime = null;
            slotCleared = true;
          }
        }
      }

      // A call that changed nothing (possible through the API, not the page)
      // has nothing to write and nothing to reprice — and Drizzle would refuse
      // the empty SET anyway.
      if (Object.keys(patch).length === 0) {
        return { ok: true as const, sizeVerified, slotCleared };
      }
      await db.updateBooking(booking.id, patch);

      // Fresh money onto the row the moment it becomes (or stays) priceable.
      const updated = await db.getBookingById(booking.id);
      const money = await priceWithExtras(updated, JSON.parse(updated.extras ?? "[]"));
      await storeTotals(booking.id, money);

      return { ok: true as const, sizeVerified, slotCleared };
    }),

  /**
   * The customer picks their time — the moment inventory changes hands.
   *
   * Every scheduling rule applies exactly as it does to the public calendar:
   * open hours, the lunch break, the minimum notice (no override here — that
   * is the owner's pen, not the customer's), other bookings' full spans, and
   * finishing before close. The unique index remains the last-line guard, and
   * losing the race reads as the ordinary "someone took it" message.
   *
   * Claiming starts the hold clock NOW, not at link creation: the link may
   * have been sent this morning, and releasing tonight's claim at lunchtime
   * because the token was minted at nine would punish the customer for the
   * owner's head start. The link window extends to match — one promise, one
   * clock, both ending a full hold-window after the claim.
   */
  claimSlot: publicProcedure
    .input(
      z.object({
        token: z.string().min(1).max(128),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("depositLinkEdit", clientIp(ctx), 30, 60_000);
      const { booking, locale } = await openLinkBooking(input.token);
      const locks = parseAdminProvided(booking.adminProvided);
      if (locks.has("slot")) {
        refuse(locale, "Your time was set when your booking was created — give us a call to change it.", "Su horario se definió al crear su reserva — llámenos para cambiarlo.");
      }
      if (booking.serviceType == null || booking.sqft == null) {
        // Order is enforced here, not just drawn on the page: duration — and
        // with it every span rule — is unknowable without service and size.
        refuse(locale, "Choose your service and home size first, then pick a time.", "Elija primero su servicio y el tamaño de su hogar, y luego su horario.");
      }

      const slotTaken = () =>
        new TRPCError({
          code: "BAD_REQUEST",
          message: localized(
            locale,
            "The selected time is not available for booking. Please choose another.",
            "El horario seleccionado no está disponible. Por favor elija otro."
          ),
        });

      const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
      const estimatedHours = durationHoursFor(booking.serviceType, booking.sqft, durations);

      // Hand back any stale hold on this slot, then check under the same
      // composed rules as everywhere else — excluding this booking's own row,
      // which may still hold the previous time it is moving away from.
      await db.expireStaleBookingsForSlot(input.date, input.time);
      const rows = (await db.getOccupiedBookings(input.date)).filter(row => row.id !== booking.id);
      const bookable = isSlotBookable(
        {
          date: input.date,
          schedule,
          lunchBreak,
          leadTimeHours,
          occupied: occupiedIntervals(rows, durations),
          jobHours: estimatedHours,
        },
        input.time
      );
      if (!bookable) throw slotTaken();

      const now = new Date();
      const window = adminHoldMinutes(await db.getSetting(ADMIN_HOLD_SETTING_KEY));
      const createdAt = booking.createdAt ? new Date(booking.createdAt).getTime() : now.getTime();
      // blocksSlot measures from createdAt, which no claim can change — so the
      // hold is restated as "window minutes from now" in createdAt's terms.
      const holdMinutes = Math.ceil((now.getTime() - createdAt) / 60_000) + window;
      const linkEnd = new Date(now.getTime() + window * 60_000);
      const currentEnd = booking.payTokenExpiresAt ? new Date(booking.payTokenExpiresAt) : null;

      try {
        await db.updateBooking(booking.id, {
          scheduledDate: input.date,
          scheduledTime: input.time,
          estimatedHours,
          holdMinutes,
          payTokenExpiresAt: currentEnd && currentEnd > linkEnd ? currentEnd : linkEnd,
        });
      } catch (error) {
        // Someone else took it between the check and the write — the race the
        // unique index exists to stop.
        if (db.isSlotTakenError(error)) throw slotTaken();
        throw error;
      }

      return { claimed: true as const, date: input.date, time: input.time };
    }),

  /**
   * Recomputes the total from the chosen extras and mints a Stripe session
   * for exactly that deposit — refusing outright while any step is missing.
   *
   * A fresh session every time: the customer may change their mind about
   * extras and come back, and an old session would charge the old amount.
   * Their access notes are merged under the labeled marker here too, so the
   * owner's own notes survive verbatim.
   */
  createSession: publicProcedure
    .input(
      z.object({
        token: z.string().min(1).max(128),
        extras: extrasInput,
        notes: z.string().max(1000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("depositLinkPay", clientIp(ctx), 10, 60_000);
      const { booking, locale } = await openLinkBooking(input.token);
      if (!isBookingComplete(booking)) {
        refuse(
          locale,
          "A few details are still missing — finish the steps above and the pay button will unlock.",
          "Aún faltan algunos detalles — complete los pasos anteriores y el botón de pago se activará."
        );
      }

      // The duration recompute guards the case that moves between the claim
      // and the payment: the owner editing the duration ladder. Extras do not
      // feed the ladder today; if they ever do, they enter durationHoursFor
      // and this line starts doing that work with no further change here.
      const { schedule, durations } = await loadSchedulingRules();
      const estimatedHours = durationHoursFor(booking.serviceType, booking.sqft, durations);
      if (!fitsBeforeClose(booking.scheduledTime!, estimatedHours, booking.scheduledDate!, schedule)) {
        refuse(
          locale,
          "Your service now takes longer than the time left that day. Give us a call and we'll find you another time.",
          "Su servicio ahora toma más tiempo del que queda ese día. Llámenos y con gusto le buscamos otro horario."
        );
      }

      const money = await priceWithExtras(booking, input.extras);
      if (money.total == null || money.deposit == null) {
        // Unreachable behind isBookingComplete, but the types cannot see that.
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Pricing failed" });
      }

      await db.updateBooking(booking.id, {
        extras: JSON.stringify(input.extras),
        totalAmount: money.total,
        depositAmount: money.deposit,
        discountApplied: money.discountApplied,
        estimatedHours,
        ...(input.notes !== undefined ? { notes: mergeCustomerNotes(booking.notes, input.notes) } : {}),
      });

      const stripe = getStripe();
      const origin = publicOrigin(ctx.req);
      const serviceName = SERVICE_NAMES[booking.serviceType!]?.[locale] ?? booking.serviceType!;
      const bookingPath = locale === "es" ? "/es/reservar" : "/en/book";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: (await db.getCustomerById(booking.customerId))?.email ?? undefined,
        client_reference_id: String(booking.id),
        allow_promotion_codes: false,
        // Capped at the remaining hold, so a session can never outlive the
        // slot it is paying for.
        expires_at:
          Math.floor(Date.now() / 1000) + depositSessionSeconds(booking.payTokenExpiresAt),
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

      return { checkoutUrl: session.url, total: money.total, deposit: money.deposit };
    }),
});
