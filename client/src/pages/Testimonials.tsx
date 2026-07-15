import { Link } from "wouter";
import { ArrowRight, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";

export default function Testimonials() {
  const { t, locale, path } = useLocale();
  useSeo({ title: t.meta.testimonials.title, description: t.meta.testimonials.description, jsonLd: [localBusinessJsonLd()] });
  useReveal([locale]);

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 left-1/3 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <div className="reveal flex items-center justify-center gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-6 w-6 fill-amber-400 text-amber-400" />
            ))}
          </div>
          <h1 className="reveal mt-5 font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl" style={{ transitionDelay: "60ms" }}>
            {t.testimonials.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "120ms" }}>
            {t.testimonials.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-20 md:pb-28">
        <div className="columns-1 gap-6 md:columns-2 lg:columns-3 [&>*]:mb-6">
          {t.testimonials.items.map((item, i) => (
            <figure
              key={item.name}
              className="reveal hover-lift break-inside-avoid rounded-3xl border border-border bg-card p-7 shadow-soft"
              style={{ transitionDelay: `${(i % 3) * 70}ms` }}
            >
              <div className="flex">
                {Array.from({ length: 5 }).map((_, j) => (
                  <Star key={j} className="h-4 w-4 fill-amber-400 text-amber-400" />
                ))}
              </div>
              <blockquote className="mt-4 text-sm leading-relaxed text-foreground md:text-base">“{item.text}”</blockquote>
              <figcaption className="mt-5 border-t border-border pt-4">
                <p className="font-display text-sm font-bold text-foreground">{item.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.role}</p>
              </figcaption>
            </figure>
          ))}
        </div>

        <div className="reveal mt-10 text-center">
          <Button asChild size="lg" className="press rounded-full px-8 shadow-soft-lg">
            <Link href={path("booking")}>
              {t.common.bookYourCleaning}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
