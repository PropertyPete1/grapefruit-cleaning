/**
 * /pay/tip/:token — the crew-tip page behind the settled-booking thank-you.
 *
 * Opens with the 15% preset PRE-SELECTED and the pay button live showing that
 * amount — one tap pays it. The other presets, a custom amount, and a clearly
 * visible "no tip, just say thanks" are one tap away. Nothing ever charges
 * without the customer's explicit pay tap; declining sends no money and marks
 * the ask answered so a revisit says thanks instead of asking again.
 *
 * The page never sends an amount the server trusts: it sends a preset id or a
 * custom figure, and the server clamps and recomputes every dollar before
 * minting the Stripe session. Standalone and bilingual by the booking's own
 * locale, like /pay/deposit.
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Heart, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const COPY = {
  en: {
    eyebrow: "A tip for your crew",
    heading: (first: string) => (first ? `Thank you, ${first}!` : "Thank you!"),
    lede: "Your cleaning is complete and you're all settled up. If you'd like to leave the crew a tip, you can do it right here — 100% goes to them. Completely optional, always appreciated.",
    custom: "Custom",
    customLabel: "Your amount (USD)",
    payButton: (amount: string) => `Tip ${amount}`,
    payButtonBare: "Leave a tip",
    decline: "No tip — just say thanks",
    processing: "Processing…",
    securePay: "Secure payment processed by Stripe. We never store your card details.",
    loadFailed: "We couldn't load this page. Please refresh, or simply close it — no action is needed.",
    payFailed: "We couldn't open the payment page. Please try again.",
    customHint: (max: string) => `Any whole amount from $1 up to ${max} (the job total).`,
  },
  es: {
    eyebrow: "Una propina para su equipo",
    heading: (first: string) => (first ? `¡Gracias, ${first}!` : "¡Gracias!"),
    lede: "Su limpieza está completa y su cuenta al día. Si desea dejarle una propina al equipo, puede hacerlo aquí — el 100% es para ellos. Completamente opcional, siempre apreciada.",
    custom: "Otra cantidad",
    customLabel: "Su cantidad (USD)",
    payButton: (amount: string) => `Dejar ${amount}`,
    payButtonBare: "Dejar propina",
    decline: "Sin propina — solo dar las gracias",
    processing: "Procesando…",
    securePay: "Pago seguro procesado por Stripe. Nunca almacenamos los datos de su tarjeta.",
    loadFailed: "No pudimos cargar esta página. Actualícela, o simplemente ciérrela — no necesita hacer nada.",
    payFailed: "No pudimos abrir la página de pago. Inténtelo de nuevo.",
    customHint: (max: string) => `Cualquier cantidad entera desde $1 hasta ${max} (el total del servicio).`,
  },
} as const;

const money = (n: number) => `$${n.toFixed(0)}`;

/** The same branded shell as the deposit page and the notices. */
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
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#FFF3F0]">
          <Heart className="h-6 w-6 text-[#F26D5B]" />
        </span>
        <h1 className="mt-4 font-display text-xl font-bold text-[#3d3733]">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[#3d3733]">{body}</p>
      </div>
    </Shell>
  );
}

/** The 15% preset unless the email button carried a different valid hint. */
function initialChoice(): number | "custom" {
  const hint = new URLSearchParams(window.location.search).get("p");
  if (hint === "custom") return "custom";
  const pct = Number(hint);
  return pct === 20 || pct === 25 ? pct : 15;
}

export default function PayTip() {
  const [, params] = useRoute("/pay/tip/:token");
  const token = params?.token ?? "";
  const utils = trpc.useUtils();
  const link = trpc.tip.get.useQuery({ token }, { enabled: token.length > 0, retry: false });

  const [choice, setChoice] = useState<number | "custom">(initialChoice);
  const [customText, setCustomText] = useState("");

  const pay = trpc.tip.createSession.useMutation({
    onSuccess: result => {
      if (result.checkoutUrl) window.location.href = result.checkoutUrl;
    },
  });
  const decline = trpc.tip.decline.useMutation({
    // The refetch lands on the server's "declined" notice — the page stops asking.
    onSuccess: () => utils.tip.get.invalidate({ token }),
  });

  const data = link.data;
  const locale = data?.locale ?? "en";
  const c = COPY[locale];
  // Stripe sends the customer back with ?paid=1; the webhook may not have
  // landed yet, so thank them right away instead of asking again.
  const returnedPaid = new URLSearchParams(window.location.search).has("paid");

  useEffect(() => {
    if (returnedPaid) utils.tip.get.invalidate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedPaid]);

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

  if (link.isError || !data) return <Notice title="Something went wrong" body={COPY.en.loadFailed} />;

  const paidNotice = COPY_PAID[locale];
  if (returnedPaid) return <Notice title={paidNotice.title} body={paidNotice.body} />;
  // A fresh decline refetches into the server's "declined" notice below.
  if (!data.booking) {
    const notice = data.notice ?? { en: { title: "Thank you!", body: COPY.en.loadFailed }, es: { title: "¡Gracias!", body: COPY.es.loadFailed } };
    return <Notice title={notice[locale].title} body={notice[locale].body} />;
  }
  const booking = data.booking;

  const customAmount = (() => {
    const n = Number(customText);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(booking.total, Math.round(n));
  })();
  const selectedAmount =
    choice === "custom" ? customAmount : (booking.presets.find(p => p.percent === choice)?.amount ?? null);

  return (
    <Shell>
      <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[1.4px] text-[#F26D5B]">{c.eyebrow}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-[#3d3733]">
          {c.heading(booking.customerFirstName)}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[#6b625c]">{c.lede}</p>

        <div className="mt-5 rounded-xl bg-[#FDF8F3] px-4 py-3 text-sm text-[#7a716b]">
          {booking.serviceName}
          {booking.date ? ` · ${booking.date}` : ""} ·{" "}
          <span className="font-mono text-xs font-semibold text-[#2E2724]">{booking.reference}</span>
        </div>

        {/* Presets — 15% arrives pre-selected; one tap on Pay sends it. */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {booking.presets.map(preset => {
            const active = choice === preset.percent;
            return (
              <button
                key={preset.percent}
                type="button"
                aria-pressed={active}
                onClick={() => setChoice(preset.percent)}
                className={`rounded-xl border-2 px-2 py-3 text-center transition-all duration-150 active:scale-[0.97] ${
                  active ? "border-[#F26D5B] bg-[#FFF3F0]" : "border-[#F0E6DE] bg-white hover:border-[#F26D5B]/40"
                }`}
              >
                <span className="block font-display text-lg font-extrabold text-[#2E2724]">
                  {money(preset.amount)}
                </span>
                <span className="block text-xs font-semibold text-[#7a716b]">{preset.percent}%</span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={choice === "custom"}
            onClick={() => setChoice("custom")}
            className={`rounded-xl border-2 px-2 py-3 text-center transition-all duration-150 active:scale-[0.97] ${
              choice === "custom"
                ? "border-[#F26D5B] bg-[#FFF3F0]"
                : "border-[#F0E6DE] bg-white hover:border-[#F26D5B]/40"
            }`}
          >
            <span className="block font-display text-lg font-extrabold text-[#2E2724]">···</span>
            <span className="block text-xs font-semibold text-[#7a716b]">{c.custom}</span>
          </button>
        </div>

        {choice === "custom" && (
          <div className="mt-3">
            <label className="text-xs font-semibold text-[#7a716b]" htmlFor="tip-custom">
              {c.customLabel}
            </label>
            <input
              id="tip-custom"
              type="number"
              inputMode="numeric"
              min={1}
              max={booking.total}
              step={1}
              className="mt-1.5 h-11 w-full rounded-xl border-2 border-[#F0E6DE] px-3 text-sm font-bold"
              value={customText}
              onChange={e => setCustomText(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-[#9b918a]">{c.customHint(money(booking.total))}</p>
          </div>
        )}

        <Button
          className="mt-5 h-12 w-full rounded-xl bg-[#F26D5B] text-base font-bold hover:bg-[#e05c4a]"
          disabled={pay.isPending || selectedAmount == null}
          onClick={() => {
            // A preset id or a typed figure — never a price the server trusts.
            pay.mutate(
              choice === "custom"
                ? { token, customAmount: customAmount ?? 1 }
                : { token, preset: choice as 15 | 20 | 25 },
              { onError: error => toast.error(error.message || c.payFailed) }
            );
          }}
        >
          {pay.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {c.processing}
            </>
          ) : selectedAmount != null ? (
            c.payButton(money(selectedAmount))
          ) : (
            c.payButtonBare
          )}
        </Button>

        <button
          type="button"
          disabled={decline.isPending}
          onClick={() =>
            decline.mutate({ token }, { onError: error => toast.error(error.message || c.loadFailed) })
          }
          className="mt-3 w-full text-center text-sm font-semibold text-[#7a716b] underline decoration-[#E3D8CE] underline-offset-4 hover:text-[#F26D5B]"
        >
          {c.decline}
        </button>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-[#9b918a]">{c.securePay}</p>
      </div>
    </Shell>
  );
}

/** Post-Stripe-return thanks, shown before the webhook lands. */
const COPY_PAID = {
  en: {
    title: "Thank you so much!",
    body: "Your tip went straight to your crew — they'll be thrilled. It was a pleasure cleaning for you!",
  },
  es: {
    title: "¡Muchísimas gracias!",
    body: "Su propina va directo a su equipo — les dará mucho gusto. ¡Fue un placer limpiar para usted!",
  },
} as const;
