import { Link } from "wouter";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";
import { type CleaningType, type ExtraId } from "@shared/pricing";
import { usePricing } from "@/hooks/usePricing";

const IMAGES: Record<CleaningType, { hero: string; secondary: string }> = {
  residential: { hero: ASSETS.livingRoomWhite, secondary: ASSETS.bedroomCozy },
  commercial: { hero: ASSETS.officeOpen, secondary: ASSETS.officeModern },
  airbnb: { hero: ASSETS.airbnbLiving, secondary: ASSETS.airbnbKitchen },
  moveinout: { hero: ASSETS.kitchenMinimal, secondary: ASSETS.kitchenFridge },
  deep: { hero: ASSETS.bathroomSpa, secondary: ASSETS.bathroomMarble },
  office: { hero: ASSETS.officeModern, secondary: ASSETS.officeOpen },
};

const POPULAR_EXTRAS: Record<CleaningType, ExtraId[]> = {
  residential: ["oven", "refrigerator", "windows", "laundry"],
  commercial: ["windows", "garage", "organization", "deepClean"],
  airbnb: ["laundry", "refrigerator", "oven", "organization"],
  moveinout: ["oven", "refrigerator", "windows", "garage"],
  deep: ["oven", "refrigerator", "windows", "organization"],
  office: ["windows", "refrigerator", "organization", "deepClean"],
};

export default function ServiceDetail({ serviceId }: { serviceId: CleaningType }) {
  const { t, locale, path } = useLocale();
  const copy = t.services[serviceId];
  const meta = t.meta[serviceId];
  const pricing = usePricing();
  useSeo({
    title: meta.title,
    description: meta.description,
    jsonLd: [
      localBusinessJsonLd(),
      {
        "@context": "https://schema.org",
        "@type": "Service",
        name: copy.name,
        provider: { "@type": "CleaningService", name: "Grapefruit Cleaning Co." },
        description: copy.short,
        offers: { "@type": "Offer", price: pricing.basePrices[serviceId], priceCurrency: "USD" },
      },
    ],
  });
  useReveal([locale, serviceId]);

  const images = IMAGES[serviceId];
  const extras = POPULAR_EXTRAS[serviceId];

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-14 md:pt-44 md:pb-20">
        <div
          className="pointer-events-none absolute -top-32 right-0 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <span className="reveal inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              {t.common.from} ${pricing.basePrices[serviceId]} {t.common.perVisit}
            </span>
            <h1
              className="reveal mt-5 font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl"
              style={{ transitionDelay: "60ms" }}
            >
              {copy.name}
            </h1>
            <p className="reveal mt-5 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "120ms" }}>
              {copy.description}
            </p>
            <div className="reveal mt-8 flex flex-wrap gap-3" style={{ transitionDelay: "180ms" }}>
              <Button asChild size="lg" className="press rounded-full px-7 shadow-soft-lg">
                <Link href={path("quote")}>
                  {t.common.getInstantQuote}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="press rounded-full border-border bg-card px-7">
                <Link href={path("booking")}>{t.nav.bookNow}</Link>
              </Button>
            </div>
          </div>
          <div className="img-zoom reveal-scale overflow-hidden rounded-3xl shadow-soft-lg" style={{ transitionDelay: "120ms" }}>
            <img src={images.hero} alt={copy.name} className="aspect-[4/3] w-full object-cover" loading="eager" />
          </div>
        </div>
      </section>

      <section className="bg-card py-20 md:py-28">
        <div className="container grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="order-2 img-zoom reveal-scale overflow-hidden rounded-3xl shadow-soft-lg lg:order-1">
            <img src={images.secondary} alt={`${copy.name} — Grapefruit Cleaning Co.`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
          </div>
          <div className="order-1 lg:order-2">
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground">
              {t.services.includedTitle}
            </h2>
            <ul className="mt-8 space-y-4">
              {copy.included.map((item, i) => (
                <li key={item} className="reveal flex items-start gap-3" style={{ transitionDelay: `${i * 50}ms` }}>
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary/15 text-secondary">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-sm leading-relaxed text-foreground md:text-base">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="container py-20 md:py-28">
        <h2 className="reveal text-center font-display text-3xl font-extrabold tracking-tight text-foreground">
          {t.services.addonsTitle}
        </h2>
        <div className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-4 md:grid-cols-4">
          {extras.map((id, i) => (
            <div
              key={id}
              className="reveal hover-lift rounded-2xl border border-border bg-card p-5 text-center shadow-soft"
              style={{ transitionDelay: `${i * 60}ms` }}
            >
              <p className="text-sm font-semibold text-foreground">{t.extras[id]}</p>
              <p className="mt-1 text-sm font-bold text-primary">+${pricing.extras[id]}</p>
            </div>
          ))}
        </div>
        <div className="reveal mt-12 text-center" style={{ transitionDelay: "200ms" }}>
          <Button asChild size="lg" className="press rounded-full px-8 shadow-soft-lg">
            <Link href={path("quote")}>
              {t.common.getInstantQuote}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
