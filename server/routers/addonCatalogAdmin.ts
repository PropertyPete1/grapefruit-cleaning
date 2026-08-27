import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ADDON_CATALOG_FLAG_KEY,
  ADDON_PRICE_MODES,
  ALL_ADDON_SEED,
} from "@shared/addonCatalog";
import * as db from "../db";
import { loadAddonCatalog } from "../addonCatalog";
import { protectedProcedure, router } from "../_core/trpc";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

const optionalText = z.string().max(4000).nullable().optional();
const categoryCreateSchema = z.object({
  key: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case key"),
  nameEn: z.string().trim().min(1).max(160),
  nameEs: z.string().trim().min(1).max(160),
  descriptionEn: optionalText,
  descriptionEs: optionalText,
  noteEn: optionalText,
  noteEs: optionalText,
  sortOrder: z.number().int().min(0).max(10000),
  isEnabled: z.boolean(),
  showPublicHeading: z.boolean(),
});
const categoryUpdateSchema = categoryCreateSchema.omit({ key: true }).extend({ id: z.number().int().positive() });

const addonCreateSchema = z.object({
  key: z.string().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case key"),
  categoryId: z.number().int().positive(),
  nameEn: z.string().trim().min(1).max(180),
  nameEs: z.string().trim().min(1).max(180),
  descriptionEn: optionalText,
  descriptionEs: optionalText,
  includedItemsEn: z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  includedItemsEs: z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  noteEn: optionalText,
  noteEs: optionalText,
  priceMode: z.enum(ADDON_PRICE_MODES),
  startingPriceCents: z.number().int().min(1).max(5_000_000),
  mayVary: z.boolean(),
  sortOrder: z.number().int().min(0).max(10000),
  isEnabled: z.boolean(),
});
const addonUpdateSchema = addonCreateSchema.omit({ key: true }).extend({ id: z.number().int().positive() });

function serializeAddonInput(input: z.infer<typeof addonCreateSchema> | z.infer<typeof addonUpdateSchema>) {
  return {
    categoryId: input.categoryId,
    nameEn: input.nameEn,
    nameEs: input.nameEs,
    descriptionEn: input.descriptionEn ?? null,
    descriptionEs: input.descriptionEs ?? null,
    includedItemsEn: JSON.stringify(input.includedItemsEn),
    includedItemsEs: JSON.stringify(input.includedItemsEs),
    noteEn: input.noteEn ?? null,
    noteEs: input.noteEs ?? null,
    priceMode: input.priceMode,
    startingPriceCents: input.startingPriceCents,
    mayVary: input.mayVary,
    sortOrder: input.sortOrder,
    isEnabled: input.isEnabled,
    archivedAt: input.isEnabled ? null : undefined,
  };
}

export function addonRemovalMode(key: string, referenceCount: number): "delete" | "archive" {
  const isSeeded = ALL_ADDON_SEED.some(addon => addon.key === key);
  return referenceCount === 0 && !isSeeded ? "delete" : "archive";
}

export const addonCatalogAdminRouter = router({
  catalog: adminProcedure.query(() => loadAddonCatalog(true)),

  setRolloutEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.setSetting(ADDON_CATALOG_FLAG_KEY, input.enabled ? "true" : "false");
      return { success: true, enabled: input.enabled } as const;
    }),

  createCategory: adminProcedure.input(categoryCreateSchema).mutation(async ({ input }) => {
    const id = await db.createAddonCategory(input);
    return { success: true, id } as const;
  }),

  updateCategory: adminProcedure.input(categoryUpdateSchema).mutation(async ({ input }) => {
    const { id, ...data } = input;
    await db.updateAddonCategory(id, data);
    return { success: true } as const;
  }),

  deleteCategory: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => {
    if ((await db.countAddonsInCategory(input.id)) > 0) {
      throw new TRPCError({ code: "CONFLICT", message: "Move or remove this category's add-ons first." });
    }
    await db.deleteAddonCategory(input.id);
    return { success: true } as const;
  }),

  createAddon: adminProcedure.input(addonCreateSchema).mutation(async ({ input }) => {
    const id = await db.createAddon({ key: input.key, ...serializeAddonInput(input) });
    return { success: true, id } as const;
  }),

  updateAddon: adminProcedure.input(addonUpdateSchema).mutation(async ({ input }) => {
    const { id } = input;
    await db.updateAddon(id, serializeAddonInput(input));
    return { success: true } as const;
  }),

  removeAddon: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => {
    const addon = await db.getAddonById(input.id);
    if (!addon) throw new TRPCError({ code: "NOT_FOUND", message: "Add-on not found" });
    const referenceCount = await db.countAddonReferences(addon.id);
    const mode = addonRemovalMode(addon.key, referenceCount);
    if (mode === "delete") {
      await db.deleteAddon(addon.id);
    } else {
      await db.updateAddon(addon.id, { isEnabled: false, archivedAt: new Date() });
    }
    return { success: true, mode, referenceCount } as const;
  }),
});

export const addonCatalogAdminSchemas = {
  categoryCreateSchema,
  categoryUpdateSchema,
  addonCreateSchema,
  addonUpdateSchema,
};
