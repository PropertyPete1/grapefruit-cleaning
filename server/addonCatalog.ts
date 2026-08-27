import { TRPCError } from "@trpc/server";
import {
  ADDON_CATALOG_FLAG_KEY,
  type AddonCatalogPayload,
  type CatalogAddon,
  type CatalogCategory,
  parseIncludedItems,
  addonCatalogFlagEnabled,
} from "@shared/addonCatalog";
import * as db from "./db";

/** Public/admin catalog read model; admin mode includes disabled and archived rows. */
export async function loadAddonCatalog(includeDisabled = false): Promise<AddonCatalogPayload> {
  const flag = await db.getSetting(ADDON_CATALOG_FLAG_KEY);
  const enabled = addonCatalogFlagEnabled(flag);
  // Rollback mode is deliberately self-contained: legacy quote/invoice flows
  // should not depend on catalog tables even existing, which keeps the feature
  // flag a genuine one-setting rollback rather than a partial schema rollback.
  if (!enabled && !includeDisabled) {
    return { enabled: false, version: "legacy", categories: [] };
  }
  const [categoryRows, addonRows] = await Promise.all([
    db.listAddonCategories(includeDisabled),
    db.listAddons(includeDisabled),
  ]);

  const byCategory = new Map<number, CatalogAddon[]>();
  for (const row of addonRows) {
    if (row.categoryId == null) continue;
    const parsed: CatalogAddon = {
      id: row.id,
      key: row.key,
      categoryId: row.categoryId,
      nameEn: row.nameEn,
      nameEs: row.nameEs,
      descriptionEn: row.descriptionEn,
      descriptionEs: row.descriptionEs,
      includedItemsEn: parseIncludedItems(row.includedItemsEn),
      includedItemsEs: parseIncludedItems(row.includedItemsEs),
      noteEn: row.noteEn,
      noteEs: row.noteEs,
      priceMode: row.priceMode,
      startingPriceCents: row.startingPriceCents,
      mayVary: row.mayVary,
      sortOrder: row.sortOrder,
      isEnabled: row.isEnabled,
      archivedAt: row.archivedAt,
    };
    const current = byCategory.get(row.categoryId) ?? [];
    current.push(parsed);
    byCategory.set(row.categoryId, current);
  }

  const categories: CatalogCategory[] = categoryRows
    .map(category => ({
      id: category.id,
      key: category.key,
      nameEn: category.nameEn,
      nameEs: category.nameEs,
      descriptionEn: category.descriptionEn,
      descriptionEs: category.descriptionEs,
      noteEn: category.noteEn,
      noteEs: category.noteEs,
      sortOrder: category.sortOrder,
      isEnabled: category.isEnabled,
      showPublicHeading: category.showPublicHeading,
      addons: (byCategory.get(category.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    }))
    .filter(category => includeDisabled || (category.isEnabled && category.addons.length > 0));

  const latest = Math.max(
    0,
    ...categoryRows.map(row => new Date(row.updatedAt).getTime()),
    ...addonRows.map(row => new Date(row.updatedAt).getTime())
  );
  return {
    enabled,
    version: String(latest),
    categories,
  };
}

export function flattenCatalog(catalog: AddonCatalogPayload): CatalogAddon[] {
  return catalog.categories.flatMap(category => category.addons);
}

/**
 * Server-authoritative selection resolver. Unknown, disabled, archived and
 * duplicate keys are rejected; the browser never supplies prices.
 */
export async function resolveSelectedAddons(keys: readonly string[]): Promise<{
  catalog: AddonCatalogPayload;
  addons: CatalogAddon[];
  subtotalCents: number;
}> {
  const catalog = await loadAddonCatalog(false);
  const unique = Array.from(new Set(keys));
  if (unique.length !== keys.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Each add-on can be selected only once." });
  }
  const available = new Map(flattenCatalog(catalog).map(addon => [addon.key, addon]));
  const selected = unique.map(key => available.get(key));
  if (selected.some(addon => !addon)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "One or more selected add-ons are no longer available. Refresh your quote and review the total.",
    });
  }
  const addons = selected as CatalogAddon[];
  return {
    catalog,
    addons,
    subtotalCents: addons.reduce((sum, addon) => sum + addon.startingPriceCents, 0),
  };
}

export function bookingAddonSnapshots(addons: CatalogAddon[], catalog: AddonCatalogPayload) {
  const categoryById = new Map(catalog.categories.map(category => [category.id, category]));
  return addons.map((addon, index) => {
    const category = addon.categoryId == null ? undefined : categoryById.get(addon.categoryId);
    return {
      addonId: addon.id,
      addonKey: addon.key,
      categoryKey: category?.key ?? null,
      categoryNameEn: category?.nameEn ?? null,
      categoryNameEs: category?.nameEs ?? null,
      nameEn: addon.nameEn,
      nameEs: addon.nameEs,
      descriptionEn: addon.descriptionEn,
      descriptionEs: addon.descriptionEs,
      noteEn: addon.noteEn ?? category?.noteEn ?? null,
      noteEs: addon.noteEs ?? category?.noteEs ?? null,
      priceMode: addon.priceMode,
      bookedPriceCents: addon.startingPriceCents,
      mayVary: addon.mayVary,
      quantity: 1,
      sortOrder: index,
    };
  });
}
