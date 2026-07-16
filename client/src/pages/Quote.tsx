import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bath,
  BedDouble,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Dog,
  Home as HomeIcon,
  KeyRound,
  Layers,
  Loader2,
  MapPin,
  Microwave,
  PackageOpen,
  Refrigerator,
  Ruler,
  ShieldCheck,
  Shirt,
  Sparkles,
  SprayCan,
  Warehouse,
  AppWindow,
  CalendarRange,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo } from "@/hooks/useSeo";
import { AnimatedPrice } from "@/components/AnimatedPrice";
import { trpc } from "@/lib/trpc";
import {
  calculateQuote,
  type CleaningType,
  type ExtraId,
  type Frequency,
  FREQUENCY_DISCOUNTS,
} from "@shared/pricing";

const SERVICE_ICONS: Record<CleaningType, typeof HomeIcon> = {
  residential: HomeIcon,
  commercial: Building2,
  airbnb: KeyRound,
  moveinout: PackageOpen,
  deep: Sparkles,
  office: Briefcase,
};

const EXTRA_ICONS: Record<ExtraId, typeof Dog> = {
  pets: Dog,
  deepClean: SprayCan,
  moveOut: PackageOpen,
  oven: Microwave,
  refrigerator: Refrigerator,
  windows: AppWindow,
  laundry: Shirt,
  garage: Warehouse,
  organization: Layers,
};

const EXTRA_IDS: ExtraId[] = [
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

const FREQUENCIES: Frequency[] = ["onetime", "weekly", "biweekly", "monthly"];

const stepVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 32 : -32 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -32 : 32 }),
};

export default function Quote() {
  const { t, locale, path } = useLocale();
  const [, navigate] = useLocation();
  useSeo({ title: t.meta.quote.title, description: t.meta.quote.description });

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [type, setType] = useState<CleaningType>("residential");
  const [bedrooms, setBedrooms] = useState(2);
  const [bathrooms, setBathrooms] = useState(1);
  const [sqft, setSqft] = useState(1200);
  const [extras, setExtras] = useState<ExtraId[]>([]);
  const [frequency, setFrequency] = useState<Frequency>("onetime");
  // Optional address — verifies sqft against public county records and locks the slider to it.
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [debouncedAddress, setDebouncedAddress] = useState("");
  const [debouncedCity, setDebouncedCity] = useState("");
  const [debouncedZip, setDebouncedZip] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAddress(address);
      setDebouncedCity(city);
      setDebouncedZip(zip);
    }, 800);
    return () => clearTimeout(timer);
  }, [address, city, zip]);
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
  // Auto-fill the slider from the verified record.
  useEffect(() => {
    if (verifiedSqft) setSqft(Math.min(10000, Math.max(200, verifiedSqft)));
  }, [verifiedSqft]);

  const breakdown = useMemo(
    () => calculateQuote({ type, bedrooms, bathrooms, sqft, extras, frequency }),
    [type, bedrooms, bathrooms, sqft, extras, frequency]
  );

  const stepTitles = [t.quote.steps.type, t.quote.steps.details, t.quote.steps.extras, t.quote.steps.frequency, t.quote.steps.result];
  const totalSteps = stepTitles.length;

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(Math.max(0, Math.min(totalSteps - 1, next)));
  };

  const toggleExtra = (id: ExtraId) =>
    setExtras(prev => (prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id]));

  const serviceEntries: { id: CleaningType; name: string; short: string }[] = [
    { id: "residential", name: t.services.residential.name, short: t.services.residential.short },
    { id: "commercial", name: t.services.commercial.name, short: t.services.commercial.short },
    { id: "airbnb", name: t.services.airbnb.name, short: t.services.airbnb.short },
    { id: "moveinout", name: t.services.moveinout.name, short: t.services.moveinout.short },
    { id: "deep", name: t.services.deep.name, short: t.services.deep.short },
    { id: "office", name: t.services.office.name, short: t.services.office.short },
  ];

  const frequencyLabels: Record<Frequency, string> = {
    onetime: t.pricing.onetime,
    weekly: t.pricing.weekly,
    biweekly: t.pricing.biweekly,
    monthly: t.pricing.monthly,
  };

  const frequencyBadges: Record<Frequency, string | null> = {
    onetime: null,
    weekly: t.pricing.weeklyDiscount,
    biweekly: t.pricing.biweeklyDiscount,
    monthly: t.pricing.monthlyDiscount,
  };

  const goToBooking = () => {
    const params = new URLSearchParams({
      type,
      bedrooms: String(bedrooms),
      bathrooms: String(bathrooms),
      sqft: String(sqft),
      extras: extras.join(","),
      frequency,
    });
    if (address.trim()) params.set("address", address.trim());
    if (city.trim()) params.set("city", city.trim());
    if (zip.trim()) params.set("zip", zip.trim());
    navigate(`${path("booking")}?${params.toString()}`);
  };

  return (
    <div className="pt-28 pb-24 md:pt-36 md:pb-32">
      <div className="container max-w-5xl">
        {/* Header */}
        <div className="text-center">
          <h1 className="font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.quote.title}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground md:text-lg">{t.quote.subtitle}</p>
        </div>

        {/* Progress */}
        <div className="mx-auto mt-10 flex max-w-2xl items-center gap-2">
          {stepTitles.map((title, i) => (
            <button
              key={title}
              type="button"
              onClick={() => i < step && go(i)}
              className="group flex flex-1 flex-col items-center gap-2"
              aria-label={`${t.quote.step} ${i + 1} ${t.quote.of} ${totalSteps}: ${title}`}
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
          {/* Wizard steps */}
          <div className="glass-card rounded-3xl p-6 md:p-10">
            <AnimatePresence mode="wait" custom={direction}>
              {step === 0 && (
                <motion.div
                  key="type"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.quote.typeTitle}</h2>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {serviceEntries.map(svc => {
                      const Icon = SERVICE_ICONS[svc.id];
                      const active = type === svc.id;
                      return (
                        <button
                          key={svc.id}
                          type="button"
                          onClick={() => setType(svc.id)}
                          className={`flex items-start gap-4 rounded-2xl border-2 p-4 text-left transition-all duration-200 active:scale-[0.98] ${
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
                          <span>
                            <span className="block font-semibold text-foreground">{svc.name}</span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{svc.short}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {step === 1 && (
                <motion.div
                  key="details"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.quote.detailsTitle}</h2>
                  <div className="mt-8 space-y-10">
                    {/* Bedrooms */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 font-medium text-foreground">
                          <BedDouble className="h-5 w-5 text-primary" /> {t.quote.bedrooms}
                        </label>
                        <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">{bedrooms}</span>
                      </div>
                      <div className="mt-4 flex gap-2">
                        {[0, 1, 2, 3, 4, 5, 6].map(n => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setBedrooms(n)}
                            className={`h-11 flex-1 rounded-xl border-2 text-sm font-semibold transition-all duration-150 active:scale-95 ${
                              bedrooms === n
                                ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                : "border-border bg-card text-foreground hover:border-primary/40"
                            }`}
                          >
                            {n === 6 ? "6+" : n}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Bathrooms */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 font-medium text-foreground">
                          <Bath className="h-5 w-5 text-primary" /> {t.quote.bathrooms}
                        </label>
                        <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">{bathrooms}</span>
                      </div>
                      <div className="mt-4 flex gap-2">
                        {[1, 2, 3, 4, 5].map(n => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setBathrooms(n)}
                            className={`h-11 flex-1 rounded-xl border-2 text-sm font-semibold transition-all duration-150 active:scale-95 ${
                              bathrooms === n
                                ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20"
                                : "border-border bg-card text-foreground hover:border-primary/40"
                            }`}
                          >
                            {n === 5 ? "5+" : n}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Square footage */}
                    <div>
                      {/* Address-based verification (optional) */}
                      <div className="mb-6">
                        <label className="flex items-center gap-2 font-medium text-foreground" htmlFor="quote-address">
                          <MapPin className="h-5 w-5 text-primary" /> {locale === "es" ? "Dirección (opcional)" : "Address (optional)"}
                        </label>
                        <div className="mt-3 flex flex-wrap gap-3">
                          <Input
                            id="quote-address"
                            className="h-12 w-full min-w-[200px] flex-1 rounded-xl sm:w-auto"
                            placeholder={locale === "es" ? "Ej. 5500 Grand Lake Dr" : "e.g. 5500 Grand Lake Dr"}
                            value={address}
                            onChange={e => setAddress(e.target.value)}
                          />
                          <Input
                            id="quote-city"
                            className="h-12 w-[calc(60%-0.375rem)] rounded-xl sm:w-36"
                            placeholder={locale === "es" ? "Ciudad" : "City"}
                            value={city}
                            onChange={e => setCity(e.target.value)}
                          />
                          <Input
                            id="quote-zip"
                            className="h-12 w-[calc(40%-0.375rem)] rounded-xl sm:w-28"
                            placeholder={locale === "es" ? "C.P." : "ZIP"}
                            inputMode="numeric"
                            maxLength={10}
                            value={zip}
                            onChange={e => setZip(e.target.value)}
                          />
                        </div>
                        {debouncedAddress.trim().length >= 6 && propertyLookup.isFetching && (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {locale === "es"
                              ? "Buscando en registros públicos del condado…"
                              : "Checking public county records…"}
                          </p>
                        )}
                        {verifiedSqft && !propertyLookup.isFetching && (
                          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-secondary">
                            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                            {locale === "es"
                              ? `Verificado: ${verifiedSqft.toLocaleString()} pies² según registros del condado — aplicado abajo.`
                              : `Verified: ${verifiedSqft.toLocaleString()} sq ft per county records — applied below.`}
                          </p>
                        )}
                        {!verifiedSqft &&
                          !propertyLookup.isFetching &&
                          propertyLookup.data?.reason === "outside_coverage" && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              {locale === "es"
                                ? "Esta dirección está fuera de nuestra zona de verificación automática — su cotización usa el tamaño ingresado y se confirmará en la cita."
                                : "This address is outside our automatic verification area — your quote uses the size you enter and will be confirmed at your appointment."}
                            </p>
                          )}
                        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                          {locale === "es"
                            ? "Ingrese su dirección para verificar los pies cuadrados automáticamente. Las cotizaciones se confirman con registros públicos."
                            : "Enter your address to verify square footage automatically. Quotes are confirmed against public records."}
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 font-medium text-foreground">
                          <Ruler className="h-5 w-5 text-primary" /> {t.quote.sqft}
                        </label>
                        <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">
                          {verifiedSqft ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
                          {sqft.toLocaleString()} ft²
                        </span>
                      </div>
                      <Slider
                        className="mt-5"
                        min={400}
                        max={6000}
                        step={100}
                        value={[sqft]}
                        onValueChange={([v]) => setSqft(v)}
                        disabled={Boolean(verifiedSqft)}
                      />
                      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                        <span>400 ft²</span>
                        <span>6,000+ ft²</span>
                      </div>
                      {verifiedSqft && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {locale === "es"
                            ? "El tamaño se fijó según el registro verificado. Borre la dirección para ajustarlo manualmente."
                            : "Size locked to the verified record. Clear the address to adjust manually."}
                        </p>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

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
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.quote.extrasTitle}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{t.quote.extrasSubtitle}</p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {EXTRA_IDS.map(id => {
                      const Icon = EXTRA_ICONS[id];
                      const active = extras.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => toggleExtra(id)}
                          className={`relative flex flex-col items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all duration-200 active:scale-[0.97] ${
                            active
                              ? "border-primary bg-primary/5 shadow-md shadow-primary/10"
                              : "border-border bg-card hover:border-primary/40"
                          }`}
                        >
                          {active && (
                            <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                          <span
                            className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                              active ? "bg-primary text-primary-foreground" : "bg-secondary/10 text-secondary"
                            }`}
                          >
                            <Icon className="h-5 w-5" />
                          </span>
                          <span className="text-sm font-semibold text-foreground">{t.extras[id]}</span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div
                  key="frequency"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.quote.frequencyTitle}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{t.quote.frequencySubtitle}</p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {FREQUENCIES.map(f => {
                      const active = frequency === f;
                      const badge = frequencyBadges[f];
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setFrequency(f)}
                          className={`relative flex items-center justify-between rounded-2xl border-2 p-5 text-left transition-all duration-200 active:scale-[0.98] ${
                            active
                              ? "border-primary bg-primary/5 shadow-md shadow-primary/10"
                              : "border-border bg-card hover:border-primary/40"
                          }`}
                        >
                          <span className="flex items-center gap-3">
                            <CalendarRange className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground"}`} />
                            <span className="font-semibold text-foreground">{frequencyLabels[f]}</span>
                          </span>
                          {badge && (
                            <span className="rounded-full bg-secondary/10 px-3 py-1 text-xs font-bold text-secondary">
                              {badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {step === 4 && (
                <motion.div
                  key="result"
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                  className="text-center"
                >
                  <h2 className="font-display text-2xl font-bold text-foreground">{t.quote.resultTitle}</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t.quote.resultSubtitle}</p>
                  <div className="mx-auto mt-8 max-w-sm rounded-3xl bg-gradient-to-br from-primary/10 via-card to-secondary/10 p-8 shadow-xl shadow-primary/5 ring-1 ring-border">
                    {breakdown.customQuote ? (
                      <>
                        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                          {t.pricing.customQuote}
                        </p>
                        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{t.quote.customQuoteText}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                          {t.quote.estimateLabel}
                        </p>
                        {breakdown.startingAt && (
                          <p className="mt-1 text-xs font-semibold text-primary">{t.pricing.startingAt}</p>
                        )}
                        <div className="mt-2 font-display text-6xl font-extrabold tracking-tight text-foreground">
                          <AnimatedPrice value={breakdown.total} />
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{t.quote.perCleaning}</p>
                        {breakdown.discount > 0 && (
                          <p className="mt-3 inline-block rounded-full bg-secondary/10 px-4 py-1.5 text-sm font-bold text-secondary">
                            {t.quote.savings} ${breakdown.discount}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                    {breakdown.customQuote ? (
                      <Button
                        size="lg"
                        onClick={() => navigate(path("contact"))}
                        className="btn-press h-13 rounded-full px-8 text-base font-semibold shadow-lg shadow-primary/25"
                      >
                        {t.common.contactUs} <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="lg"
                        onClick={goToBooking}
                        className="btn-press h-13 rounded-full px-8 text-base font-semibold shadow-lg shadow-primary/25"
                      >
                        {t.quote.bookCta} <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="lg"
                      variant="outline"
                      onClick={() => go(0)}
                      className="btn-press h-13 rounded-full border-2 px-8 text-base font-semibold"
                    >
                      {t.quote.adjustCta}
                    </Button>
                  </div>
                  <p className="mt-6 text-xs text-muted-foreground">{t.quote.disclaimer}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Nav buttons */}
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
                  onClick={() => go(step + 1)}
                  className="btn-press rounded-full px-8 font-semibold shadow-md shadow-primary/20"
                >
                  {t.common.next} <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Live estimate sidebar */}
          <aside className="lg:sticky lg:top-28 lg:self-start">
            <div className="rounded-3xl bg-foreground p-7 text-background shadow-2xl">
              <p className="text-xs font-semibold uppercase tracking-widest text-background/60">{t.quote.estimateLabel}</p>
              {breakdown.customQuote ? (
                <div className="mt-3 font-display text-3xl font-extrabold tracking-tight">{t.pricing.customQuote}</div>
              ) : (
                <>
                  {breakdown.startingAt && (
                    <p className="mt-2 text-xs font-semibold text-background/70">{t.pricing.startingAt}</p>
                  )}
                  <div className="mt-1 font-display text-5xl font-extrabold tracking-tight">
                    <AnimatedPrice value={breakdown.total} />
                  </div>
                  <p className="mt-1 text-sm text-background/60">{t.quote.perCleaning}</p>
                </>
              )}
              <div className="mt-6 space-y-2.5 border-t border-background/15 pt-5 text-sm">
                <div className="flex justify-between">
                  <span className="text-background/60">{t.quote.steps.type}</span>
                  <span className="font-medium">${breakdown.base}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-background/60">
                    {bedrooms} {t.quote.bedrooms.toLowerCase()} · {bathrooms} {t.quote.bathrooms.toLowerCase()} · {sqft.toLocaleString()} ft²
                  </span>
                  <span className="font-medium text-background/60">✓</span>
                </div>
                {breakdown.sqftCharge > 0 && (
                  <div className="flex justify-between">
                    <span className="text-background/60">{sqft.toLocaleString()} ft²</span>
                    <span className="font-medium">${breakdown.sqftCharge}</span>
                  </div>
                )}
                {breakdown.extrasTotal > 0 && (
                  <div className="flex justify-between">
                    <span className="text-background/60">
                      {t.quote.steps.extras} ({extras.length})
                    </span>
                    <span className="font-medium">${breakdown.extrasTotal}</span>
                  </div>
                )}
                {breakdown.discount > 0 && (
                  <div className="flex justify-between text-emerald-400">
                    <span>{frequencyLabels[frequency]} · {Math.round(FREQUENCY_DISCOUNTS[frequency] * 100)}%</span>
                    <span className="font-medium">−${breakdown.discount}</span>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
