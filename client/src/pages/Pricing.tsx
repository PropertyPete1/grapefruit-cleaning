import { Link } from "wouter";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { AnimatedPrice } from "@/components/AnimatedPrice";
import {
  BASE_PRICES,
  EXTRA_PRICES,
  FREQUENCY_DISCOUNTS,
  PER_BATHROOM,
  PER_BEDROOM,
  type CleaningType,
  type ExtraId,
  type Frequency,
} from "@shared/pricing";
import { cn } from "@/lib/utils";

const PLAN_ORDER: { id: CleaningType; planKey: "residential" | "deep" | "moveinout" | "airbnb" | "office" }[] = [
  { id: "residential", planKey: "residential" },
  { id: "deep", planKey: "deep" },
  { id: "moveinout", planKey: "moveinout" },
  { id: "airbnb", planKey: "airbnb" },
  { id: "office", planKey: "office" },
];

const EXTRA_IDS: ExtraId[] = ["pets", "deepClean", "moveOut", "oven", "refrigerator", "windows", "laundry", "garage", "organization"];

export default function Pricing() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.pricing.title, description: t.meta.pricing.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);
  const [frequency, setFrequency] = useState<Frequency>("biweekly");

  const freqTabs: { id: Frequency; label: string; discount: string | null }[] = [
    { id: "onetime", label: t.pricing.onetime, discount: null },
    { id: "monthly", label: t.pricing.monthly, discount: t.pricing.monthlyDiscount },
    { id: "biweekly", label: t.pricing.biweekly, discount: t.pricing.biweeklyDiscount },
    { id: "weekly", label: t.pricing.weekly, discount: t.pricing.weeklyDiscount },
  ];

  const discountRate = FREQUENCY_DISCOUNTS[frequency];

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 left-1/4 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.pricing.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.pricing.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-20 md:pb-28">
        {/* Frequency toggle */}
        <div className="reveal mx-auto flex max-w-fit flex-wrap justify-center gap-1 rounded-full border border-border bg-card p-1.5 shadow-soft">
          {freqTabs.map((f) => (
            <button
              key={f.id}
              onClick={() => setFrequency(f.id)}
              className={cn(
                "press relative rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 sm:px-5",
                frequency === f.id ? "bg-primary text-primary-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              {f.discount && (
                <span
                  className={cn(
                    "ml-1.5 hidden text-[10px] font-bold sm:inline",
                    frequency === f.id ? "text-primary-foreground/90" : "text-secondary",
                  )}
                >
                  {f.discount}
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="reveal mt-3 text-center text-xs text-muted-foreground" style={{ transitionDelay: "60ms" }}>
          {t.pricing.frequencyTitle}
        </p>

        {/* Plans */}
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {PLAN_ORDER.map((plan, i) => {
            const planCopy = t.pricing.plans[plan.planKey];
            const base = BASE_PRICES[plan.id];
            const discounted = Math.round(base * (1 - discountRate));
            const popular = plan.id === "residential";
            return (
              <div
                key={plan.id}
                className={cn(
                  "reveal hover-lift relative flex flex-col rounded-3xl border bg-card p-6 shadow-soft",
                  popular ? "border-primary/40 ring-2 ring-primary/20" : "border-border",
                )}
                style={{ transitionDelay: `${i * 60}ms` }}
              >
                {popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-primary-foreground shadow-soft">
                    {t.common.mostPopular}
                  </span>
                )}
                <h2 className="font-display text-base font-bold text-foreground">{planCopy.name}</h2>
                <p className="mt-1 min-h-[2.5rem] text-xs leading-relaxed text-muted-foreground">{planCopy.desc}</p>
                <div className="mt-4">
                  <p className="text-xs font-medium text-muted-foreground">{t.pricing.startingAt}</p>
                  <p className="font-display text-3xl font-extrabold text-foreground">
                    <AnimatedPrice value={discounted} />
                  </p>
                  {discountRate > 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <s>${base}</s>{" "}
                      <span className="font-semibold text-secondary">
                        −{Math.round(discountRate * 100)}%
                      </span>
                    </p>
                  )}
                </div>
                <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5 shrink-0 text-secondary" />
                    +${PER_BEDROOM} {t.pricing.perBedroom}
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5 shrink-0 text-secondary" />
                    +${PER_BATHROOM} {t.pricing.perBathroom}
                  </li>
                </ul>
                <Button asChild size="sm" variant={popular ? "default" : "outline"} className="press mt-5 w-full rounded-full">
                  <Link href={path("quote")}>{t.nav.getQuote}</Link>
                </Button>
              </div>
            );
          })}
        </div>

        <p className="reveal mx-auto mt-8 max-w-xl text-center text-xs leading-relaxed text-muted-foreground">{t.pricing.note}</p>
      </section>

      <section className="bg-card py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground">
              {t.pricing.extrasTitle}
            </h2>
            <p className="reveal mt-3 text-muted-foreground" style={{ transitionDelay: "70ms" }}>
              {t.pricing.extrasSubtitle}
            </p>
          </div>
          <div className="mx-auto mt-10 grid max-w-4xl grid-cols-2 gap-4 sm:grid-cols-3">
            {EXTRA_IDS.map((id, i) => (
              <div
                key={id}
                className="reveal hover-lift rounded-2xl border border-border bg-background p-5 text-center shadow-soft"
                style={{ transitionDelay: `${(i % 3) * 60}ms` }}
              >
                <p className="text-sm font-semibold text-foreground">{t.extras[id]}</p>
                <p className="mt-1 text-sm font-bold text-primary">+${EXTRA_PRICES[id]}</p>
              </div>
            ))}
          </div>
          <div className="reveal mt-12 text-center">
            <Button asChild size="lg" className="press rounded-full px-8 shadow-soft-lg">
              <Link href={path("quote")}>
                <Sparkles className="mr-1 h-4 w-4" />
                {t.pricing.quoteCta}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
