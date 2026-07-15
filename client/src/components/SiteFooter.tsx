import { Link } from "wouter";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { useLocale } from "@/i18n/LocaleContext";
import { ASSETS } from "@/lib/assets";

export function SiteFooter() {
  const { t, path } = useLocale();
  const year = new Date().getFullYear();

  const serviceLinks = [
    { id: "residential", label: t.nav.servicesMenu.residential },
    { id: "commercial", label: t.nav.servicesMenu.commercial },
    { id: "airbnb", label: t.nav.servicesMenu.airbnb },
    { id: "moveinout", label: t.nav.servicesMenu.moveinout },
    { id: "deep", label: t.nav.servicesMenu.deep },
    { id: "office", label: t.nav.servicesMenu.office },
  ];
  const companyLinks = [
    { href: path("about"), label: t.nav.about },
    { href: path("pricing"), label: t.nav.pricing },
    { href: path("gallery"), label: t.nav.gallery },
    { href: path("testimonials"), label: t.nav.testimonials },
    { href: path("blog"), label: t.nav.blog },
  ];
  const resourceLinks = [
    { href: path("faq"), label: t.nav.faq },
    { href: path("contact"), label: t.nav.contact },
    { href: path("quote"), label: t.nav.getQuote },
    { href: path("booking"), label: t.nav.bookNow },
  ];

  return (
    <footer className="border-t border-border bg-card">
      <div className="container py-14 md:py-20">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Link href={path("home")} aria-label="Grapefruit Cleaning Co.">
              <img src={ASSETS.logo} alt="Grapefruit Cleaning Co. logo" className="h-14 w-auto" loading="lazy" />
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">{t.footer.tagline}</p>
            <div className="mt-6 space-y-2.5 text-sm text-muted-foreground">
              <p className="flex items-center gap-2.5">
                <Phone className="h-4 w-4 text-primary" /> (555) 472-3384
              </p>
              <p className="flex items-center gap-2.5">
                <Mail className="h-4 w-4 text-primary" /> hello@grapefruitcleaning.com
              </p>
              <p className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 text-primary" /> {t.footer.hours}
              </p>
              <p className="flex items-center gap-2.5">
                <MapPin className="h-4 w-4 text-primary" /> {t.footer.serving}
              </p>
            </div>
          </div>

          <nav aria-label={t.footer.servicesTitle}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">{t.footer.servicesTitle}</h3>
            <ul className="mt-4 space-y-2.5">
              {serviceLinks.map((s) => (
                <li key={s.id}>
                  <Link href={path(s.id)} className="text-sm text-muted-foreground transition-colors hover:text-primary">
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={t.footer.company}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">{t.footer.company}</h3>
            <ul className="mt-4 space-y-2.5">
              {companyLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-muted-foreground transition-colors hover:text-primary">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={t.footer.resources}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">{t.footer.resources}</h3>
            <ul className="mt-4 space-y-2.5">
              {resourceLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-muted-foreground transition-colors hover:text-primary">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:flex-row">
          <p className="text-xs text-muted-foreground">
            © {year} Grapefruit Cleaning Co. {t.footer.rights}
          </p>
          <div className="flex items-center gap-6">
            <Link href={path("privacy")} className="text-xs text-muted-foreground transition-colors hover:text-primary">
              {t.footer.privacy}
            </Link>
            <Link href={path("terms")} className="text-xs text-muted-foreground transition-colors hover:text-primary">
              {t.footer.terms}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
