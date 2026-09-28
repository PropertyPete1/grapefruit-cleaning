/**
 * Customer-facing names for services, cadences and the legacy add-ons, in
 * both languages. A leaf module — nothing here imports anything — so the
 * add-on rule, the emails and the routers can all read the same names
 * without importing each other. The booking router re-exports them for the
 * importers that always found them there.
 */
export const SERVICE_NAMES: Record<string, { en: string; es: string }> = {
  residential: { en: "Residential Cleaning", es: "Limpieza Residencial" },
  commercial: { en: "Commercial Cleaning", es: "Limpieza Comercial" },
  airbnb: { en: "Airbnb Cleaning", es: "Limpieza Airbnb" },
  moveinout: { en: "Move In/Out Cleaning", es: "Limpieza de Mudanza" },
  deep: { en: "Deep Cleaning", es: "Limpieza Profunda" },
  office: { en: "Office Cleaning", es: "Limpieza de Oficinas" },
};

export const FREQUENCY_NAMES: Record<string, { en: string; es: string }> = {
  onetime: { en: "One-time", es: "Una sola vez" },
  weekly: { en: "Weekly", es: "Semanal" },
  biweekly: { en: "Every two weeks", es: "Quincenal" },
  monthly: { en: "Monthly", es: "Mensual" },
};

export const EXTRA_NAMES: Record<string, { en: string; es: string }> = {
  pets: { en: "Home with pets", es: "Hogar con mascotas" },
  deepClean: { en: "Deep cleaning", es: "Limpieza profunda" },
  moveOut: { en: "Move out condition", es: "Condición de mudanza" },
  oven: { en: "Inside oven", es: "Interior del horno" },
  refrigerator: { en: "Inside refrigerator", es: "Interior del refrigerador" },
  windows: { en: "Interior windows", es: "Ventanas interiores" },
  laundry: { en: "Laundry & folding", es: "Lavandería y doblado" },
  garage: { en: "Garage sweep", es: "Barrido de cochera" },
  organization: { en: "Home organization", es: "Organización del hogar" },
};
