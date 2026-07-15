import { useEffect } from "react";
import { useLocale } from "@/i18n/LocaleContext";
import { translatePath } from "@/i18n/LocaleContext";
import { useLocation } from "wouter";
import { ASSETS } from "@/lib/assets";

interface SeoOptions {
  title: string;
  description: string;
  /** JSON-LD structured data objects */
  jsonLd?: object[];
  ogImage?: string;
}

function setMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string, hreflang?: string) {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]:not([hreflang])`;
  let el = document.head.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    if (hreflang) el.setAttribute("hreflang", hreflang);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Per-page SEO: title, meta description, Open Graph, canonical + hreflang alternates,
 * and JSON-LD structured data. Bilingual-aware.
 */
export function useSeo({ title, description, jsonLd, ogImage }: SeoOptions) {
  const { locale } = useLocale();
  const [location] = useLocation();

  useEffect(() => {
    document.title = title;
    setMeta("name", "description", description);

    const origin = window.location.origin;
    const url = `${origin}${location}`;
    const image = ogImage ?? `${origin}${ASSETS.logoOriginal}`;

    // Open Graph
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:type", "website");
    setMeta("property", "og:url", url);
    setMeta("property", "og:image", image);
    setMeta("property", "og:site_name", "Grapefruit Cleaning Co.");
    setMeta("property", "og:locale", locale === "es" ? "es_LA" : "en_US");
    // Twitter
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
    setMeta("name", "twitter:image", image);

    // Canonical + hreflang alternates
    setLink("canonical", url);
    const enPath = locale === "en" ? location : translatePath(location, "es", "en");
    const esPath = locale === "es" ? location : translatePath(location, "en", "es");
    setLink("alternate", `${origin}${enPath}`, "en");
    setLink("alternate", `${origin}${esPath}`, "es");
    setLink("alternate", `${origin}${enPath}`, "x-default");

    // JSON-LD
    document.querySelectorAll('script[data-seo-jsonld="true"]').forEach((n) => n.remove());
    (jsonLd ?? []).forEach((obj) => {
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.dataset.seoJsonld = "true";
      script.textContent = JSON.stringify(obj);
      document.head.appendChild(script);
    });
  }, [title, description, locale, location, jsonLd, ogImage]);
}

/** Reusable LocalBusiness JSON-LD for Grapefruit Cleaning Co. */
export function localBusinessJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "CleaningService",
    name: "Grapefruit Cleaning Co.",
    image: `${typeof window !== "undefined" ? window.location.origin : ""}${ASSETS.logoOriginal}`,
    description:
      "Premium residential and commercial cleaning services: recurring house cleaning, deep cleaning, move in/out, Airbnb turnovers, and office cleaning.",
    telephone: "+1-555-472-3384",
    email: "hello@grapefruitcleaning.com",
    priceRange: "$$",
    openingHoursSpecification: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      opens: "08:00",
      closes: "18:00",
    },
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "5.0",
      reviewCount: "500",
    },
  };
}
