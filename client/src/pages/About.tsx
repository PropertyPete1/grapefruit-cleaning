import { Link } from "wouter";
import { ArrowRight, Eye, HeartHandshake, Leaf, Medal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";

export default function About() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.about.title, description: t.meta.about.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);

  const values = [
    { icon: Eye, title: t.about.value1Title, text: t.about.value1Text },
    { icon: HeartHandshake, title: t.about.value2Title, text: t.about.value2Text },
    { icon: Leaf, title: t.about.value3Title, text: t.about.value3Text },
    { icon: Medal, title: t.about.value4Title, text: t.about.value4Text },
  ];

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-16 md:pt-44 md:pb-24">
        <div
          className="pointer-events-none absolute -top-32 right-0 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.about.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.about.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-20 md:pb-28">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="img-zoom reveal-scale overflow-hidden rounded-3xl shadow-soft-lg">
            <img
              src={ASSETS.livingRoomView}
              alt={
                locale === "es"
                  ? "Sala moderna e impecable cuidada por Grapefruit Cleaning Co."
                  : "Modern spotless living room cared for by Grapefruit Cleaning Co."
              }
              className="aspect-[4/3] w-full object-cover"
              loading="lazy"
            />
          </div>
          <div>
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground">
              {t.about.storyTitle}
            </h2>
            <p className="reveal mt-5 leading-relaxed text-muted-foreground" style={{ transitionDelay: "70ms" }}>
              {t.about.storyText1}
            </p>
            <p className="reveal mt-4 leading-relaxed text-muted-foreground" style={{ transitionDelay: "140ms" }}>
              {t.about.storyText2}
            </p>
          </div>
        </div>
      </section>

      <section className="bg-card py-20 md:py-28">
        <div className="container">
          <h2 className="reveal text-center font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
            {t.about.valuesTitle}
          </h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {values.map((v, i) => {
              const Icon = v.icon;
              return (
                <div
                  key={v.title}
                  className="reveal hover-lift rounded-3xl border border-border bg-background p-7 shadow-soft"
                  style={{ transitionDelay: `${i * 70}ms` }}
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-base font-bold text-foreground">{v.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{v.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="container py-20 md:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <h2 className="reveal font-display text-3xl font-extrabold tracking-tight text-foreground">
              {t.about.teamTitle}
            </h2>
            <p className="reveal mt-5 leading-relaxed text-muted-foreground" style={{ transitionDelay: "70ms" }}>
              {t.about.teamText}
            </p>
            <div className="reveal mt-8" style={{ transitionDelay: "140ms" }}>
              <Button asChild size="lg" className="press rounded-full px-7 shadow-soft-lg">
                <Link href={path("quote")}>
                  {t.common.getInstantQuote}
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="img-zoom reveal-scale overflow-hidden rounded-3xl shadow-soft-lg">
            <img
              src={ASSETS.cleanerAction}
              alt={
                locale === "es"
                  ? "Miembro del equipo de Grapefruit Cleaning Co. trabajando"
                  : "Grapefruit Cleaning Co. team member at work"
              }
              className="aspect-[4/3] w-full object-cover"
              loading="lazy"
            />
          </div>
        </div>
      </section>
    </>
  );
}
