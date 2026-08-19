/**
 * The customer's side of the tip ask: /pay/tip/:token
 *
 * The page opens with the 15% preset pre-selected — one tap pays it — with
 * the other presets, a custom amount, and a clearly offered "no tip, just say
 * thanks" one tap away. Nothing is ever charged without the customer's
 * explicit pay tap, and declining simply marks the question answered so the
 * page never nags on a revisit.
 *
 * The client sends a preset id or a custom figure, never a free amount the
 * server trusts: every dollar is recomputed here (presets from the stored job
 * total, custom input clamped to $1–100% of it) and the Stripe session is
 * minted for that figure.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { assertRateLimit, clientIp } from "../antiSpam";
import { publicOrigin } from "../publicOrigin";
import {
  clampTipAmount,
  createTipCheckoutSession,
  tipPageState,
  tipPresets,
  TIP_PRESET_PERCENTS,
} from "../tip";
import { publicProcedure, router } from "../_core/trpc";
import { SERVICE_NAMES } from "./booking";

type TipLocale = "en" | "es";

/** Bilingual copy for the closed states, rendered by the page as a notice. */
const NOTICES = {
  paid: {
    en: {
      title: "Thank you so much!",
      body: "Your tip went straight to your crew — they'll be thrilled. It was a pleasure cleaning for you!",
    },
    es: {
      title: "¡Muchísimas gracias!",
      body: "Su propina va directo a su equipo — les dará mucho gusto. ¡Fue un placer limpiar para usted!",
    },
  },
  declined: {
    en: {
      title: "Thanks for letting us know!",
      body: "No tip needed — your kind words and your trust mean the world. We hope to clean for you again soon!",
    },
    es: {
      title: "¡Gracias por avisarnos!",
      body: "No hace falta ninguna propina — su confianza lo es todo para nosotros. ¡Esperamos limpiar para usted pronto!",
    },
  },
  notFound: {
    en: {
      title: "We couldn't find this tip link",
      body: "The link may be incomplete or out of date. No action is needed — and thank you again for choosing us!",
    },
    es: {
      title: "No encontramos este enlace",
      body: "Es posible que el enlace esté incompleto o desactualizado. No necesita hacer nada — ¡y gracias de nuevo por elegirnos!",
    },
  },
} as const;

/**
 * Loads the booking behind a tip token, or null for anything that must not
 * take a tip: an unknown token, or a booking that has been cancelled since.
 */
async function tipBooking(token: string) {
  const booking = await db.getBookingByTipToken(token);
  if (!booking || booking.status === "cancelled") return null;
  return booking;
}

export const tipRouter = router({
  /** Everything the page renders: state, presets (server-computed), summary. */
  get: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input, ctx }) => {
      assertRateLimit("tipGet", clientIp(ctx), 30, 60_000);
      const booking = await tipBooking(input.token);
      if (!booking) {
        return { state: "notFound" as const, locale: "en" as const, notice: NOTICES.notFound, booking: null };
      }
      const locale = (booking.locale as TipLocale) ?? "en";
      const state = tipPageState(booking);
      if (state !== "open") {
        return { state, locale, notice: NOTICES[state], booking: null };
      }
      const customer = await db.getCustomerById(booking.customerId);
      return {
        state,
        locale,
        notice: null,
        booking: {
          reference: booking.reference,
          customerFirstName: customer?.firstName ?? "",
          serviceName: SERVICE_NAMES[booking.serviceType ?? "residential"][locale],
          date: booking.scheduledDate,
          /** Presets in whole dollars, computed here — the page only displays them. */
          total: booking.totalAmount,
          presets: tipPresets(booking.totalAmount),
        },
      };
    }),

  /**
   * Mints the Stripe session for a chosen preset or a custom amount. The
   * charge happens on Stripe's page after the customer's explicit pay tap —
   * this never moves money by itself.
   */
  createSession: publicProcedure
    .input(
      z
        .object({
          token: z.string().min(1).max(128),
          /** One of the offered percentages — anything else is refused, not priced. */
          preset: z
            .union([z.literal(TIP_PRESET_PERCENTS[0]), z.literal(TIP_PRESET_PERCENTS[1]), z.literal(TIP_PRESET_PERCENTS[2])])
            .optional(),
          /** Whole dollars; clamped server-side to $1–100% of the job total. */
          customAmount: z.number().finite().positive().optional(),
        })
        .refine(v => (v.preset != null) !== (v.customAmount != null), {
          message: "Choose a preset or a custom amount",
        })
    )
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("tipPay", clientIp(ctx), 10, 60_000);
      const booking = await tipBooking(input.token);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Tip link not found" });
      const locale = (booking.locale as TipLocale) ?? "en";
      if (tipPageState(booking) !== "open") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            locale === "es"
              ? "Esta propina ya quedó resuelta — ¡gracias de nuevo!"
              : "This tip has already been taken care of — thank you again!",
        });
      }
      const presets = tipPresets(booking.totalAmount);
      const amount =
        input.preset != null
          ? (presets.find(p => p.percent === input.preset)?.amount ?? clampTipAmount(1, booking.totalAmount))
          : clampTipAmount(input.customAmount!, booking.totalAmount);

      const customer = await db.getCustomerById(booking.customerId);
      const session = await createTipCheckoutSession({
        booking,
        amount,
        customerEmail: customer?.email ?? null,
        origin: publicOrigin(ctx.req),
      });
      return { checkoutUrl: session.url, amount };
    }),

  /**
   * "No tip — just say thanks." Consumes the ask so the page stops asking;
   * calling it twice, or after a tip was paid, is a graceful no-op.
   */
  decline: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .mutation(async ({ input, ctx }) => {
      assertRateLimit("tipPay", clientIp(ctx), 10, 60_000);
      const booking = await tipBooking(input.token);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Tip link not found" });
      await db.declineTip(booking.id);
      return { declined: true as const };
    }),
});
