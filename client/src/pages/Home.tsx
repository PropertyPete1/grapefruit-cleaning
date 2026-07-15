import { Link } from "wouter";
import {
  ArrowRight,
  Building2,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Home as HomeIcon,
  KeyRound,
  Leaf,
  Briefcase,
  ShieldCheck,
  Sparkles,
  Star,
  Truck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";
import { cn } from "@/lib/utils";

const SERVICE_CARDS = [
  { id: "residential", icon: HomeIcon, image: ASSETS.livingRoomWhite },
  { id: "commercial", icon: Building2, image: ASSETS.officeOpen },
  { id: "airbnb", icon: KeyRound, image: ASSETS.airbnbLiving },
  { id: "moveinout", icon: Truck, image: ASSETS.kitchenMinimal },
  { id: "deep", icon: Sparkles, image: ASSETS.bathroomSpa },
  { id: "office", icon: Briefcase, image: ASSETS.officeModern },
] as const;

export default function Home() {
  const { t, locale, path } = useLocale();
  useSeo({
    title: t.meta.home.title,
    description: t.meta.home.description,
    jsonLd: [localBusinessJsonLd()],
  });
  useReveal([locale]);

  const whyItems = [
    { icon: ShieldCheck, title: t.home.why1Title, text: t.home.why1Text },
    { icon: Leaf, title: t.home.why2Title, text: t.home.why2Text },
    { icon: CalendarCheck, title: t.home.why3Title, text: t.home.why3Text },
    { icon: Star, title: t.home.why4Title, text: t.home.why4Text },
  ];

  const stats = [
    { value: "500+", label: t.home.statsClients },
    { value: "12,000+", label: t.home.statsCleanings },
    { value: "8", label: t.home.statsYears },
    { value: "5.0", label: t.home.statsRating },
  ];

  return (
    <>
      {/* ============ HERO ============ */}
      <section className="relative overflow-hidden pt-28 pb-16 md:pt-40 md:pb-28">
        <div
          className="pointer-events-none absolute -top-40 -right-40 h-[32rem] w-[32rem] rounded-full opacity-25 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div
          className="pointer-events-none absolute -bottom-52 -left-40 h-[28rem] w-[28rem] rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.62 0.13 150) 0%, transparent 65%)" }}
        />
        <div className="container relative grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div className="max-w-xl">
            <span className="reveal inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-semibold text-primary">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t.home.heroBadge}
            </span>
            <h1
              className="reveal mt-6 font-display text-4xl font-extrabold leading-[1.08] tracking-tight text-foreground sm:text-5xl lg:text-6xl"
              style={{ transitionDelay: "60ms" }}
            >
              {t.home.heroTitle}
            </h1>
            <p
              className="reveal mt-6 text-lg leading-relaxed text-muted-foreground"
              style={{ transitionDelay: "120ms" }}
            >
              {t.home.heroSubtitle}
            </p>
            <div className="reveal mt-8 flex flex-wrap items-center gap-3" style={{ transitionDelay: "180ms" }}>
              <Button asChild size="lg" className="press rounded-full px-7 text-base shadow-soft-lg">
                <Link href={path("quote")}>
                  {t.home.heroCtaPrimary}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="press rounded-full border-border bg-card px-7 text-base"
              >
                <Link href={path("services")}>{t.home.heroCtaSecondary}</Link>
              </Button>
            </div>
            <div className="reveal mt-8 flex items-center gap-3" style={{ transitionDelay: "240ms" }}>
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-amber-400 text-amber-400" />
                ))}
              </div>
              <span className="text-sm font-medium text-muted-foreground">{t.home.heroRating}</span>
            </div>
          </div>

          <div className="reveal-scale relative" style={{ transitionDelay: "150ms" }}>
            <div className="img-zoom relative overflow-hidden rounded-3xl shadow-soft-lg">
              <img
                src={ASSETS.heroLivingRoom}
                alt={
                  locale === "es"
                    ? "Sala luminosa e impecable después de una limpieza profesional"
                    : "Bright, spotless living room after a professional cleaning"
                }
                className="aspect-[4/3] w-full object-cover"
                loading="eager"
                fetchPriority="high"
              />
            </div>
            {/* Floating glass cards */}
            <div className="glass float-slow absolute -left-4 top-8 hidden items-center gap-3 rounded-2xl px-4 py-3 shadow-soft sm:flex">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary/15 text-secondary">
                <Leaf className="h-4 w-4" />
              </span>
              <div>
                <p className="text-xs font-semibold text-foreground">{t.home.why2Title}</p>
                <div className="flex">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-3 w-3 fill-amber-400 text-amber-400" />
                  ))}
                </div>
              </div>
            </div>
            <div
              className="glass float-slow absolute -right-3 bottom-10 hidden items-center gap-3 rounded-2xl px-4 py-3 shadow-soft sm:flex"
              style={{ animationDelay: "1.4s" }}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary">
                <CalendarCheck className="h-4 w-4" />
              </span>
              <div>
                <p className="text-xs font-semibold text-foreground">{t.home.why3Title}</p>
                <p className="text-[11px] text-muted-foreground">{t.common.from} $89</p>
              </div>
            </div>
          </div>
        </div>

        {/* Trust bar */}
        <div className="container relative mt-16 md:mt-24">
          <p className="reveal text-center text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t.home.trustedBy}
          </p>
          <div
            className="reveal mx-auto mt-8 grid max-w-3xl grid-cols-2 gap-6 sm:grid-cols-4"
            style={{ transitionDelay: "80ms" }}
          >
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <p className="font-display text-3xl font-extrabold text-foreground md:text-4xl">{s.value}</p>
                <p className="mt-1 text-xs font-medium text-muted-foreground md:text-sm">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ SERVICES ============ */}
      <section className="bg-card py-20 md:py-28">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
              {t.home.servicesTitle}
            </h2>
            <p
              className="reveal mt-4 text-base leading-relaxed text-muted-foreground md:text-lg"
              style={{ transitionDelay: "80ms" }}
            >
              {t.home.servicesSubtitle}
            </p>
          </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICE_CARDS.map((card, i) => {
              const copy = t.services[card.id];
              const Icon = card.icon;
              return (
                <Link
                  key={card.id}
                  href={path(card.id)}
                  className="reveal hover-lift group overflow-hidden rounded-3xl border border-border bg-background shadow-soft"
                  style={{ transitionDelay: `${(i % 3) * 70}ms` }}
                >
                  <div className="img-zoom relative">
                    <img src={card.image} alt={copy.name} className="aspect-[16/10] w-full object-cover" loading="lazy" />
                    <span className="glass absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-xl text-primary shadow-soft">
                      <Icon className="h-5 w-5" />
                    </span>
                  </div>
                  <div className="p-6">
                    <h3 className="font-display text-lg font-bold text-foreground">{copy.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.short}</p>
                    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                      {t.common.learnMore}
                      <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============ WHY US ============ */}
      <section className="py-20 md:py-28">
        <div className="container grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="relative order-2 lg:order-1">
            <div className="img-zoom reveal-scale overflow-hidden rounded-3xl shadow-soft-lg">
              <img
                src={ASSETS.cleanerAction}
                alt={
                  locale === "es"
                    ? "Profesional de Grapefruit Cleaning Co. limpiando una cocina moderna"
                    : "Grapefruit Cleaning Co. professional cleaning a modern kitchen"
                }
                className="aspect-[4/5] w-full object-cover sm:aspect-[4/4]"
                loading="lazy"
              />
            </div>
            <div className="glass absolute -bottom-6 left-6 right-6 rounded-2xl p-4 shadow-soft-lg sm:left-10 sm:right-auto sm:max-w-xs">
              <div className="flex items-center gap-3">
                <img src={ASSETS.logoSquare} alt="" className="h-10 w-10 rounded-xl" loading="lazy" />
                <div>
                  <p className="text-sm font-bold text-foreground">Grapefruit Cleaning Co.</p>
                  <p className="text-xs text-muted-foreground">{t.home.heroBadge}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
              {t.home.whyTitle}
            </h2>
            <p
              className="reveal mt-4 text-base leading-relaxed text-muted-foreground md:text-lg"
              style={{ transitionDelay: "70ms" }}
            >
              {t.home.whySubtitle}
            </p>
            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              {whyItems.map((item, i) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="reveal" style={{ transitionDelay: `${i * 70}ms` }}>
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <h3 className="mt-4 font-display text-base font-bold text-foreground">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ============ QUOTE TEASER ============ */}
      <section className="container py-8 md:py-12">
        <div className="reveal-scale relative overflow-hidden rounded-[2rem] bg-foreground px-6 py-14 text-center shadow-soft-lg md:px-16 md:py-20">
          <div
            className="pointer-events-none absolute -top-24 right-0 h-72 w-72 rounded-full opacity-30 blur-3xl"
            style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 60%)" }}
          />
          <div
            className="pointer-events-none absolute -bottom-24 left-0 h-72 w-72 rounded-full opacity-20 blur-3xl"
            style={{ background: "radial-gradient(circle, oklch(0.62 0.13 150) 0%, transparent 60%)" }}
          />
          <Sparkles className="mx-auto h-8 w-8 text-primary" />
          <h2 className="mx-auto mt-5 max-w-xl font-display text-3xl font-extrabold tracking-tight text-background md:text-4xl">
            {t.home.quoteTeaserTitle}
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-background/70 md:text-base">
            {t.home.quoteTeaserText}
          </p>
          <Button asChild size="lg" className="press mt-8 rounded-full px-8 text-base shadow-soft-lg">
            <Link href={path("quote")}>
              {t.home.quoteTeaserCta}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* ============ TESTIMONIALS ============ */}
      <TestimonialsCarousel />

      {/* ============ FINAL CTA ============ */}
      <section className="container pb-24 pt-8 md:pb-32">
        <div className="reveal mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.home.ctaTitle}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">{t.home.ctaText}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="press rounded-full px-8 text-base shadow-soft-lg">
              <Link href={path("booking")}>
                {t.home.ctaButton}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="press rounded-full border-border bg-card px-8 text-base">
              <Link href={path("pricing")}>{t.common.viewPricing}</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}

function TestimonialsCarousel() {
  const { t } = useLocale();
  const [index, setIndex] = useState(0);
  const items = t.testimonials.items;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => setIndex((i) => (i + 1) % items.length), 6000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [items.length]);

  const go = (dir: 1 | -1) => {
    setIndex((i) => (i + dir + items.length) % items.length);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setIndex((i) => (i + 1) % items.length), 6000);
  };

  return (
    <section className="py-20 md:py-28">
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
            {t.home.testimonialsTitle}
          </h2>
          <p className="reveal mt-4 text-base text-muted-foreground md:text-lg" style={{ transitionDelay: "70ms" }}>
            {t.home.testimonialsSubtitle}
          </p>
        </div>

        <div className="reveal relative mx-auto mt-12 max-w-3xl" style={{ transitionDelay: "120ms" }}>
          <div className="overflow-hidden rounded-[2rem]">
            <div
              className="flex transition-transform duration-500"
              style={{
                transform: `translateX(-${index * 100}%)`,
                transitionTimingFunction: "cubic-bezier(0.77, 0, 0.175, 1)",
              }}
            >
              {items.map((item) => (
                <figure key={item.name} className="w-full shrink-0 px-1">
                  <div className="rounded-[2rem] border border-border bg-card p-8 text-center shadow-soft md:p-12">
                    <div className="flex justify-center">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className="h-4 w-4 fill-amber-400 text-amber-400" />
                      ))}
                    </div>
                    <blockquote className="mt-6 text-base leading-relaxed text-foreground md:text-lg">
                      “{item.text}”
                    </blockquote>
                    <figcaption className="mt-6">
                      <p className="font-display text-sm font-bold text-foreground">{item.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.role}</p>
                    </figcaption>
                  </div>
                </figure>
              ))}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-center gap-4">
            <button
              onClick={() => go(-1)}
              className="press flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-soft transition-colors hover:bg-accent"
              aria-label="Previous testimonial"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex gap-2">
              {items.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setIndex(i)}
                  className={cn(
                    "h-2 rounded-full transition-all duration-300",
                    i === index ? "w-6 bg-primary" : "w-2 bg-border hover:bg-muted-foreground/40",
                  )}
                  aria-label={`Go to testimonial ${i + 1}`}
                />
              ))}
            </div>
            <button
              onClick={() => go(1)}
              className="press flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-soft transition-colors hover:bg-accent"
              aria-label="Next testimonial"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

