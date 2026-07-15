import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, Locale, LOCALES, pathFor, ROUTE_SLUGS } from "./types";
import { en } from "./translations/en";
import { es } from "./translations/es";
import type { Dictionary as Dict } from "./translations/en";

const dictionaries = { en, es } as const;
export type Dictionary = Dict;

interface LocaleContextValue {
  locale: Locale;
  t: Dictionary;
  switchLocale: (target: Locale) => void;
  path: (routeId: string, suffix?: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function detectPreferredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "es") return stored;
  } catch {
    /* ignore */
  }
  const nav = navigator.language?.toLowerCase() ?? "";
  if (nav.startsWith("es")) return "es";
  return DEFAULT_LOCALE;
}

/** Map a pathname in one locale to the equivalent pathname in the other locale. */
export function translatePath(pathname: string, from: Locale, to: Locale): string {
  const prefix = `/${from}`;
  let rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  if (rest.startsWith("/")) rest = rest.slice(1);

  // Exact or prefix match against route slugs (longest slug first for nested routes)
  const entries = Object.entries(ROUTE_SLUGS).sort(
    (a, b) => b[1][from].length - a[1][from].length,
  );
  for (const [routeId, slugs] of entries) {
    const fromSlug = slugs[from];
    if (fromSlug === "" && rest === "") return pathFor(routeId, to);
    if (fromSlug && (rest === fromSlug || rest.startsWith(`${fromSlug}/`))) {
      const suffix = rest.slice(fromSlug.length).replace(/^\//, "");
      return pathFor(routeId, to, suffix || undefined);
    }
  }
  return `/${to}`;
}

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const [location, navigate] = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = locale === "es" ? "es" : "en";
  }, [locale]);

  const switchLocale = useCallback(
    (target: Locale) => {
      if (target === locale) return;
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, target);
      } catch {
        /* ignore */
      }
      navigate(translatePath(location, locale, target));
    },
    [locale, location, navigate],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      t: dictionaries[locale],
      switchLocale,
      path: (routeId: string, suffix?: string) => pathFor(routeId, locale, suffix),
    }),
    [locale, switchLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

export { LOCALES };
