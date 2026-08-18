/**
 * /pay/deposit/:token — the customer's half of a booking taken by phone.
 *
 * The owner entered whatever he knew and sent this link. What he locked shows
 * as settled facts under their name; what he skipped, the page asks for, one
 * question at a time and only the ones that are open: service, then home
 * size, then a time. Extras and access notes are always theirs. Then they pay.
 *
 * Prices preview instantly with the same shared engine the server runs, and
 * the page never sends an amount — service ids, square footage, a slot, extra
 * ids. Picking a time claims the slot server-side that moment, under every
 * scheduling rule; the server reprices on every write and mints the Stripe
 * session from its own arithmetic.
 *
 * Standalone, outside the locale-routed site: the link arrives by text with
 * no locale in it, and the language is the one the owner took the call in.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { Check, Clock, Home, Loader2, MapPin, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  applyCouponToTotal,
  calculateQuote,
  CLEANING_TYPES,
  depositFor,
  EXTRA_IDS,
  type CleaningType,
  type ExtraId,
} from "@shared/pricing";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/translations/en";
import { es } from "@/i18n/translations/es";

const COPY = {
  en: {
    eyebrow: "Your booking",
    heading: (first: string) => (first ? `Hi ${first} — finish your Grapefruit booking` : "Finish your Grapefruit booking"),
    lede: "A couple of quick choices and you're booked. Your price updates as you go.",
    ledeReady: "Everything below is set up from your call. Add any extras you'd like — your total updates as you go.",
    yourBooking: "Your booking",
    service: "Service",
    when: "Date & time",
    where: "Address",
    size: "Home size",
    reference: "Reference",
    stepService: "What kind of cleaning?",
    stepSize: "How big is your home?",
    propertyTypeLabel: "What kind of place is it?",
    propertyHouse: "House",
    propertyApartment: "Apartment / Condo",
    apartmentNote:
      "County records size whole buildings, not units — so we take your square footage as entered and confirm at your appointment.",
    unitPlaceholder: "Unit #",
    typeItIn: "or type it:",
    sizeByAddress: "Enter your address and we'll size it from county records — that keeps your price exact.",
    addressLine: "Street address",
    cityLine: "City",
    zipLine: "ZIP code",
    lookUp: "Use my address",
    sizeVerified: "Sized from county records",
    orSlider: "Not sure? Estimate it:",
    sliderNote: "A close guess is fine — we verify against county records when we can.",
    stepTime: "Pick your date & time",
    morning: "Morning",
    afternoon: "Afternoon",
    closedDay: "We're not scheduling cleanings on this day. Please pick another date.",
    noTimesLeft: "There are no times left on this day. Please pick another date.",
    slotHeld: (when: string) => `Your time is held: ${when}`,
    changeTime: "Change time",
    firstThings: "Choose your service and home size first — then we can show you the open times.",
    extrasTitle: "Add any extras",
    extrasLede: "Optional — tap any you'd like. Prices update instantly.",
    notesTitle: "Anything we should know?",
    notesPlaceholder: "Gate codes, parking, pets, anything we should know?",
    basePrice: "Base price",
    extrasTotal: "Extras",
    estimatedTotal: "Estimated total",
    depositDue: "Deposit due today",
    priceComesLater: "Your price appears once you've chosen your service and home size.",
    payButton: "Pay deposit & confirm",
    processing: "Processing…",
    finishSteps: "Finish the steps above to unlock the deposit button.",
    depositNote: "Your deposit secures your slot and comes off your final total. The rest is due after your cleaning.",
    heldUntil: (d: string) => `This link is good through ${d}.`,
    loadFailed: "We couldn't load your booking. Please refresh, or give us a call.",
    payFailed: "We couldn't open the payment page. Please try again, or give us a call.",
    cancelled: "No payment was taken. Everything you chose is saved — pay whenever you're ready.",
    saved: "Saved!",
  },
  es: {
    eyebrow: "Su reserva",
    heading: (first: string) => (first ? `Hola ${first} — complete su reserva Grapefruit` : "Complete su reserva Grapefruit"),
    lede: "Un par de decisiones rápidas y queda reservado. Su precio se actualiza mientras elige.",
    ledeReady: "Todo lo siguiente viene de su llamada. Agregue los extras que desee — su total se actualiza al instante.",
    yourBooking: "Su reserva",
    service: "Servicio",
    when: "Fecha y hora",
    where: "Dirección",
    size: "Tamaño del hogar",
    reference: "Referencia",
    stepService: "¿Qué tipo de limpieza?",
    stepSize: "¿Qué tan grande es su hogar?",
    propertyTypeLabel: "¿Qué tipo de lugar es?",
    propertyHouse: "Casa",
    propertyApartment: "Apartamento / Condominio",
    apartmentNote:
      "Los registros del condado miden edificios completos, no unidades — así que tomamos sus pies cuadrados tal como los ingresó y los confirmamos en su cita.",
    unitPlaceholder: "Unidad #",
    typeItIn: "o escríbalo:",
    sizeByAddress: "Escriba su dirección y la medimos con registros del condado — así su precio queda exacto.",
    addressLine: "Dirección",
    cityLine: "Ciudad",
    zipLine: "Código postal",
    lookUp: "Usar mi dirección",
    sizeVerified: "Medido con registros del condado",
    orSlider: "¿No está seguro? Estímelo:",
    sliderNote: "Una aproximación está bien — verificamos con registros del condado cuando es posible.",
    stepTime: "Elija su fecha y hora",
    morning: "Mañana",
    afternoon: "Tarde",
    closedDay: "No agendamos limpiezas este día. Por favor elija otra fecha.",
    noTimesLeft: "No quedan horarios este día. Por favor elija otra fecha.",
    slotHeld: (when: string) => `Su horario está apartado: ${when}`,
    changeTime: "Cambiar horario",
    firstThings: "Elija primero su servicio y el tamaño de su hogar — después le mostramos los horarios disponibles.",
    extrasTitle: "Agregue extras",
    extrasLede: "Opcional — toque los que desee. Los precios se actualizan al instante.",
    notesTitle: "¿Algo que debamos saber?",
    notesPlaceholder: "Códigos de acceso, estacionamiento, mascotas, ¿algo que debamos saber?",
    basePrice: "Precio base",
    extrasTotal: "Extras",
    estimatedTotal: "Total estimado",
    depositDue: "Depósito a pagar hoy",
    priceComesLater: "Su precio aparece cuando elija su servicio y el tamaño de su hogar.",
    payButton: "Pagar depósito y confirmar",
    processing: "Procesando…",
    finishSteps: "Complete los pasos anteriores para activar el botón de depósito.",
    depositNote: "Su depósito aparta su horario y se descuenta de su total final. El resto se paga después de su limpieza.",
    heldUntil: (d: string) => `Este enlace está disponible hasta el ${d}.`,
    loadFailed: "No pudimos cargar su reserva. Actualice la página o llámenos.",
    payFailed: "No pudimos abrir la página de pago. Inténtelo de nuevo o llámenos.",
    cancelled: "No se realizó ningún cobro. Todo lo que eligió está guardado — pague cuando guste.",
    saved: "¡Guardado!",
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

/** Section header with a step-done tick once its question is answered. */
function StepTitle({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-display text-lg font-bold text-[#3d3733]">
      {done && (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#2f9e6e] text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      {children}
    </h2>
  );
}

export default function PayDeposit() {
  const [, params] = useRoute("/pay/deposit/:token");
  const token = params?.token ?? "";
  const utils = trpc.useUtils();
  const link = trpc.depositLink.get.useQuery({ token }, { enabled: token.length > 0, retry: false });

  const [extras, setExtras] = useState<ExtraId[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [slotDate, setSlotDate] = useState("");
  const [changingSlot, setChangingSlot] = useState(false);
  // A mis-tap must not dead-end at "call us": anything the CUSTOMER chose
  // stays editable until they pay. Owner-locked facts never get these.
  const [changingService, setChangingService] = useState(false);
  const [changingSize, setChangingSize] = useState(false);
  const [addr, setAddr] = useState({ address: "", city: "", zip: "" });
  const [slider, setSlider] = useState(1200);
  const [sliderTouched, setSliderTouched] = useState(false);
  const [unitNumber, setUnitNumber] = useState("");
  const [kindChoice, setKindChoice] = useState<"house" | "apartment" | null>(null);

  const refresh = () => utils.depositLink.get.invalidate({ token });

  const update = trpc.depositLink.updateDetails.useMutation({
    onSuccess: result => {
      setChangingService(false);
      setChangingSize(false);
      refresh();
      if (result.slotCleared) {
        toast.info(
          locale === "es"
            ? "Su nuevo tamaño necesita más tiempo — elija su horario otra vez."
            : "Your new size needs more time — please pick your time again."
        );
      }
    },
    onError: error => toast.error(error.message || c.loadFailed),
  });

  const claim = trpc.depositLink.claimSlot.useMutation({
    onSuccess: () => {
      setChangingSlot(false);
      refresh();
    },
    onError: error => {
      toast.error(error.message);
      // The ordinary taken-slot outcome: someone got there first. Refresh the
      // grid so the stale slot greys out rather than failing again.
      utils.booking.availability.invalidate();
      refresh();
    },
  });

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

  const chosen = extras ?? ((booking?.selectedExtras ?? []) as ExtraId[]);
  const kind = kindChoice ?? booking?.propertyType ?? "house";
  const noteText = note ?? booking?.customerNote ?? "";

  // Availability for the slot step, through the same public query the booking
  // calendar uses — service and size ride along so duration rules apply.
  const availability = trpc.booking.availability.useQuery(
    {
      date: slotDate,
      serviceType: (booking?.serviceType ?? undefined) as CleaningType | undefined,
      sqft: booking?.sqft ?? undefined,
    },
    { enabled: Boolean(booking) && /^\d{4}-\d{2}-\d{2}$/.test(slotDate) }
  );

  const preview = useMemo(() => {
    if (!booking || booking.quote.type == null || booking.quote.sqft == null) return null;
    const quote = calculateQuote(
      {
        type: booking.quote.type as CleaningType,
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

  const needs = booking.needs;
  const complete = !needs.service && !needs.size && !needs.slot;
  const cancelled = new URLSearchParams(window.location.search).has("cancelled");
  const heldUntil = booking.expiresAt
    ? new Date(booking.expiresAt).toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
        month: "long",
        day: "numeric",
      })
    : null;

  const changeWord = locale === "es" ? "Cambiar" : "Change";
  const lockedFacts: { icon: React.ReactNode; label: string; value: string; onChange?: () => void }[] = [
    ...(booking.serviceName && !needs.service
      ? [
          {
            icon: <Sparkles className="h-3.5 w-3.5" />,
            label: c.service,
            value: booking.serviceName,
            // Editable only when the customer chose it themselves.
            onChange: booking.locks.service ? undefined : () => setChangingService(true),
          },
        ]
      : []),
    ...(booking.date && booking.time && !needs.slot
      ? [{ icon: <Clock className="h-3.5 w-3.5" />, label: c.when, value: `${booking.date} · ${booking.time}` }]
      : []),
    ...(booking.address
      ? [{ icon: <MapPin className="h-3.5 w-3.5" />, label: c.where, value: booking.address }]
      : []),
    ...(booking.sqft != null && !needs.size
      ? [
          {
            icon: <Home className="h-3.5 w-3.5" />,
            label: c.size,
            value: `${booking.sqft.toLocaleString()} ft²${booking.sqftVerified ? ` · ${c.sizeVerified}` : ""}`,
            // A county-verified size is settled fact, not preference.
            onChange:
              booking.locks.size || booking.sqftVerified ? undefined : () => setChangingSize(true),
          },
        ]
      : []),
  ];

  const morning = (availability.data ?? []).filter(s => Number(s.time.slice(0, 2)) < 12);
  const afternoon = (availability.data ?? []).filter(s => Number(s.time.slice(0, 2)) >= 12);

  return (
    <Shell>
      <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[1.4px] text-[#F26D5B]">{c.eyebrow}</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-[#3d3733]">
          {c.heading(booking.customerFirstName)}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[#6b625c]">{complete ? c.ledeReady : c.lede}</p>

        {cancelled && (
          <p className="mt-4 rounded-xl bg-[#FFF3F0] px-4 py-3 text-sm text-[#3d3733]">{c.cancelled}</p>
        )}

        {/* What the owner already locked — settled facts, not questions. */}
        {lockedFacts.length > 0 && (
          <div className="mt-6 rounded-xl bg-[#FDF8F3] p-5">
            <p className="text-[11px] font-bold uppercase tracking-[1.4px] text-[#F26D5B]">{c.yourBooking}</p>
            <dl className="mt-3 space-y-2 text-sm">
              {lockedFacts.map(fact => (
                <div key={fact.label} className="flex justify-between gap-4">
                  <dt className="flex items-center gap-1.5 text-[#7a716b]">
                    {fact.icon} {fact.label}
                  </dt>
                  <dd className="text-right font-semibold text-[#2E2724]">
                    {fact.value}
                    {fact.onChange && (
                      <button
                        type="button"
                        className="ml-2 text-xs font-semibold text-[#F26D5B] underline"
                        onClick={fact.onChange}
                      >
                        {changeWord}
                      </button>
                    )}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between gap-4">
                <dt className="text-[#7a716b]">{c.reference}</dt>
                <dd className="text-right font-mono text-xs font-semibold text-[#2E2724]">{booking.reference}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* Step: service — only when the owner left it open. */}
        {(needs.service || changingService) && (
          <div className="mt-6">
            <StepTitle done={false}>{c.stepService}</StepTitle>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {CLEANING_TYPES.map(id => (
                <button
                  key={id}
                  type="button"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ token, serviceType: id })}
                  className="rounded-xl border-2 border-[#F0E6DE] bg-white p-3 text-left text-sm font-semibold text-[#3d3733] transition-all duration-150 hover:border-[#F26D5B]/40 active:scale-[0.97]"
                >
                  {t.nav.servicesMenu[id]}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Step: size — what kind of place, then address or an exact figure.
            Apartments never ask the county anything: parcels are building-
            level, and the complex's square footage is nobody's unit. */}
        {(needs.size || changingSize) && !needs.service && (
          <div className="mt-6">
            <StepTitle done={false}>{c.stepSize}</StepTitle>
            <p className="mt-2 text-xs font-semibold text-[#7a716b]">{c.propertyTypeLabel}</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(["house", "apartment"] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => {
                    setKindChoice(option);
                    update.mutate({ token, propertyType: option });
                  }}
                  className={`h-11 rounded-xl border-2 text-sm font-semibold transition-colors ${
                    kind === option
                      ? "border-[#F26D5B] bg-[#FFF3F0] text-[#3d3733]"
                      : "border-[#F0E6DE] bg-white text-[#7a716b] hover:border-[#F26D5B]/40"
                  }`}
                >
                  {option === "house" ? c.propertyHouse : c.propertyApartment}
                </button>
              ))}
            </div>
            {kind === "apartment" && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#9b918a]">{c.apartmentNote}</p>
            )}
            {!booking.address && (
              <div className="mt-3 space-y-2">
                {kind === "house" && <p className="text-xs text-[#7a716b]">{c.sizeByAddress}</p>}
                <div className="flex gap-2">
                  <input
                    className="h-11 min-w-0 flex-1 rounded-xl border-2 border-[#F0E6DE] px-3 text-sm"
                    placeholder={c.addressLine}
                    value={addr.address}
                    onChange={e => setAddr({ ...addr, address: e.target.value })}
                  />
                  {kind === "apartment" && (
                    <input
                      className="h-11 w-24 rounded-xl border-2 border-[#F0E6DE] px-3 text-sm"
                      placeholder={c.unitPlaceholder}
                      value={unitNumber}
                      onChange={e => setUnitNumber(e.target.value)}
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="h-11 rounded-xl border-2 border-[#F0E6DE] px-3 text-sm"
                    placeholder={c.cityLine}
                    value={addr.city}
                    onChange={e => setAddr({ ...addr, city: e.target.value })}
                  />
                  <input
                    className="h-11 rounded-xl border-2 border-[#F0E6DE] px-3 text-sm"
                    placeholder={c.zipLine}
                    value={addr.zip}
                    onChange={e => setAddr({ ...addr, zip: e.target.value })}
                  />
                </div>
                {kind === "house" && (
                  <Button
                    variant="outline"
                    className="rounded-xl border-[#F26D5B] text-[#F26D5B]"
                    disabled={addr.address.trim().length < 3 || update.isPending}
                    onClick={() =>
                      update.mutate({
                        token,
                        address: addr.address.trim(),
                        city: addr.city.trim() || "San Antonio",
                        zip: addr.zip.trim() || undefined,
                      })
                    }
                  >
                    {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {c.lookUp}
                  </Button>
                )}
              </div>
            )}
            <div className="mt-4">
              <p className="text-xs font-semibold text-[#7a716b]">{c.orSlider}</p>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={200}
                  max={5000}
                  step={50}
                  value={slider}
                  onChange={e => {
                    setSlider(Number(e.target.value));
                    setSliderTouched(true);
                  }}
                  className="w-full accent-[#F26D5B]"
                />
                {/* Tap-to-type: the slider is for feel, the field is for the
                    customer who knows their lease says 743. */}
                <span className="flex items-center gap-1 text-sm font-bold text-[#2E2724]">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={200}
                    max={10000}
                    step={1}
                    aria-label={c.typeItIn}
                    className="h-9 w-20 rounded-lg border-2 border-[#F0E6DE] px-1.5 text-right text-sm font-bold"
                    value={slider}
                    onChange={e => {
                      const typed = Number(e.target.value);
                      if (Number.isFinite(typed)) {
                        setSlider(Math.round(typed));
                        setSliderTouched(true);
                      }
                    }}
                  />
                  ft²
                </span>
              </div>
              <p className="mt-1 text-[11px] text-[#9b918a]">{kind === "house" ? c.sliderNote : ""}</p>
              <Button
                variant="outline"
                className="mt-2 rounded-xl border-[#F26D5B] text-[#F26D5B]"
                disabled={!sliderTouched || update.isPending}
                onClick={() =>
                  update.mutate({
                    token,
                    sqft: Math.min(10000, Math.max(200, slider)),
                    ...(kind === "apartment" && !booking.address && addr.address.trim().length >= 3
                      ? {
                          address: addr.address.trim(),
                          city: addr.city.trim() || "San Antonio",
                          zip: addr.zip.trim() || undefined,
                        }
                      : {}),
                    ...(kind === "apartment" && unitNumber.trim() ? { unitNumber: unitNumber.trim() } : {}),
                  })
                }
              >
                {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {c.saved.replace("!", "")} {Math.min(10000, Math.max(200, slider)).toLocaleString()} ft²
              </Button>
            </div>
          </div>
        )}

        {/* Step: time — live availability, claimed server-side on tap. */}
        {(needs.slot || changingSlot) && (
          <div className="mt-6">
            <StepTitle done={false}>{c.stepTime}</StepTitle>
            {needs.service || needs.size ? (
              <p className="mt-2 rounded-xl bg-[#FDF8F3] px-4 py-3 text-sm text-[#7a716b]">{c.firstThings}</p>
            ) : (
              <div className="mt-3 space-y-3">
                <input
                  type="date"
                  className="h-11 w-full rounded-xl border-2 border-[#F0E6DE] px-3 text-sm"
                  min={todayInBookingZone()}
                  value={slotDate}
                  onChange={e => setSlotDate(e.target.value)}
                />
                {slotDate && availability.isLoading && (
                  <div className="flex min-h-16 items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-[#F26D5B]" />
                  </div>
                )}
                {slotDate && availability.data && availability.data.length === 0 && (
                  <p className="rounded-xl bg-[#FDF8F3] px-4 py-3 text-sm text-[#7a716b]">{c.closedDay}</p>
                )}
                {slotDate && availability.data && availability.data.length > 0 && !availability.data.some(s => s.available) && (
                  <p className="rounded-xl bg-[#FDF8F3] px-4 py-3 text-sm text-[#7a716b]">{c.noTimesLeft}</p>
                )}
                {slotDate &&
                  availability.data &&
                  availability.data.some(s => s.available) &&
                  [
                    { label: c.morning, slots: morning },
                    { label: c.afternoon, slots: afternoon },
                  ].map(
                    group =>
                      group.slots.length > 0 && (
                        <div key={group.label}>
                          <p className="text-xs font-semibold text-[#7a716b]">{group.label}</p>
                          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                            {group.slots.map(slot => (
                              <button
                                key={slot.time}
                                type="button"
                                disabled={!slot.available || claim.isPending}
                                onClick={() => claim.mutate({ token, date: slotDate, time: slot.time })}
                                className="h-10 rounded-xl border-2 border-[#F0E6DE] bg-white text-sm font-semibold text-[#3d3733] transition-all duration-150 hover:border-[#F26D5B]/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                              >
                                {slot.time}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                  )}
              </div>
            )}
          </div>
        )}
        {!needs.slot && !changingSlot && !booking.locks.slot && booking.date && booking.time && (
          <div className="mt-6 flex items-center justify-between gap-3 rounded-xl bg-[#EDF7F2] px-4 py-3 text-sm">
            <span className="font-semibold text-[#1e6b4a]">
              {c.slotHeld(`${booking.date} · ${booking.time}`)}
            </span>
            <button
              type="button"
              className="shrink-0 text-xs font-semibold text-[#F26D5B] underline"
              onClick={() => {
                // Claiming another slot simply replaces this one server-side;
                // nothing is released until the new claim lands.
                setSlotDate(booking.date ?? "");
                setChangingSlot(true);
              }}
            >
              {c.changeTime}
            </button>
          </div>
        )}

        {/* Extras — always on offer; this is the upsell. */}
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
                      return current.includes(id) ? current.filter(e => e !== id) : [...current, id];
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

        {/* Access notes — appended to the owner's own notes, never over them. */}
        <div className="mt-6">
          <h2 className="font-display text-lg font-bold text-[#3d3733]">{c.notesTitle}</h2>
          <textarea
            className="mt-2 w-full rounded-xl border-2 border-[#F0E6DE] px-3 py-2 text-sm"
            rows={2}
            maxLength={1000}
            placeholder={c.notesPlaceholder}
            value={noteText}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        {/* Live totals — appear the moment the price is computable. */}
        {preview ? (
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
        ) : (
          <p className="mt-6 rounded-xl bg-[#FDF8F3] px-4 py-3 text-sm text-[#7a716b]">{c.priceComesLater}</p>
        )}

        <Button
          className="mt-5 h-12 w-full rounded-xl bg-[#F26D5B] text-base font-bold hover:bg-[#e05c4a]"
          disabled={pay.isPending || !complete}
          onClick={() => {
            // Selections only. Every figure above is a preview; the server
            // recomputes the price and mints the session for that amount.
            pay.mutate(
              { token, extras: chosen, notes: noteText },
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
        {!complete && <p className="mt-2 text-center text-xs text-[#9b918a]">{c.finishSteps}</p>}

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
