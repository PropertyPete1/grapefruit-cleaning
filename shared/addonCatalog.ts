import { formatCents } from "./money";

export const ADDON_CATALOG_FLAG_KEY = "addon_catalog_v2";
export const ADDON_PRICE_MODES = ["fixed", "starting_at", "custom_quote"] as const;
export type AddonPriceMode = (typeof ADDON_PRICE_MODES)[number];

export interface AddonCategorySeed {
  key: string;
  nameEn: string;
  nameEs: string;
  descriptionEn?: string;
  descriptionEs?: string;
  noteEn?: string;
  noteEs?: string;
  sortOrder: number;
  showPublicHeading: boolean;
}

export interface AddonSeed {
  key: string;
  categoryKey: string;
  nameEn: string;
  nameEs: string;
  descriptionEn?: string;
  descriptionEs?: string;
  includedItemsEn?: string[];
  includedItemsEs?: string[];
  noteEn?: string;
  noteEs?: string;
  priceMode: AddonPriceMode;
  startingPriceCents: number;
  mayVary: boolean;
  sortOrder: number;
  /** Marks the nine keys the legacy path can still understand during rollback. */
  legacy: boolean;
}

export interface CatalogAddon {
  id: number;
  key: string;
  categoryId: number | null;
  nameEn: string;
  nameEs: string;
  descriptionEn: string | null;
  descriptionEs: string | null;
  includedItemsEn: string[];
  includedItemsEs: string[];
  noteEn: string | null;
  noteEs: string | null;
  priceMode: AddonPriceMode;
  startingPriceCents: number;
  mayVary: boolean;
  sortOrder: number;
  isEnabled: boolean;
  archivedAt: Date | null;
}

export interface CatalogCategory {
  id: number;
  key: string;
  nameEn: string;
  nameEs: string;
  descriptionEn: string | null;
  descriptionEs: string | null;
  noteEn: string | null;
  noteEs: string | null;
  sortOrder: number;
  isEnabled: boolean;
  showPublicHeading: boolean;
  addons: CatalogAddon[];
}

export interface AddonCatalogPayload {
  enabled: boolean;
  version: string;
  categories: CatalogCategory[];
}

export const CATALOG_CATEGORY_SEED: readonly AddonCategorySeed[] = [
  {
    key: "legacy-general",
    nameEn: "Optional add-ons",
    nameEs: "Servicios adicionales",
    sortOrder: 10,
    showPublicHeading: false,
  },
  {
    key: "steam-cleaning-addons",
    nameEn: "Steam Cleaning Add-Ons",
    nameEs: "Servicios adicionales de limpieza a vapor",
    descriptionEn:
      "Refresh and deep-clean your mattress or upholstered furniture with professional steam/extraction cleaning. Pricing may vary depending on size and condition.",
    descriptionEs:
      "Renueve y limpie a fondo su colchón o sus muebles tapizados con una limpieza profesional a vapor y por extracción. El precio puede variar según el tamaño y el estado.",
    noteEn: "Final pricing may vary for excessive staining, heavy buildup, or unusually large items.",
    noteEs:
      "El precio final puede variar si hay manchas excesivas, acumulación intensa o artículos de tamaño fuera de lo común.",
    sortOrder: 20,
    showPublicHeading: true,
  },
  {
    key: "pet-odor-treatment",
    nameEn: "Pet Odor Treatment",
    nameEs: "Tratamiento de olores de mascotas",
    sortOrder: 30,
    showPublicHeading: false,
  },
  {
    key: "balcony-cleaning",
    nameEn: "Balcony Cleaning",
    nameEs: "Limpieza de balcones",
    descriptionEn:
      "Refresh your balcony with professional sweeping, mopping, surface cleaning, and removal of loose dirt and debris.",
    descriptionEs:
      "Renueve su balcón con barrido, trapeado, limpieza de superficies y retiro profesional de polvo, tierra y residuos sueltos.",
    noteEn: "Heavy buildup, excessive debris, stains, or additional exterior cleaning may require an additional charge.",
    noteEs:
      "La acumulación intensa, el exceso de residuos, las manchas o la limpieza exterior adicional pueden requerir un cargo adicional.",
    sortOrder: 40,
    showPublicHeading: true,
  },
] as const;

const legacy = (
  key: string,
  nameEn: string,
  nameEs: string,
  startingPriceCents: number,
  sortOrder: number
): AddonSeed => ({
  key,
  categoryKey: "legacy-general",
  nameEn,
  nameEs,
  priceMode: "fixed",
  startingPriceCents,
  mayVary: false,
  sortOrder,
  legacy: true,
});

export const LEGACY_ADDON_SEED: readonly AddonSeed[] = [
  legacy("pets", "Home with pets", "Hogar con mascotas", 2000, 10),
  legacy("deepClean", "Deep cleaning", "Limpieza profunda", 6000, 20),
  legacy("moveOut", "Move out condition", "Condición de mudanza", 7000, 30),
  legacy("oven", "Inside oven", "Interior del horno", 3500, 40),
  legacy("refrigerator", "Inside refrigerator", "Interior del refrigerador", 3500, 50),
  legacy("windows", "Interior windows", "Ventanas interiores", 4500, 60),
  legacy("laundry", "Laundry & folding", "Lavandería y doblado", 3000, 70),
  legacy("garage", "Garage sweep", "Barrido de cochera", 4000, 80),
  legacy("organization", "Home organization", "Organización del hogar", 5000, 90),
] as const;

const STEAM_DESCRIPTION_EN =
  "Refresh and deep-clean your mattress or upholstered furniture with professional steam/extraction cleaning. Pricing may vary depending on size and condition.";
const STEAM_DESCRIPTION_ES =
  "Renueve y limpie a fondo su colchón o sus muebles tapizados con una limpieza profesional a vapor y por extracción. El precio puede variar según el tamaño y el estado.";
const STEAM_NOTE_EN = "Final pricing may vary for excessive staining, heavy buildup, or unusually large items.";
const STEAM_NOTE_ES =
  "El precio final puede variar si hay manchas excesivas, acumulación intensa o artículos de tamaño fuera de lo común.";

const steam = (
  key: string,
  nameEn: string,
  nameEs: string,
  startingPriceCents: number,
  sortOrder: number,
  priceMode: AddonPriceMode = "fixed"
): AddonSeed => ({
  key,
  categoryKey: "steam-cleaning-addons",
  nameEn,
  nameEs,
  descriptionEn: STEAM_DESCRIPTION_EN,
  descriptionEs: STEAM_DESCRIPTION_ES,
  noteEn: STEAM_NOTE_EN,
  noteEs: STEAM_NOTE_ES,
  priceMode,
  startingPriceCents,
  mayVary: priceMode !== "fixed",
  sortOrder,
  legacy: false,
});

const BALCONY_DESCRIPTION_EN =
  "Refresh your balcony with professional sweeping, mopping, surface cleaning, and removal of loose dirt and debris.";
const BALCONY_DESCRIPTION_ES =
  "Renueve su balcón con barrido, trapeado, limpieza de superficies y retiro profesional de polvo, tierra y residuos sueltos.";
const BALCONY_NOTE_EN =
  "Heavy buildup, excessive debris, stains, or additional exterior cleaning may require an additional charge.";
const BALCONY_NOTE_ES =
  "La acumulación intensa, el exceso de residuos, las manchas o la limpieza exterior adicional pueden requerir un cargo adicional.";
const BALCONY_ITEMS_EN = [
  "Sweep balcony",
  "Remove loose dirt and debris",
  "Mop accessible flooring",
  "Wipe accessible surfaces",
  "Basic railing cleaning",
];
const BALCONY_ITEMS_ES = [
  "Barrido del balcón",
  "Retiro de tierra y residuos sueltos",
  "Trapeado del piso accesible",
  "Limpieza de superficies accesibles",
  "Limpieza básica del barandal",
];

const balcony = (
  key: string,
  nameEn: string,
  nameEs: string,
  startingPriceCents: number,
  sortOrder: number
): AddonSeed => ({
  key,
  categoryKey: "balcony-cleaning",
  nameEn,
  nameEs,
  descriptionEn: BALCONY_DESCRIPTION_EN,
  descriptionEs: BALCONY_DESCRIPTION_ES,
  includedItemsEn: BALCONY_ITEMS_EN,
  includedItemsEs: BALCONY_ITEMS_ES,
  noteEn: BALCONY_NOTE_EN,
  noteEs: BALCONY_NOTE_ES,
  priceMode: "fixed",
  startingPriceCents,
  mayVary: true,
  sortOrder,
  legacy: false,
});

export const NEW_ADDON_SEED: readonly AddonSeed[] = [
  steam("queen-mattress-steam-cleaning", "Queen Mattress Steam Cleaning", "Limpieza a vapor de colchón queen", 6999, 10),
  steam("king-mattress-steam-cleaning", "King Mattress Steam Cleaning", "Limpieza a vapor de colchón king", 7999, 20),
  steam("chair-steam-cleaning", "Chair Steam Cleaning", "Limpieza a vapor de silla", 3999, 30),
  steam("recliner-steam-cleaning", "Recliner Steam Cleaning", "Limpieza a vapor de sillón reclinable", 4999, 40),
  steam("two-seat-sofa-steam-cleaning", "2-Seat Sofa Steam Cleaning", "Limpieza a vapor de sofá de 2 plazas", 6999, 50),
  steam("three-seat-sofa-steam-cleaning", "3-Seat Sofa Steam Cleaning", "Limpieza a vapor de sofá de 3 plazas", 8999, 60),
  steam("sectional-steam-cleaning", "Sectional Steam Cleaning", "Limpieza a vapor de sofá seccional", 12999, 70, "starting_at"),
  {
    key: "pet-odor-walls-floors",
    categoryKey: "pet-odor-treatment",
    nameEn: "Pet Odor Treatment — Walls & Floors",
    nameEs: "Tratamiento de olores de mascotas — paredes y pisos",
    descriptionEn:
      "Deep scrub of accessible walls and mopping of floors using an appropriate pet odor treatment solution to help refresh areas affected by pet odors.",
    descriptionEs:
      "Lavado profundo de las paredes accesibles y trapeado de pisos con una solución adecuada para tratar olores de mascotas y ayudar a renovar las áreas afectadas.",
    includedItemsEn: ["Wall scrubbing", "Floor mopping", "Pet odor treatment", "Basic surface cleaning in accessible areas"],
    includedItemsEs: [
      "Lavado de paredes",
      "Trapeado de pisos",
      "Tratamiento para olores de mascotas",
      "Limpieza básica de superficies en áreas accesibles",
    ],
    noteEn:
      "Heavy odor or extensive treatment may require an additional charge. Final pricing will be confirmed before service.",
    noteEs:
      "Los olores intensos o un tratamiento extenso pueden requerir un cargo adicional. Confirmaremos el precio final antes del servicio.",
    priceMode: "fixed",
    startingPriceCents: 7999,
    mayVary: true,
    sortOrder: 10,
    legacy: false,
  },
  balcony("small-balcony-cleaning", "Small Balcony", "Balcón pequeño", 3999, 10),
  balcony("medium-balcony-cleaning", "Medium Balcony", "Balcón mediano", 4999, 20),
  balcony("large-balcony-cleaning", "Large Balcony", "Balcón grande", 5999, 30),
] as const;

export const ALL_ADDON_SEED: readonly AddonSeed[] = [...LEGACY_ADDON_SEED, ...NEW_ADDON_SEED];

export const UNIVERSAL_CONFIRMATION_NOTE = {
  en: "Any additional work will be confirmed before service and will never be charged automatically.",
  es: "Confirmaremos cualquier trabajo adicional antes del servicio; nunca se cobrará automáticamente.",
} as const;

export function addonCatalogFlagEnabled(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function addonStartingPriceLabel(addon: Pick<CatalogAddon, "priceMode" | "startingPriceCents">, locale: "en" | "es"): string {
  const price = `$${formatCents(addon.startingPriceCents)}`;
  if (addon.priceMode === "fixed") return price;
  return locale === "es" ? `Desde ${price}` : `Starting at ${price}`;
}

export function addonSubtotalCents(keys: readonly string[], addons: readonly Pick<CatalogAddon, "key" | "startingPriceCents">[]): number {
  const byKey = new Map(addons.map(addon => [addon.key, addon.startingPriceCents]));
  return Array.from(new Set(keys)).reduce((sum, key) => sum + (byKey.get(key) ?? 0), 0);
}

export function parseIncludedItems(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
  } catch {
    return [];
  }
}
