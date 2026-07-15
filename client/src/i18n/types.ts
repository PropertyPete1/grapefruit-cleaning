export type Locale = "en" | "es";

export const LOCALES: Locale[] = ["en", "es"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "gfc-locale";

/** Route slugs per locale. Keys are canonical route ids. */
export const ROUTE_SLUGS: Record<string, Record<Locale, string>> = {
  home: { en: "", es: "" },
  about: { en: "about", es: "nosotros" },
  services: { en: "services", es: "servicios" },
  residential: { en: "services/residential-cleaning", es: "servicios/limpieza-residencial" },
  commercial: { en: "services/commercial-cleaning", es: "servicios/limpieza-comercial" },
  airbnb: { en: "services/airbnb-cleaning", es: "servicios/limpieza-airbnb" },
  moveinout: { en: "services/move-in-out-cleaning", es: "servicios/limpieza-mudanza" },
  deep: { en: "services/deep-cleaning", es: "servicios/limpieza-profunda" },
  office: { en: "services/office-cleaning", es: "servicios/limpieza-oficinas" },
  pricing: { en: "pricing", es: "precios" },
  gallery: { en: "gallery", es: "galeria" },
  testimonials: { en: "testimonials", es: "testimonios" },
  faq: { en: "faq", es: "preguntas-frecuentes" },
  contact: { en: "contact", es: "contacto" },
  quote: { en: "quote", es: "cotizacion" },
  booking: { en: "book", es: "reservar" },
  blog: { en: "blog", es: "blog" },
  privacy: { en: "privacy-policy", es: "politica-de-privacidad" },
  terms: { en: "terms-of-service", es: "terminos-de-servicio" },
};

export function pathFor(routeId: string, locale: Locale, suffix = ""): string {
  const slug = ROUTE_SLUGS[routeId]?.[locale] ?? "";
  const base = `/${locale}${slug ? `/${slug}` : ""}`;
  return suffix ? `${base}/${suffix}` : base;
}
