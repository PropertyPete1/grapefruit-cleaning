import { useState } from "react";
import { useLocale } from "@/i18n/LocaleContext";
import { useSeo, localBusinessJsonLd } from "@/hooks/useSeo";
import { useReveal } from "@/hooks/useReveal";
import { ASSETS } from "@/lib/assets";
import { cn } from "@/lib/utils";

type Category = "all" | "residential" | "commercial" | "airbnb" | "deep";

interface GalleryItem {
  src: string;
  category: Exclude<Category, "all">;
  alt: { en: string; es: string };
}

const ITEMS: GalleryItem[] = [
  { src: ASSETS.heroLivingRoom, category: "residential", alt: { en: "Bright living room after residential cleaning", es: "Sala luminosa después de una limpieza residencial" } },
  { src: ASSETS.kitchenWhite, category: "residential", alt: { en: "White kitchen with polished counters", es: "Cocina blanca con cubiertas pulidas" } },
  { src: ASSETS.bathroomSpa, category: "deep", alt: { en: "Spa-like bathroom after deep cleaning", es: "Baño tipo spa después de una limpieza profunda" } },
  { src: ASSETS.airbnbLiving, category: "airbnb", alt: { en: "Airbnb living room staged for guests", es: "Sala de Airbnb preparada para huéspedes" } },
  { src: ASSETS.officeModern, category: "commercial", alt: { en: "Modern office kept spotless", es: "Oficina moderna impecable" } },
  { src: ASSETS.bedroomMinimal, category: "residential", alt: { en: "Minimal bedroom with fresh linens", es: "Habitación minimalista con ropa de cama fresca" } },
  { src: ASSETS.kitchenMinimal, category: "deep", alt: { en: "Minimal kitchen after move-out deep clean", es: "Cocina minimalista tras limpieza profunda de mudanza" } },
  { src: ASSETS.airbnbKitchen, category: "airbnb", alt: { en: "Vacation rental kitchen restocked and cleaned", es: "Cocina de renta vacacional limpia y reabastecida" } },
  { src: ASSETS.officeOpen, category: "commercial", alt: { en: "Open-plan office after nightly cleaning", es: "Oficina de planta abierta tras limpieza nocturna" } },
  { src: ASSETS.bathroomMarble, category: "deep", alt: { en: "Marble bathroom detail after deep clean", es: "Detalle de baño de mármol tras limpieza profunda" } },
  { src: ASSETS.bedroomCozy, category: "airbnb", alt: { en: "Cozy guest bedroom turnover", es: "Habitación de huéspedes acogedora lista para el siguiente huésped" } },
  { src: ASSETS.livingRoomView, category: "residential", alt: { en: "Living room with city view, freshly cleaned", es: "Sala con vista a la ciudad, recién limpiada" } },
  { src: ASSETS.organizedPantry, category: "deep", alt: { en: "Organized pantry after home organization service", es: "Despensa organizada tras el servicio de organización" } },
  { src: ASSETS.livingRoomWhite, category: "residential", alt: { en: "White living room refreshed by our team", es: "Sala blanca renovada por nuestro equipo" } },
  { src: ASSETS.kitchenFridge, category: "deep", alt: { en: "Kitchen with cleaned refrigerator interior", es: "Cocina con interior de refrigerador limpio" } },
];

export default function Gallery() {
  const { t, locale } = useLocale();
  useSeo({ title: t.meta.gallery.title, description: t.meta.gallery.description, jsonLd: [localBusinessJsonLd()] });
  const [category, setCategory] = useState<Category>("all");
  useReveal([locale, category]);

  const cats: { id: Category; label: string }[] = [
    { id: "all", label: t.gallery.all },
    { id: "residential", label: t.gallery.categories.residential },
    { id: "commercial", label: t.gallery.categories.commercial },
    { id: "airbnb", label: t.gallery.categories.airbnb },
    { id: "deep", label: t.gallery.categories.deep },
  ];

  const visible = category === "all" ? ITEMS : ITEMS.filter((i) => i.category === category);

  return (
    <>
      <section className="relative overflow-hidden pt-32 pb-12 md:pt-44 md:pb-16">
        <div
          className="pointer-events-none absolute -top-32 right-1/4 h-96 w-96 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, oklch(0.72 0.17 30) 0%, transparent 65%)" }}
        />
        <div className="container relative max-w-3xl text-center">
          <h1 className="reveal font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {t.gallery.heroTitle}
          </h1>
          <p className="reveal mt-6 text-lg leading-relaxed text-muted-foreground" style={{ transitionDelay: "80ms" }}>
            {t.gallery.heroSubtitle}
          </p>
        </div>
      </section>

      <section className="container pb-24 md:pb-32">
        <div className="reveal mx-auto flex max-w-fit flex-wrap justify-center gap-1 rounded-full border border-border bg-card p-1.5 shadow-soft">
          {cats.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                "press rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 sm:px-5",
                category === c.id ? "bg-primary text-primary-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="mt-10 columns-1 gap-5 sm:columns-2 lg:columns-3 [&>*]:mb-5">
          {visible.map((item, i) => (
            <figure
              key={`${category}-${item.src}`}
              className="reveal-scale img-zoom break-inside-avoid overflow-hidden rounded-3xl shadow-soft"
              style={{ transitionDelay: `${(i % 6) * 50}ms` }}
            >
              <img
                src={item.src}
                alt={item.alt[locale]}
                className={cn("w-full object-cover", i % 3 === 0 ? "aspect-[4/5]" : i % 3 === 1 ? "aspect-square" : "aspect-[4/3]")}
                loading="lazy"
              />
            </figure>
          ))}
        </div>
      </section>
    </>
  );
}
