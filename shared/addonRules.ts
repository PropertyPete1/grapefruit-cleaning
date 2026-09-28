/**
 * Add-ons a service already includes.
 *
 * A Deep Cleaning service IS the deep clean; a Move In/Out cleaning IS the
 * move-out condition. Offering the matching add-on on top charges the same
 * work twice — which is exactly what happened on a deep clean quoted at
 * $413.99 and confirmed at $473.99 with "Extras: Deep cleaning". One rule,
 * shared by every surface: each add-on list (quote wizard, booking form,
 * deposit link, invoice checklist) shows such an add-on as included and
 * unselectable, every server entry point refuses it, and a service change
 * drops it from whatever was chosen before.
 *
 * Keyed by add-on key, which is the same in the legacy extras list and the
 * dynamic catalog (LEGACY_ADDON_SEED keeps the nine legacy keys).
 */
import type { CleaningType } from "./pricing";

export const INCLUDED_ADDONS: Record<CleaningType, readonly string[]> = {
  residential: [],
  commercial: [],
  airbnb: [],
  moveinout: ["moveOut"],
  deep: ["deepClean"],
  office: [],
};

/** The add-on keys a service includes — none for an unknown or unset service. */
export function includedAddonKeys(serviceType: string | null | undefined): readonly string[] {
  if (!serviceType) return [];
  return (INCLUDED_ADDONS as Record<string, readonly string[]>)[serviceType] ?? [];
}

export function addonIncludedIn(serviceType: string | null | undefined, key: string): boolean {
  return includedAddonKeys(serviceType).includes(key);
}

/** The chosen keys that duplicate the service — what the server refuses. */
export function duplicateAddons(serviceType: string | null | undefined, keys: readonly string[]): string[] {
  const included = includedAddonKeys(serviceType);
  return keys.filter(key => included.includes(key));
}

/** The chosen keys with the service's own work taken out — what a service change keeps. */
export function withoutIncludedAddons<T extends string>(serviceType: string | null | undefined, keys: readonly T[]): T[] {
  const included = includedAddonKeys(serviceType);
  return keys.filter(key => !included.includes(key));
}

/** The one refusal a duplicate gets, in the customer's language. */
export function duplicateAddonMessage(args: { addonName: string; serviceName: string; locale: "en" | "es" }): string {
  return args.locale === "es"
    ? `${args.addonName} ya está incluido en el servicio de ${args.serviceName} — quite ese extra; nunca se cobra dos veces.`
    : `${args.addonName} is already included in a ${args.serviceName} — remove that add-on; it is never charged twice.`;
}

export const INCLUDED_LABEL = { en: "Included", es: "Incluido" } as const;

/** "Included in Deep Cleaning" — the badge on an add-on the chosen service covers. */
export function includedInServiceLabel(serviceName: string, locale: "en" | "es"): string {
  return locale === "es" ? `Incluido en ${serviceName}` : `Included in ${serviceName}`;
}
