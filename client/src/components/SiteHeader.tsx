import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ChevronDown, Globe, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n/LocaleContext";
import { ASSETS } from "@/lib/assets";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const { t, locale, switchLocale, path } = useLocale();
  const [location] = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  const services = [
    { id: "residential", label: t.nav.servicesMenu.residential },
    { id: "commercial", label: t.nav.servicesMenu.commercial },
    { id: "airbnb", label: t.nav.servicesMenu.airbnb },
    { id: "moveinout", label: t.nav.servicesMenu.moveinout },
    { id: "deep", label: t.nav.servicesMenu.deep },
    { id: "office", label: t.nav.servicesMenu.office },
  ];

  const navLinks = [
    { href: path("about"), label: t.nav.about },
    { href: path("pricing"), label: t.nav.pricing },
    { href: path("gallery"), label: t.nav.gallery },
    { href: path("faq"), label: t.nav.faq },
    { href: path("blog"), label: t.nav.blog },
    { href: path("contact"), label: t.nav.contact },
  ];

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled ? "glass shadow-soft" : "bg-transparent",
      )}
    >
      <div className="container flex h-16 items-center justify-between gap-4 md:h-20">
        <Link href={path("home")} className="flex shrink-0 items-center gap-2" aria-label="Grapefruit Cleaning Co.">
          <img
            src={ASSETS.logo}
            alt="Grapefruit Cleaning Co. logo"
            className="h-10 w-auto md:h-12"
            loading="eager"
          />
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground">
              {t.nav.services}
              <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 rounded-2xl p-2 shadow-soft-lg">
              {services.map((s) => (
                <DropdownMenuItem key={s.id} asChild className="rounded-xl px-3 py-2.5 text-sm">
                  <Link href={path(s.id)}>{s.label}</Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem asChild className="rounded-xl px-3 py-2.5 text-sm font-semibold text-primary">
                <Link href={path("services")}>{t.nav.servicesMenu.viewAll}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-full px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                location === l.href ? "text-primary" : "text-foreground/80",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent"
              aria-label={t.language.label}
            >
              <Globe className="h-4 w-4" />
              <span className="uppercase">{locale}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-2xl p-1.5 shadow-soft-lg">
              <DropdownMenuItem
                className={cn("rounded-xl px-3 py-2", locale === "en" && "font-semibold text-primary")}
                onClick={() => switchLocale("en")}
              >
                {t.language.en}
              </DropdownMenuItem>
              <DropdownMenuItem
                className={cn("rounded-xl px-3 py-2", locale === "es" && "font-semibold text-primary")}
                onClick={() => switchLocale("es")}
              >
                {t.language.es}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button asChild className="press hidden rounded-full px-5 shadow-soft sm:inline-flex">
            <Link href={path("quote")}>{t.nav.getQuote}</Link>
          </Button>

          <button
            className="rounded-full p-2 text-foreground transition-colors hover:bg-accent lg:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <div
        className={cn(
          "glass overflow-hidden border-t border-border/50 transition-all duration-300 lg:hidden",
          mobileOpen ? "max-h-[80vh] overflow-y-auto opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <nav className="container flex flex-col gap-1 py-4" aria-label="Mobile">
          <p className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t.nav.services}
          </p>
          {services.map((s) => (
            <Link
              key={s.id}
              href={path(s.id)}
              className="rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/85 transition-colors hover:bg-accent"
            >
              {s.label}
            </Link>
          ))}
          <div className="my-2 h-px bg-border" />
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/85 transition-colors hover:bg-accent"
            >
              {l.label}
            </Link>
          ))}
          <Button asChild className="press mt-3 rounded-full shadow-soft">
            <Link href={path("quote")}>{t.nav.getQuote}</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
