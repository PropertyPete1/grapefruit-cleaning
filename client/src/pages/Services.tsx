import { Link } from "wouter";
import { ArrowRight, Briefcase, Building2, CalendarCheck, Home as HomeIcon, KeyRound, Sparkles, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";

const CARDS = [
  { id: "residential", icon: HomeIcon, image: ASSETS.livingRoomWhite },
  { id: "commercial", icon: Building2, image: ASSETS.officeOpen },
  { id: "airbnb", icon: KeyRound, image: ASSETS.airbnbLiving },
  { id: "moveinout", icon: Truck, image: ASSETS.kitchenMinimal },
  { id: "deep", icon: Sparkles, image: ASSETS.bathroomSpa },
  { id: "office", icon: Briefcase, image: ASSETS.officeModern },
] as const;

export default function Services() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.services.title, description: t.meta.services.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);

  const steps = [
    { icon: Sparkles, title: t.services.process1Title, text: t.services.process1Text },
    { icon: CalendarCheck, title: t.services.process2Title, text: t.services.process2Text },
    { icon: HomeIcon, title: t.services.process3Title, text: t.services.process3Text },
  ];

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-14 md:pt-44 md:pb-20">
        <div
          className="pointer-events-none absolute -top-32 left-1/3 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.services.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.services.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-20 md:pb-28">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card, i) => {
            const copy = t.services[card.id];
            const Icon = card.icon;
            return (
              <Link
                key={card.id}
                href={path(card.id)}
                className="reveal hover-lift group overflow-hidden rounded-3xl border border-border bg-card shadow-soft"
                style={{ transitionDelay: `${(i % 3) * 70}ms` }}
              >
                <div className="img-zoom relative">
                  <img src={card.image} alt={copy.name} className="aspect-[16/10] w-full object-cover" loading="lazy" />
                  <span className="glass absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-xl text-primary shadow-soft">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
                <div className="p-6">
                  <h2 className="font-display text-lg font-bold text-foreground">{copy.name}</h2>
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
      </section>

      <section className="bg-card py-20 md:py-28">
        <div className="container">
          <h2 className="reveal text-center font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
            {t.services.processTitle}
          </h2>
          <div className="mx-auto mt-12 grid max-w-4xl gap-8 md:grid-cols-3">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="reveal relative text-center" style={{ transitionDelay: `${i * 90}ms` }}>
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-soft">
                    <Icon className="h-6 w-6" />
                  </span>
                  <span className="absolute -top-2 left-1/2 ml-6 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    {i + 1}
                  </span>
                  <h3 className="mt-5 font-display text-base font-bold text-foreground">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
                </div>
              );
            })}
          </div>
          <div className="reveal mt-12 text-center" style={{ transitionDelay: "180ms" }}>
            <Button asChild size="lg" className="press rounded-full px-8 shadow-soft-lg">
              <Link href={path("quote")}>
                {t.common.getInstantQuote}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
