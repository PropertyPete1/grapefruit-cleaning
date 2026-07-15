import { useLocale } from "@/i18n/LocaleContext";
import { useSeo } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";

export default function Privacy() {
  const { t, locale } = useLocale();
  useSeo({ title: t.meta.privacy.title, description: t.meta.privacy.description });
  useReveal([locale]);

  return (
    <div className="pt-32 pb-24 md:pt-40 md:pb-32">
      <div className="container max-w-3xl">
        <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground">{t.legal.privacyTitle}</h1>
        <p className="reveal mt-3 text-sm text-muted-foreground" style={{ transitionDelay: "60ms" }}>
          {t.legal.lastUpdated}
        </p>
        <div className="mt-10 space-y-10">
          {t.legal.privacySections.map((section, i) => (
            <section key={i} className="reveal" style={{ transitionDelay: `${Math.min(i * 40, 160)}ms` }}>
              <h2 className="font-display text-xl font-bold text-foreground">{section.heading}</h2>
              <p className="mt-3 text-sm leading-[1.85] text-foreground/80 md:text-base">{section.body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
