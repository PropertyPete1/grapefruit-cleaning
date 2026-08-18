/**
 * /pay/deposit/:token — the customer's half of a booking taken by phone.
 *
 * The owner entered the basics and sent this link. What is locked here is what
 * the two of them agreed on the phone: the service, the time, the address, the
 * base price. What is open is the extras — the customer picks their own, sees
 * the total and the deposit move as they tap, and pays.
 *
 * The page previews prices with the same shared calculateQuote the quote form
 * uses, so tapping an extra is instant. It never sends an amount: "Pay deposit"
 * posts the chosen extra IDs, and the server recomputes and mints the session.
 *
 * Standalone, outside the locale-routed part of the site: the link arrives by
 * text or email with no locale in it, and the language is the one stored on the
 * booking — the one the owner took the call in.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { Check, Clock, Loader2, MapPin, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  applyCouponToTotal,
  calculateQuote,
  depositFor,
  EXTRA_IDS,
  type ExtraId,
} from "@shared/pricing";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/translations/en";
import { es } from "@/i18n/translations/es";

const COPY = {
  en: {
    eyebrow: "Your booking is ready",
    heading: "Confirm with your deposit",
    lede: "Everything below is set up from your call. Add any extras you'd like — your total updates as you go.",
    yourBooking: "Your booking",
    service: "Service",
    when: "Date & time",
    where: "Address",
    reference: "Reference",
    extrasTitle: "Add any extras",
    extrasLede: "Optional — tap any you'd like. Prices update instantly.",
    basePrice: "Base price",
    extrasTotal: "Extras",
    estimatedTotal: "Estimated total",
    depositDue: "Deposit due today",
    payButton: "Pay deposit & confirm",
    processing: "Processing…",
    depositNote:
      "Your deposit secures your slot and comes off your final total. The rest is due after your cleaning.",
    heldUntil: (date: string) => `We're holding your time through ${date}.`,
    loadFailed: "We couldn't load your booking. Please refresh, or give us a call.",
    payFailed: "We couldn't open the payment page. Please try again, or give us a call.",
    cancelled: "No payment was taken. Your time is still held — pay whenever you're ready.",
  },
  es: {
    eyebrow: "Su reserva está lista",
    heading: "Confirme con su depósito",
    lede: "Todo lo siguiente viene de su llamada. Agregue los extras que desee — su total se actualiza al instante.",
    yourBooking: "Su reserva",
    service: "Servicio",
    when: "Fecha y hora",
    where: "Dirección",
    reference: "Referencia",
    extrasTitle: "Agregue extras",
    extrasLede: "Opcional — toque los que desee. Los precios se actualizan al instante.",
    basePrice: "Precio base",
    extrasTotal: "Extras",
    estimatedTotal: "Total estimado",
    depositDue: "Depósito a pagar hoy",
    payButton: "Pagar depósito y confirmar",
    processing: "Procesando…",
    depositNote:
      "Su depósito aparta su horario y se descuenta de su total final. El resto se paga después de su limpieza.",
    heldUntil: (date: string) => `Apartamos su horario hasta el ${date}.`,
    loadFailed: "No pudimos cargar su reserva. Actualice la página o llámenos.",
    payFailed: "No pudimos abrir la página de pago. Inténtelo de nuevo o llámenos.",
    cancelled: "No se realizó ningún cobro. Su horario sigue apartado — pague cuando guste.",
  },
} as const;

/** Belt-and-braces: every no-payload response carries a notice, but the page
 *  must still render something readable if one ever does not. */
const COPY_NOTICE_FALLBACK = {
  en: { title: "We couldn't find this booking link", body: COPY.en.loadFailed },
  es: { title: "No encontramos este enlace de reserva", body: COPY.es.loadFailed },
} as const;

const money = (n: number) => `$${n.toFixed(0)}`;

/** A short branded shell, matching the transactional emails and notices. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FDF8F3] px-4 py-10 sm:py-14">
      <div className="mx-auto w-full max-w-lg">
        <p className="text-center font-display text-xl font-extrabold text-[#F26D5B]">
          Grapefruit Cleaning Co.
        </p>
        <div className="mt-5">{children}</div>
        <p className="mt-6 text-center text-xs text-[#9b918a]">
          © {new Date().getFullYear()} Grapefruit Cleaning Co.
        </p>
      </div>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
        <h1 className="font-display text-xl font-bold text-[#3d3733]">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[#3d3733]">{body}</p>
      </div>
    </Shell>
  );
}

export default function PayDeposit() {
  const [, params] = useRoute("/pay/deposit/:token");
  const token = params?.token ?? "";
  const link = trpc.depositLink.get.useQuery({ token }, { enabled: token.length > 0, retry: false });
  const [extras, setExtras] = useState<ExtraId[] | null>(null);

  const pay = trpc.depositLink.createSession.useMutation({
    onSuccess: result => {
      if (result.checkoutUrl) window.location.href = result.checkoutUrl;
    },
  });

  const data = link.data;
  const booking = data?.booking ?? null;
  const locale = data?.locale ?? "en";
  const c = COPY[locale];
  const t = locale === "es" ? es : en;

  // The owner's stored selection is the starting point (empty in practice —
  // extras are the customer's to choose), and the customer's taps take over.
  const chosen = extras ?? ((booking?.selectedExtras ?? []) as ExtraId[]);

  const preview = useMemo(() => {
    if (!booking) return null;
    const quote = calculateQuote(
      {
        type: booking.quote.type as never,
        bedrooms: booking.quote.bedrooms,
        bathrooms: booking.quote.bathrooms,
        sqft: booking.quote.sqft,
        extras: chosen,
        frequency: booking.quote.frequency as never,
      },
      booking.pricing
    );
    const withCoupon = applyCouponToTotal(quote.total, booking.coupon);
    return {
      base: quote.base,
      extrasTotal: quote.extrasTotal,
      total: withCoupon.total,
      deposit: depositFor(withCoupon.total, booking.pricing.depositRate),
    };
  }, [booking, chosen]);

  if (!token) return <Notice title="Missing link" body="This address is incomplete." />;

  if (link.isLoading) {
    return (
      <Shell>
        <div className="flex min-h-48 items-center justify-center rounded-2xl bg-white shadow-sm">
          <Loader2 className="h-6 w-6 animate-spin text-[#F26D5B]" />
        </div>
      </Shell>
    );
  }

  if (link.isError || !data) {
    return <Notice title="Something went wrong" body={COPY.en.loadFailed} />;
  }

  if (!booking) {
    const notice = data.notice ?? COPY_NOTICE_FALLBACK;
    return <Notice title={notice[locale].title} body={notice[locale].body} />;
  }

  const cancelled = new URLSearchParams(window.location.search).has("cancelled");
  const heldUntil = booking.expiresAt
    ? new Date(booking.expiresAt).toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <Shell>
      <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[1.4px] text-[#F26D5B]">{c.eyebrow}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-[#3d3733]">{c.heading}</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#6b625c]">{c.lede}</p>

        {cancelled && (
          <p className="mt-4 rounded-xl bg-[#FFF3F0] px-4 py-3 text-sm text-[#3d3733]">{c.cancelled}</p>
        )}

        {/* Locked — what the owner and the customer agreed on the phone. */}
        <div className="mt-6 rounded-xl bg-[#FDF8F3] p-5">
          <p className="text-[11px] font-bold uppercase tracking-[1.4px] text-[#F26D5B]">{c.yourBooking}</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-[#7a716b]">{c.service}</dt>
              <dd className="text-right font-semibold text-[#2E2724]">{booking.serviceName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="flex items-center gap-1.5 text-[#7a716b]">
                <Clock className="h-3.5 w-3.5" /> {c.when}
              </dt>
              <dd className="text-right font-semibold text-[#2E2724]">
                {booking.date} · {booking.time}
              </dd>
            </div>
            {booking.address && (
              <div className="flex justify-between gap-4">
                <dt className="flex items-center gap-1.5 text-[#7a716b]">
                  <MapPin className="h-3.5 w-3.5" /> {c.where}
                </dt>
                <dd className="text-right font-semibold text-[#2E2724]">{booking.address}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-[#7a716b]">{c.reference}</dt>
              <dd className="text-right font-mono text-xs font-semibold text-[#2E2724]">{booking.reference}</dd>
            </div>
          </dl>
        </div>

        {/* Open — the customer's own choice. */}
        <div className="mt-6">
          <h2 className="font-display text-lg font-bold text-[#3d3733]">{c.extrasTitle}</h2>
          <p className="mt-1 text-xs text-[#7a716b]">{c.extrasLede}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {EXTRA_IDS.map(id => {
              const active = chosen.includes(id);
              const price = booking.pricing.extras[id] ?? 0;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setExtras(prev => {
                      const current = prev ?? chosen;
                      return current.includes(id)
                        ? current.filter(e => e !== id)
                        : [...current, id];
                    })
                  }
                  className={`flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all duration-150 active:scale-[0.97] ${
                    active ? "border-[#F26D5B] bg-[#FFF3F0]" : "border-[#F0E6DE] bg-white hover:border-[#F26D5B]/40"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                      active ? "border-[#F26D5B] bg-[#F26D5B] text-white" : "border-[#E3D8CE]"
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="flex-1 text-sm font-semibold text-[#3d3733]">{t.extras[id]}</span>
                  <span className="text-sm font-semibold text-[#7a716b]">+{money(price)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Live totals. */}
        {preview && (
          <div className="mt-6 rounded-xl bg-[#FDF8F3] p-5 text-sm">
            <div className="flex justify-between text-[#7a716b]">
              <span>{c.basePrice}</span>
              <span>{money(preview.base)}</span>
            </div>
            {preview.extrasTotal > 0 && (
              <div className="mt-1.5 flex justify-between text-[#7a716b]">
                <span>{c.extrasTotal}</span>
                <span>+{money(preview.extrasTotal)}</span>
              </div>
            )}
            <div className="mt-3 flex justify-between border-t border-[#F0E6DE] pt-3 font-semibold text-[#2E2724]">
              <span>{c.estimatedTotal}</span>
              <span>{money(preview.total)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="font-bold text-[#3d3733]">{c.depositDue}</span>
              <span className="font-display text-2xl font-extrabold text-[#F26D5B]">
                {money(preview.deposit)}
              </span>
            </div>
          </div>
        )}

        <Button
          className="mt-5 h-12 w-full rounded-xl bg-[#F26D5B] text-base font-bold hover:bg-[#e05c4a]"
          disabled={pay.isPending}
          onClick={() => {
            // Extra IDs only. Every figure above is a preview; the server
            // recomputes the price and mints the session for that amount.
            pay.mutate(
              { token, extras: chosen },
              { onError: error => toast.error(error.message || c.payFailed) }
            );
          }}
        >
          {pay.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {c.processing}
            </>
          ) : (
            c.payButton
          )}
        </Button>

        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-[#7a716b]">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {c.depositNote}
            {heldUntil ? ` ${c.heldUntil(heldUntil)}` : ""}
          </span>
        </p>
      </div>
    </Shell>
  );
}
