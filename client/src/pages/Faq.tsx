import { Link } from "wouter";
import { ArrowRight, MessageCircleQuestion } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";

export default function Faq() {
  const { t, locale, path } = useLocale();
  useSeo({
    title: t.meta.faq.title,
    description: t.meta.faq.description,
    jsonLd: [
      localBusinessJsonLd(),
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: t.faq.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  });
  useReveal([locale]);

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 right-1/4 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <span className="reveal mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <MessageCircleQuestion className="h-7 w-7" />
          </span>
          <h1 className="reveal mt-5 font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl" style={{ transitionDelay: "60ms" }}>
            {t.faq.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "120ms" }}>
            {t.faq.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-24 md:pb-32">
        <div className="reveal mx-auto max-w-3xl rounded-3xl border border-border bg-card p-2 shadow-soft sm:p-4">
          <Accordion type="single" collapsible className="w-full">
            {t.faq.items.map((item, i) => (
              <AccordionItem key={i} value={`item-${i}`} className="border-border/60 px-3">
                <AccordionTrigger className="py-5 text-left font-display text-sm font-bold text-foreground hover:no-underline md:text-base">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="pb-5 text-sm leading-relaxed text-muted-foreground md:text-base">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        <div className="reveal mt-12 text-center">
          <p className="text-sm text-muted-foreground">{t.contact.heroSubtitle}</p>
          <Button asChild size="lg" className="press mt-5 rounded-full px-8 shadow-soft-lg">
            <Link href={path("contact")}>
              {t.common.contactUs}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}

