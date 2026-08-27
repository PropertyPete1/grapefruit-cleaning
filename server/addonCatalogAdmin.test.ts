import { describe, expect, it } from "vitest";
import { addonCatalogAdminSchemas, addonRemovalMode } from "./routers/addonCatalogAdmin";

const validAddon = {
  key: "new-upgrade",
  categoryId: 1,
  nameEn: "New Upgrade",
  nameEs: "Nuevo servicio",
  descriptionEn: "English description",
  descriptionEs: "Descripción en español",
  includedItemsEn: [],
  includedItemsEs: [],
  noteEn: null,
  noteEs: null,
  priceMode: "custom_quote" as const,
  startingPriceCents: 2500,
  mayVary: true,
  sortOrder: 10,
  isEnabled: true,
};

describe("admin add-on catalog safety rules", () => {
  it("requires bilingual names and a positive deposit-eligible starting price", () => {
    expect(addonCatalogAdminSchemas.addonCreateSchema.safeParse(validAddon).success).toBe(true);
    expect(addonCatalogAdminSchemas.addonCreateSchema.safeParse({ ...validAddon, nameEs: "" }).success).toBe(false);
    expect(addonCatalogAdminSchemas.addonCreateSchema.safeParse({ ...validAddon, startingPriceCents: 0 }).success).toBe(false);
  });

  it("keeps stable keys immutable after creation", () => {
    expect(addonCatalogAdminSchemas.addonUpdateSchema.safeParse({ ...validAddon, id: 3 }).success).toBe(true);
    expect(addonCatalogAdminSchemas.addonUpdateSchema.keyof().options).not.toContain("key");
  });

  it("soft-archives every referenced item and every seeded item", () => {
    expect(addonRemovalMode("pets", 0)).toBe("archive");
    expect(addonRemovalMode("sectional-steam-cleaning", 0)).toBe("archive");
    expect(addonRemovalMode("new-upgrade", 1)).toBe("archive");
  });

  it("hard-deletes only an unused unseeded draft", () => {
    expect(addonRemovalMode("new-upgrade", 0)).toBe("delete");
  });
});
