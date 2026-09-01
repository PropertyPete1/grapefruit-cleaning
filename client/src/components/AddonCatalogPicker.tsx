import { Check, Sparkles } from "lucide-react";
import type { AddonCatalogPayload } from "@shared/addonCatalog";
import { centsToDollars } from "@shared/money";
import { cn } from "@/lib/utils";

type Locale = "en" | "es";

export const CATALOG_LABELS = {
  en: {
    startingAt: "Starting at",
    customQuote: "Custom Quote",
    mayVary: "Price may vary",
    confirmation: "We will confirm any additional amount before service. Nothing extra is charged automatically.",
    selected: "Selected Add-Ons",
    subtotal: "Add-On Subtotal",
    none: "No add-ons selected",
  },
  es: {
    startingAt: "Desde",
    customQuote: "Cotización personalizada",
    mayVary: "El precio puede variar",
    confirmation: "Confirmaremos cualquier importe adicional antes del servicio. Nunca se cobrará nada extra automáticamente.",
    selected: "Servicios adicionales seleccionados",
    subtotal: "Subtotal de servicios adicionales",
    none: "No se seleccionaron servicios adicionales",
  },
} as const;

export function selectedCatalogAddons(catalog: AddonCatalogPayload, selectedKeys: readonly string[]) {
  const selected = new Set(selectedKeys);
  return catalog.categories.flatMap(category => category.addons).filter(addon => selected.has(addon.key));
}

export function AddonCatalogPicker({
  catalog,
  locale,
  selectedKeys,
  onToggle,
  className,
}: {
  catalog: AddonCatalogPayload;
  locale: Locale;
  selectedKeys: readonly string[];
  onToggle: (key: string) => void;
  className?: string;
}) {
  const labels = CATALOG_LABELS[locale];
  return (
    <div className={cn("space-y-7", className)}>
      {catalog.categories.map(category => (
        <section key={category.key} className="space-y-3">
          {category.showPublicHeading && (
            <div>
              <h3 className="font-display text-xl font-bold text-foreground">
                {locale === "es" ? category.nameEs : category.nameEn}
              </h3>
              {(locale === "es" ? category.descriptionEs : category.descriptionEn) && (
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  {locale === "es" ? category.descriptionEs : category.descriptionEn}
                </p>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {category.addons.map(addon => {
              const active = selectedKeys.includes(addon.key);
              const name = locale === "es" ? addon.nameEs : addon.nameEn;
              const description = locale === "es" ? addon.descriptionEs : addon.descriptionEn;
              const note = locale === "es" ? addon.noteEs : addon.noteEn;
              const included = locale === "es" ? addon.includedItemsEs : addon.includedItemsEn;
              const pricePrefix = addon.priceMode === "fixed" ? "" : `${addon.priceMode === "custom_quote" ? labels.customQuote : labels.startingAt} · `;
              return (
                <button
                  key={addon.key}
                  type="button"
                  onClick={() => onToggle(addon.key)}
                  aria-pressed={active}
                  className={cn(
                    "group relative rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    active ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card hover:border-primary/45"
                  )}
                >
                  <span className={cn("absolute right-3 top-3 grid size-6 place-items-center rounded-full border", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background")}>
                    {active ? <Check className="size-3.5" /> : <Sparkles className="size-3 text-muted-foreground" />}
                  </span>
                  <div className="pr-9">
                    <p className="font-semibold text-foreground">{name}</p>
                    <p className="mt-1 text-sm font-bold text-primary">
                      {pricePrefix}${centsToDollars(addon.startingPriceCents).toFixed(2)}
                    </p>
                    {description && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{description}</p>}
                    {included.length > 0 && (
                      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {included.map(item => <li key={item}>• {item}</li>)}
                      </ul>
                    )}
                    {(addon.mayVary || addon.priceMode !== "fixed") && (
                      <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">{labels.mayVary}</p>
                    )}
                    {note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p>}
                  </div>
                </button>
              );
            })}
          </div>
          {category.noteEn && category.showPublicHeading && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {locale === "es" ? category.noteEs : category.noteEn} {labels.confirmation}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

export function AddonCatalogDisplay({ catalog, locale }: { catalog: AddonCatalogPayload; locale: Locale }) {
  const labels = CATALOG_LABELS[locale];
  return (
    <div className="space-y-9">
      {catalog.categories.map(category => (
        <section key={category.key} className="space-y-4">
          {category.showPublicHeading && (
            <div className="text-center">
              <h3 className="font-display text-2xl font-bold text-foreground">
                {locale === "es" ? category.nameEs : category.nameEn}
              </h3>
              {(locale === "es" ? category.descriptionEs : category.descriptionEn) && (
                <p className="mx-auto mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  {locale === "es" ? category.descriptionEs : category.descriptionEn}
                </p>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {category.addons.map(addon => {
              const name = locale === "es" ? addon.nameEs : addon.nameEn;
              const description = locale === "es" ? addon.descriptionEs : addon.descriptionEn;
              const note = locale === "es" ? addon.noteEs : addon.noteEn;
              const prefix = addon.priceMode === "fixed" ? "+" : `${addon.priceMode === "custom_quote" ? labels.customQuote : labels.startingAt} `;
              return (
                <article key={addon.key} className="rounded-2xl border border-border bg-background p-5 shadow-soft">
                  <h4 className="font-semibold text-foreground">{name}</h4>
                  <p className="mt-1 font-bold text-primary">{prefix}${centsToDollars(addon.startingPriceCents).toFixed(2)}</p>
                  {description && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p>}
                  {(addon.mayVary || addon.priceMode !== "fixed") && <p className="mt-3 text-xs font-semibold text-amber-700 dark:text-amber-300">{labels.mayVary}</p>}
                  {note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p>}
                </article>
              );
            })}
          </div>
          {category.noteEn && category.showPublicHeading && (
            <p className="mx-auto max-w-3xl rounded-xl bg-amber-50 px-4 py-3 text-center text-xs leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {locale === "es" ? category.noteEs : category.noteEn} {labels.confirmation}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

export function CatalogAddonsSummary({
  catalog,
  locale,
  selectedKeys,
}: {
  catalog: AddonCatalogPayload;
  locale: Locale;
  selectedKeys: readonly string[];
}) {
  const labels = CATALOG_LABELS[locale];
  const selected = selectedCatalogAddons(catalog, selectedKeys);
  const subtotalCents = selected.reduce((sum, addon) => sum + addon.startingPriceCents, 0);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.selected}</p>
      {selected.length === 0 ? <p className="text-sm text-muted-foreground">{labels.none}</p> : selected.map(addon => (
        <div key={addon.key} className="flex items-start justify-between gap-4 text-sm">
          <span>{locale === "es" ? addon.nameEs : addon.nameEn}</span>
          <span className="shrink-0 font-medium">${centsToDollars(addon.startingPriceCents).toFixed(2)}</span>
        </div>
      ))}
      {selected.length > 0 && (
        <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
          <span>{labels.subtotal}</span><span>${centsToDollars(subtotalCents).toFixed(2)}</span>
        </div>
      )}
      {selected.some(addon => addon.mayVary || addon.priceMode !== "fixed") && (
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{labels.confirmation}</p>
      )}
    </div>
  );
}
