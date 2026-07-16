import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Briefcase,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Home as HomeIcon,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  PackageOpen,
  PartyPopper,
  Phone,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo } from "@/hooks/useSeo";
import { AnimatedPrice } from "@/components/AnimatedPrice";
import { trpc } from "@/lib/trpc";
import {
  calculateQuote,
  DEPOSIT_RATE,
  type CleaningType,
  type ExtraId,
  type Frequency,
} from "@shared/pricing";

const SERVICE_ICONS: Record<CleaningType, typeof HomeIcon> = {
  residential: HomeIcon,
  commercial: Building2,
  airbnb: KeyRound,
  moveinout: PackageOpen,
  deep: Sparkles,
  office: Briefcase,
};

const ALL_EXTRAS: ExtraId[] = [
  "pets",
  "deepClean",
  "moveOut",
  "oven",
  "refrigerator",
  "windows",
  "laundry",
  "garage",
  "organization",
];

const VALID_TYPES: CleaningType[] = ["residential", "commercial", "airbnb", "moveinout", "deep", "office"];
const VALID_FREQ: Frequency[] = ["onetime", "weekly", "biweekly", "monthly"];

const stepVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 32 : -32 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -32 : 32 }),
};

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function Booking() {
  const { t, locale, path } = useLocale();
  const [, navigate] = useLocation();
  useSeo({ title: t.meta.booking.title, description: t.meta.booking.description });

  // ---- read querystring (quote prefill or Stripe return) ----
  const search = typeof window !== "undefined" ? window.location.search : "";
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const sessionId = params.get("session_id");
  const refParam = params.get("ref");
  const cancelled = params.get("cancelled");

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const [type, setType] = useState<CleaningType>(() => {
    const q = params.get("type");
    return VALID_TYPES.includes(q as CleaningType) ? (q as CleaningType) : "residential";
  });
  const [bedrooms] = useState(() => Math.min(10, Math.max(0, Number(params.get("bedrooms") ?? 2) || 2)));
  const [bathrooms] = useState(() => Math.min(10, Math.max(1, Number(params.get("bathrooms") ?? 1) || 1)));
  const [sqft] = useState(() => Math.min(10000, Math.max(200, Number(params.get("sqft") ?? 1200) || 1200)));
  const [extras, setExtras] = useState<ExtraId[]>(() => {
    const raw = params.get("extras");
    if (!raw) return [];
    return raw.split(",").filter((e): e is ExtraId => ALL_EXTRAS.includes(e as ExtraId));
  });
  const [frequency, setFrequency] = useState<Frequency>(() => {
    const q = params.get("frequency");
    return VALID_FREQ.includes(q as Frequency) ? (q as Frequency) : "onetime";
  });

  const [date, setDate] = useState<Date | undefined>(undefined);
  const [time, setTime] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: params.get("address") ?? "",
    city: params.get("city") ?? "",
    zip: params.get("zip") ?? "",
    notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Debounced copy of the address line used for public-records sqft verification.
  const [debouncedAddress, setDebouncedAddress] = useState("");
  const [debouncedCity, setDebouncedCity] = useState("");
  const [debouncedZip, setDebouncedZip] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAddress(form.address);
      setDebouncedCity(form.city);
      setDebouncedZip(form.zip);
    }, 800);
    return () => clearTimeout(timer);
  }, [form.address, form.city, form.zip]);

  // Confirmation state (after Stripe return)
  const [confirmed, setConfirmed] = useState<null | {
    reference: string;
    serviceType: string;
    date: string;
    time: string;
    total: number;
    deposit: number;
    customerFirstName: string;
  }>(null);
  const [confirming, setConfirming] = useState(Boolean(sessionId && refParam));

  // Verify sqft against county property records once an address is typed.
  const propertyLookup = trpc.booking.verifyProperty.useQuery(
    {
      address: debouncedAddress,
      city: debouncedCity.trim() || undefined,
      zip: debouncedZip.trim() || undefined,
    },
    { enabled: debouncedAddress.trim().length >= 6, staleTime: 1000 * 60 * 10 }
  );
  const verifiedSqft =
    propertyLookup.data?.verified && propertyLookup.data.sqft ? propertyLookup.data.sqft : null;
  const addressVerifiedCounty =
    !verifiedSqft && propertyLookup.data?.addressVerified ? (propertyLookup.data.county ?? null) : null;

  // Match server behavior: price from the verified record when it lands in a higher tier.
  const { breakdown, sqftAdjusted } = useMemo(() => {
    const entered = calculateQuote({ type, bedrooms, bathrooms, sqft, extras, frequency });
    if (verifiedSqft) {
      const verified = calculateQuote({ type, bedrooms, bathrooms, sqft: verifiedSqft, extras, frequency });
      if (verified.total > entered.total) return { breakdown: verified, sqftAdjusted: true };
    }
    return { breakdown: entered, sqftAdjusted: false };
  }, [type, bedrooms, bathrooms, sqft, extras, frequency, verifiedSqft]);
  const deposit = Math.max(1, Math.round(breakdown.total * DEPOSIT_RATE));

  const dateString = date ? toDateString(date) : null;
  const availability = trpc.booking.availability.useQuery(
    { date: dateString ?? "" },
    { enabled: Boolean(dateString) }
  );

  const createBooking = trpc.booking.create.useMutation();
  const confirmBooking = trpc.booking.confirm.useMutation();

  // Handle Stripe return
  useEffect(() => {
    if (sessionId && refParam) {
      confirmBooking
        .mutateAsync({ sessionId, reference: refParam })
        .then(result => {
          if (result.confirmed) {
            setConfirmed({
              reference: result.booking.reference,
              serviceType: result.booking.serviceType,
              date: result.booking.date,
              time: result.booking.time,
              total: result.booking.total,
              deposit: result.booking.deposit,
              customerFirstName: result.booking.customerFirstName,
            });
          } else {
            toast.error(t.common.error);
          }
        })
        .catch(() => toast.error(t.common.error))
        .finally(() => setConfirming(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refParam]);

  useEffect(() => {
    if (cancelled) {
      toast.info(locale === "es" ? "Pago cancelado. Su reserva sigue guardada — puede intentarlo de nuevo." : "Payment cancelled. Your booking is saved — you can try again anytime.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelled]);

  const stepTitles = [
    t.booking.steps.service,
    t.booking.steps.datetime,
    t.booking.steps.extras,
    t.booking.steps.contact,
    t.booking.steps.review,
  ];
  const totalSteps = stepTitles.length;

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(Math.max(0, Math.min(totalSteps - 1, next)));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const validateStep = (): boolean => {
    if (step === 1) {
      if (!date) {
        toast.error(t.booking.validation.selectDate);
        return false;
      }
      if (!time) {
        toast.error(t.booking.validation.selectTime);
        return false;
      }
    }
    if (step === 3) {
      const errs: Record<string, string> = {};
      if (!form.firstName.trim()) errs.firstName = t.booking.validation.required;
      if (!form.lastName.trim()) errs.lastName = t.booking.validation.required;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errs.email = t.booking.validation.email;
      if (form.phone.trim().length < 7) errs.phone = t.booking.validation.phone;
      if (!form.address.trim()) errs.address = t.booking.validation.required;
      if (!form.city.trim()) errs.city = t.booking.validation.required;
      if (!form.zip.trim()) errs.zip = t.booking.validation.required;
      setErrors(errs);
      if (Object.keys(errs).length > 0) return false;
    }
    return true;
  };

  const handleNext = () => {
    if (!validateStep()) return;
    go(step + 1);
  };

  const handlePay = async () => {
    if (!date || !time) return;
    try {
      const result = await createBooking.mutateAsync({
        quote: { type, bedrooms, bathrooms, sqft, extras, frequency },
        date: toDateString(date),
        time,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        city: form.city.trim(),
        zip: form.zip.trim(),
        notes: form.notes.trim() || undefined,
        locale,
      });
      if (result.checkoutUrl) {
        toast.success(locale === "es" ? "Redirigiendo al pago seguro…" : "Redirecting to secure checkout…");
        window.location.href = result.checkoutUrl;
      }
    } catch {
      toast.error(t.common.error);
    }
  };

  const serviceEntries: { id: CleaningType; name: string }[] = [
    { id: "residential", name: t.services.residential.name },
    { id: "commercial", name: t.services.commercial.name },
    { id: "airbnb", name: t.services.airbnb.name },
    { id: "moveinout", name: t.services.moveinout.name },
    { id: "deep", name: t.services.deep.name },
    { id: "office", name: t.services.office.name },
  ];

  const frequencyLabels: Record<Frequency, string> = {
    onetime: t.pricing.onetime,
    weekly: t.pricing.weekly,
    biweekly: t.pricing.biweekly,
    monthly: t.pricing.monthly,
  };

  const serviceName = serviceEntries.find(s => s.id === type)?.name ?? type;
  const dateLocale = locale === "es" ? "es-MX" : "en-US";

  // ---------- Confirming spinner ----------
  if (confirming) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center pt-24">
        <div className="text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
          <p className="mt-4 text-muted-foreground">
            {locale === "es" ? "Confirmando su pago…" : "Confirming your payment…"}
          </p>
        </div>
      </div>
    );
  }

  // ---------- Confirmation screen ----------
  if (confirmed) {
    const confServiceName =
      serviceEntries.find(s => s.id === confirmed.serviceType)?.name ?? confirmed.serviceType;
    return (
      <div className="pt-28 pb-24 md:pt-36 md:pb-32">
        <div className="container max-w-2xl">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
            className="glass-card rounded-3xl p-8 text-center md:p-12"
          >
            <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-secondary/10">
              <PartyPopper className="h-10 w-10 text-secondary" />
            </span>
            <h1 className="mt-6 font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
              {t.booking.confirmedTitle}
            </h1>
            <p className="mt-3 text-muted-foreground">{t.booking.confirmedSubtitle}</p>

            <div className="mt-8 rounded-2xl bg-muted/60 p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {t.booking.reference}
              </p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-wider text-primary">{confirmed.reference}</p>
            </div>

            <div className="mt-6 grid gap-4 text-left sm:grid-cols-2">
              <div className="rounded-2xl border border-border p-4">
                <p className="text-xs text-muted-foreground">{t.booking.service}</p>
                <p className="mt-1 font-semibold text-foreground">{confServiceName}</p>
              </div>
              <div className="rounded-2xl border border-border p-4">
                <p className="text-xs text-muted-foreground">{t.booking.dateTime}</p>
                <p className="mt-1 font-semibold text-foreground">
                  {new Date(`${confirmed.date}T${confirmed.time}:00`).toLocaleString(dateLocale, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <div className="rounded-2xl border border-border p-4">
                <p className="text-xs text-muted-foreground">{t.booking.estimatedTotal}</p>
                <p className="mt-1 font-semibold text-foreground">${confirmed.total}</p>
              </div>
              <div className="rounded-2xl border border-border p-4">
                <p className="text-xs text-muted-foreground">{t.booking.depositDue}</p>
                <p className="mt-1 font-semibold text-secondary">${confirmed.deposit} ✓</p>
              </div>
            </div>

            <div className="mt-8 rounded-2xl bg-primary/5 p-6 text-left">
              <p className="font-semibold text-foreground">{t.booking.whatNext}</p>
              <ul className="mt-3 space-y-2.5">
                {[t.booking.next1, t.booking.next2, t.booking.next3].map((line, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <Button
              size="lg"
              onClick={() => navigate(path("home"))}
              className="btn-press mt-8 rounded-full px-8 font-semibold shadow-lg shadow-primary/25"
            >
              {t.booking.backHome}
            </Button>
          </motion.div>
        </div>
      </div>
    );
  }

  // ---------- Booking wizard ----------
  const morning = (availability.data ?? []).filter(s => Number(s.time.slice(0, 2)) < 12);
  const afternoon = (availability.data ?? []).filter(s => Number(s.time.slice(0, 2)) >= 12);

  return (
    <div className="pt-28 pb-24 md:pt-36 md:pb-32">
      <div className="container max-w-5xl">
        <div className="text-center">
          <h1 className="font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.booking.title}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground md:text-lg">{t.booking.subtitle}</p>
        </div>

        {/* Progress */}
        <div className="mx-auto mt-10 flex max-w-3xl items-center gap-2">
          {stepTitles.map((title, i) => (
            <button
              key={title}
              type="button"
              onClick={() => i < step && go(i)}
              className="group flex flex-1 flex-col items-center gap-2"
            >
              <span
                className={`h-1.5 w-full rounded-full transition-colors duration-300 ${
                  i <= step ? "bg-primary" : "bg-border"
                }`}
              />
              <span
                className={`hidden text-xs font-medium transition-colors md:block ${
                  i <= step ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {title}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_320px]">
          <div className="glass-card rounded-3xl p-6 md:p-10">
            <AnimatePresence mode="wait" custom={direction}>
              {/* Step 0: Service */}
              {step === 0 && (
                <motion.div
                  key="service"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.booking.serviceTitle}</h2>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {serviceEntries.map(svc => {
                      const Icon = SERVICE_ICONS[svc.id];
                      const active = type === svc.id;
                      return (
                        <button
                          key={svc.id}
                          type="button"
                          onClick={() => setType(svc.id)}
                          className={`flex items-center gap-4 rounded-2xl border-2 p-4 text-left transition-all duration-200 active:scale-[0.98] ${
                            active
                              ? "border-primary bg-primary/5 shadow-md shadow-primary/10"
                              : "border-border bg-card hover:border-primary/40"
                          }`}
                        >
                          <span
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors ${
                              active ? "bg-primary text-primary-foreground" : "bg-secondary/10 text-secondary"
                            }`}
                          >
                            <Icon className="h-5 w-5" />
                          </span>
                          <span className="font-semibold text-foreground">{svc.name}</span>
                          {active && <Check className="ml-auto h-5 w-5 text-primary" />}
                        </button>
                      );
                    })}
                  </div>
                  {/* Frequency inline */}
                  <h3 className="mt-8 font-display text-lg font-bold text-foreground">{t.booking.frequency}</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {VALID_FREQ.map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFrequency(f)}
                        className={`rounded-full border-2 px-5 py-2.5 text-sm font-semibold transition-all duration-150 active:scale-95 ${
                          frequency === f
                            ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                            : "border-border bg-card text-foreground hover:border-primary/40"
                        }`}
                      >
                        {frequencyLabels[f]}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Step 1: Date & time */}
              {step === 1 && (
                <motion.div
                  key="datetime"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.booking.datetimeTitle}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{t.booking.datetimeSubtitle}</p>
                  <div className="mt-6 grid gap-8 md:grid-cols-2">
                    <div className="flex justify-center rounded-2xl border border-border p-2">
                      <Calendar
                        mode="single"
                        selected={date}
                        onSelect={d => {
                          setDate(d);
                          setTime(null);
                        }}
                        disabled={{ before: new Date(Date.now() + 24 * 3600 * 1000) }}
                      />
                    </div>
                    <div>
                      {!date && (
                        <div className="flex h-full min-h-40 items-center justify-center rounded-2xl bg-muted/40 text-sm text-muted-foreground">
                          <CalendarDays className="mr-2 h-4 w-4" /> {t.booking.validation.selectDate}
                        </div>
                      )}
                      {date && availability.isLoading && (
                        <div className="flex h-full min-h-40 items-center justify-center">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        </div>
                      )}
                      {date && availability.data && (
                        <div className="space-y-5">
                          <div>
                            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                              <Clock className="h-4 w-4 text-primary" /> {t.booking.morningSlots}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              {morning.map(slot => (
                                <button
                                  key={slot.time}
                                  type="button"
                                  disabled={!slot.available}
                                  onClick={() => setTime(slot.time)}
                                  className={`h-11 rounded-xl border-2 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 ${
                                    time === slot.time
                                      ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                      : "border-border bg-card text-foreground hover:border-primary/40"
                                  }`}
                                >
                                  {slot.time}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                              <Clock className="h-4 w-4 text-primary" /> {t.booking.afternoonSlots}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              {afternoon.map(slot => (
                                <button
                                  key={slot.time}
                                  type="button"
                                  disabled={!slot.available}
                                  onClick={() => setTime(slot.time)}
                                  className={`h-11 rounded-xl border-2 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 ${
                                    time === slot.time
                                      ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                      : "border-border bg-card text-foreground hover:border-primary/40"
                                  }`}
                                >
                                  {slot.time}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Step 2: Extras */}
              {step === 2 && (
                <motion.div
                  key="extras"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.booking.extrasTitle}</h2>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {ALL_EXTRAS.map(id => {
                      const active = extras.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() =>
                            setExtras(prev => (prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id]))
                          }
                          className={`relative flex items-center gap-3 rounded-2xl border-2 p-4 text-left transition-all duration-200 active:scale-[0.97] ${
                            active
                              ? "border-primary bg-primary/5 shadow-md shadow-primary/10"
                              : "border-border bg-card hover:border-primary/40"
                          }`}
                        >
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                              active ? "border-primary bg-primary text-primary-foreground" : "border-border"
                            }`}
                          >
                            {active && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <span className="text-sm font-semibold text-foreground">{t.extras[id]}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {/* Step 3: Contact */}
              {step === 3 && (
                <motion.div
                  key="contact"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.booking.contactTitle}</h2>
                  <div className="mt-6 grid gap-5 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="firstName" className="flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-primary" /> {t.booking.firstName}
                      </Label>
                      <Input
                        id="firstName"
                        className="mt-2 h-12 rounded-xl"
                        value={form.firstName}
                        onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                      />
                      {errors.firstName && <p className="mt-1 text-xs text-destructive">{errors.firstName}</p>}
                    </div>
                    <div>
                      <Label htmlFor="lastName">{t.booking.lastName}</Label>
                      <Input
                        id="lastName"
                        className="mt-2 h-12 rounded-xl"
                        value={form.lastName}
                        onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                      />
                      {errors.lastName && <p className="mt-1 text-xs text-destructive">{errors.lastName}</p>}
                    </div>
                    <div>
                      <Label htmlFor="email" className="flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 text-primary" /> {t.booking.email}
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        className="mt-2 h-12 rounded-xl"
                        value={form.email}
                        onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      />
                      {errors.email && <p className="mt-1 text-xs text-destructive">{errors.email}</p>}
                    </div>
                    <div>
                      <Label htmlFor="phone" className="flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-primary" /> {t.booking.phone}
                      </Label>
                      <Input
                        id="phone"
                        type="tel"
                        className="mt-2 h-12 rounded-xl"
                        value={form.phone}
                        onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                      />
                      {errors.phone && <p className="mt-1 text-xs text-destructive">{errors.phone}</p>}
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="address" className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-primary" /> {t.booking.address}
                      </Label>
                      <Input
                        id="address"
                        className="mt-2 h-12 rounded-xl"
                        value={form.address}
                        onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                      />
                      {errors.address && <p className="mt-1 text-xs text-destructive">{errors.address}</p>}
                      {debouncedAddress.trim().length >= 6 && propertyLookup.isFetching && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {locale === "es"
                            ? "Verificando la propiedad en registros públicos…"
                            : "Verifying property against public records…"}
                        </p>
                      )}
                      {verifiedSqft && !propertyLookup.isFetching && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-secondary">
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                          {locale === "es"
                            ? `Propiedad verificada: ${verifiedSqft.toLocaleString()} pies² según registros del condado.`
                            : `Property verified: ${verifiedSqft.toLocaleString()} sq ft per county records.`}
                        </p>
                      )}
                      {addressVerifiedCounty && !propertyLookup.isFetching && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-secondary">
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                          {locale === "es"
                            ? `Dirección verificada en los registros del condado de ${addressVerifiedCounty}. Los pies cuadrados se confirmarán en su cita.`
                            : `Address verified in ${addressVerifiedCounty} County records. Square footage will be confirmed at your appointment.`}
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {locale === "es"
                          ? "Los precios se verifican con registros públicos de la propiedad; el total se ajusta si los pies cuadrados no coinciden."
                          : "Quotes are verified against public property records; the total adjusts if the square footage doesn't match."}
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="city">{t.booking.city}</Label>
                      <Input
                        id="city"
                        className="mt-2 h-12 rounded-xl"
                        value={form.city}
                        onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                      />
                      {errors.city && <p className="mt-1 text-xs text-destructive">{errors.city}</p>}
                    </div>
                    <div>
                      <Label htmlFor="zip">{t.booking.zip}</Label>
                      <Input
                        id="zip"
                        className="mt-2 h-12 rounded-xl"
                        value={form.zip}
                        onChange={e => setForm(f => ({ ...f, zip: e.target.value }))}
                      />
                      {errors.zip && <p className="mt-1 text-xs text-destructive">{errors.zip}</p>}
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="notes">
                        {t.booking.notes} <span className="text-muted-foreground">({t.common.optional})</span>
                      </Label>
                      <Textarea
                        id="notes"
                        rows={3}
                        className="mt-2 rounded-xl"
                        placeholder={t.booking.notesPlaceholder}
                        value={form.notes}
                        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                      />
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Step 4: Review & deposit */}
              {step === 4 && (
                <motion.div
                  key="review"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.booking.reviewTitle}</h2>
                  <div className="mt-6 space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="rounded-2xl border border-border p-4">
                        <p className="text-xs text-muted-foreground">{t.booking.service}</p>
                        <p className="mt-1 font-semibold text-foreground">{serviceName}</p>
                        <p className="text-sm text-muted-foreground">{frequencyLabels[frequency]}</p>
                      </div>
                      <div className="rounded-2xl border border-border p-4">
                        <p className="text-xs text-muted-foreground">{t.booking.dateTime}</p>
                        <p className="mt-1 font-semibold text-foreground">
                          {date?.toLocaleDateString(dateLocale, { weekday: "long", month: "long", day: "numeric" })}
                        </p>
                        <p className="text-sm text-muted-foreground">{time}</p>
                      </div>
                      <div className="rounded-2xl border border-border p-4">
                        <p className="text-xs text-muted-foreground">{t.booking.extras}</p>
                        <p className="mt-1 text-sm font-medium text-foreground">
                          {extras.length > 0 ? extras.map(e => t.extras[e]).join(", ") : t.booking.none}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border p-4">
                        <p className="text-xs text-muted-foreground">{t.booking.contactInfo}</p>
                        <p className="mt-1 text-sm font-medium text-foreground">
                          {form.firstName} {form.lastName}
                        </p>
                        <p className="text-sm text-muted-foreground">{form.email}</p>
                        <p className="text-sm text-muted-foreground">
                          {form.address}, {form.city} {form.zip}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-muted/60 p-6">
                      {sqftAdjusted && verifiedSqft && (
                        <div className="mb-4 flex items-start gap-2 rounded-xl bg-primary/10 p-3 text-xs leading-relaxed text-foreground">
                          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <span>
                            {locale === "es"
                              ? `El precio se actualizó según los ${verifiedSqft.toLocaleString()} pies² verificados en los registros públicos del condado.`
                              : `Price updated based on the verified ${verifiedSqft.toLocaleString()} sq ft from public county records.`}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t.booking.estimatedTotal}</span>
                        <span className="font-display text-xl font-bold text-foreground">${breakdown.total}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="font-semibold text-foreground">{t.booking.depositDue} (20%)</span>
                        <span className="font-display text-2xl font-extrabold text-primary">${deposit}</span>
                      </div>
                      <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
                        {t.booking.depositNote}
                      </p>
                    </div>

                    <Button
                      size="lg"
                      onClick={handlePay}
                      disabled={createBooking.isPending}
                      className="btn-press h-14 w-full rounded-full text-base font-semibold shadow-lg shadow-primary/25"
                    >
                      {createBooking.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t.booking.processing}
                        </>
                      ) : (
                        <>
                          {t.booking.payDeposit} — ${deposit}
                        </>
                      )}
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                      {locale === "es"
                        ? "Pago seguro procesado por Stripe. No almacenamos los datos de su tarjeta."
                        : "Secure payment processed by Stripe. We never store your card details."}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {step < 4 && (
              <div className="mt-10 flex items-center justify-between border-t border-border pt-6">
                <Button
                  variant="ghost"
                  onClick={() => go(step - 1)}
                  disabled={step === 0}
                  className="btn-press rounded-full px-5"
                >
                  <ChevronLeft className="mr-1 h-4 w-4" /> {t.common.back}
                </Button>
                <Button
                  onClick={handleNext}
                  className="btn-press rounded-full px-8 font-semibold shadow-md shadow-primary/20"
                >
                  {t.common.next} <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Sticky summary */}
          <aside className="lg:sticky lg:top-28 lg:self-start">
            <div className="rounded-3xl bg-foreground p-7 text-background shadow-2xl">
              <p className="text-xs font-semibold uppercase tracking-widest text-background/60">
                {t.booking.estimatedTotal}
              </p>
              <div className="mt-3 font-display text-5xl font-extrabold tracking-tight">
                <AnimatedPrice value={breakdown.total} />
              </div>
              <p className="mt-1 text-sm text-background/60">{t.quote.perCleaning}</p>
              <div className="mt-6 space-y-2.5 border-t border-background/15 pt-5 text-sm">
                <div className="flex justify-between">
                  <span className="text-background/60">{t.booking.service}</span>
                  <span className="font-medium">{serviceName}</span>
                </div>
                {date && time && (
                  <div className="flex justify-between">
                    <span className="text-background/60">{t.booking.dateTime}</span>
                    <span className="font-medium">
                      {date.toLocaleDateString(dateLocale, { month: "short", day: "numeric" })} · {time}
                    </span>
                  </div>
                )}
                {extras.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-background/60">{t.booking.extras}</span>
                    <span className="font-medium">{extras.length}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-background/15 pt-2.5">
                  <span className="text-background/60">{t.booking.depositDue}</span>
                  <span className="font-bold text-primary-foreground">${deposit}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
