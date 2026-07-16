import { Link } from "wouter";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { usePricing } from "@/hooks/usePricing";
import { AnimatedPrice } from "@/components/AnimatedPrice";
import {
  type CleaningType,
  type ExtraId,
  type Frequency,
  type PricingTier,
  type TieredType,
} from "@shared/pricing";
import { cn } from "@/lib/utils";

const TIER_SERVICES: { id: CleaningType & TieredType; planKey: "residential" | "deep" | "moveinout" }[] = [
  { id: "residential", planKey: "residential" },
  { id: "deep", planKey: "deep" },
  { id: "moveinout", planKey: "moveinout" },
];

const EXTRA_IDS: ExtraId[] = ["pets", "deepClean", "moveOut", "oven", "refrigerator", "windows", "laundry", "garage", "organization"];

function formatTierRange(
  tier: PricingTier,
  prev: PricingTier | undefined,
  t: { under: string; over: string; sqft: string },
): string {
  if (!prev) return `${t.under} 1,000 ${t.sqft}`;
  if (tier.maxSqft === Infinity) return `${t.over} ${prev.maxSqft.toLocaleString("en-US")} ${t.sqft}`;
  return `${prev.maxSqft.toLocaleString("en-US")}–${tier.maxSqft.toLocaleString("en-US")} ${t.sqft}`;
}

export default function Pricing() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.pricing.title, description: t.meta.pricing.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);
  const [frequency, setFrequency] = useState<Frequency>("biweekly");
  const pricing = usePricing();

  const freqTabs: { id: Frequency; label: string; discount: string | null }[] = [
    { id: "onetime", label: t.pricing.onetime, discount: null },
    { id: "monthly", label: t.pricing.monthly, discount: t.pricing.monthlyDiscount },
    { id: "biweekly", label: t.pricing.biweekly, discount: t.pricing.biweeklyDiscount },
    { id: "weekly", label: t.pricing.weekly, discount: t.pricing.weeklyDiscount },
  ];

  const discountRate = pricing.frequencyDiscounts[frequency];

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

        {/* Fixed tier tables */}
        <div className="mx-auto mt-12 max-w-2xl text-center">
          <h2 className="reveal font-display text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">
            {t.pricing.tierTablesTitle}
          </h2>
          <p className="reveal mt-3 text-sm text-muted-foreground" style={{ transitionDelay: "60ms" }}>
            {t.pricing.tierTablesSubtitle}
          </p>
        </div>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {TIER_SERVICES.map((svc, i) => {
            const planCopy = t.pricing.plans[svc.planKey];
            const tiers = pricing.tiers[svc.id] ?? [];
            const popular = svc.id === "residential";
            return (
              <div
                key={svc.id}
                className={cn(
                  "reveal hover-lift relative flex flex-col overflow-hidden rounded-3xl border bg-card shadow-soft",
                  popular ? "border-primary/40 ring-2 ring-primary/20" : "border-border",
                )}
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                {popular && (
                  <span className="absolute right-4 top-4 rounded-full bg-primary px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-primary-foreground shadow-soft">
                    {t.common.mostPopular}
                  </span>
                )}
                <div className="p-6 pb-4">
                  <h3 className="font-display text-lg font-bold text-foreground">{planCopy.name}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{planCopy.desc}</p>
                </div>
                <div className="flex-1 px-6 pb-6">
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/60 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2.5">{t.pricing.sqftRange}</th>
                          <th className="px-4 py-2.5 text-right">{t.pricing.price}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tiers.map((tier, idx) => {
                          const prev = idx > 0 ? tiers[idx - 1] : undefined;
                          const range = formatTierRange(tier, prev, {
                            under: t.pricing.under,
                            over: t.pricing.over,
                            sqft: t.pricing.sqft,
                          });
                          const effective = tier.customQuote ? null : round2(tier.price * (1 - discountRate));
                          return (
                            <tr key={idx} className="border-t border-border/70">
                              <td className="px-4 py-2.5 text-xs font-medium text-foreground">{range}</td>
                              <td className="px-4 py-2.5 text-right">
                                {tier.customQuote ? (
                                  <span className="text-xs font-bold text-primary">{t.pricing.customQuote}</span>
                                ) : (
                                  <span className="font-display text-sm font-extrabold text-foreground">
                                    {tier.startingAt && (
                                      <span className="mr-1 text-[10px] font-medium text-muted-foreground">{t.pricing.startingAt}</span>
                                    )}
                                    ${effective!.toFixed(2)}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {svc.id === "residential" && (
                    <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t.pricing.customQuoteDesc}</p>
                  )}
                </div>
                <div className="px-6 pb-6">
                  <Button asChild size="sm" variant={popular ? "default" : "outline"} className="press w-full rounded-full">
                    <Link href={path("quote")}>{t.nav.getQuote}</Link>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Airbnb + commercial note cards */}
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="reveal hover-lift flex flex-col rounded-3xl border border-border bg-card p-6 shadow-soft">
            <h3 className="font-display text-base font-bold text-foreground">{t.pricing.plans.airbnb.name}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.pricing.plans.airbnb.desc}</p>
            <p className="mt-3 flex-1 text-xs leading-relaxed text-muted-foreground">
              <Check className="mr-1 inline h-3.5 w-3.5 text-secondary" />
              {t.pricing.startingAt}{" "}
              <span className="font-display text-base font-extrabold text-foreground">
                ${round2(pricing.basePrices.airbnb * (1 - discountRate)).toFixed(2)}
              </span>
            </p>
            <Button asChild size="sm" variant="outline" className="press mt-4 w-fit rounded-full px-5">
              <Link href={path("quote")}>{t.nav.getQuote}</Link>
            </Button>
          </div>
          <div className="reveal hover-lift flex flex-col rounded-3xl border border-border bg-card p-6 shadow-soft" style={{ transitionDelay: "70ms" }}>
            <h3 className="font-display text-base font-bold text-foreground">
              {t.pricing.plans.office.name} · {t.services.commercial.name}
            </h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{t.pricing.commercialNote}</p>
            <Button asChild size="sm" variant="outline" className="press mt-4 w-fit rounded-full px-5">
              <Link href={path("contact")}>{t.common.contactUs}</Link>
            </Button>
          </div>
        </div>

        <p className="reveal mx-auto mt-8 max-w-xl text-center text-xs leading-relaxed text-muted-foreground">{t.pricing.tierNote}</p>

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
                <p className="mt-1 text-sm font-bold text-primary">+${pricing.extras[id]}</p>
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
