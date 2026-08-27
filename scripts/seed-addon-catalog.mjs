import mysql from "mysql2/promise";
import {
  ADDON_CATALOG_FLAG_KEY,
  ALL_ADDON_SEED,
  CATALOG_CATEGORY_SEED,
} from "../shared/addonCatalog.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  await connection.beginTransaction();
  await connection.execute(
    `INSERT INTO site_settings (settingKey, settingValue)
     VALUES (?, 'false')
     ON DUPLICATE KEY UPDATE settingValue = VALUES(settingValue)`,
    [ADDON_CATALOG_FLAG_KEY]
  );

  for (const category of CATALOG_CATEGORY_SEED) {
    await connection.execute(
      `INSERT INTO addon_categories
        (\`key\`, nameEn, nameEs, descriptionEn, descriptionEs, noteEn, noteEs, sortOrder, isEnabled, showPublicHeading)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, ?)
       ON DUPLICATE KEY UPDATE
         nameEn=VALUES(nameEn), nameEs=VALUES(nameEs),
         descriptionEn=VALUES(descriptionEn), descriptionEs=VALUES(descriptionEs),
         noteEn=VALUES(noteEn), noteEs=VALUES(noteEs),
         sortOrder=VALUES(sortOrder), isEnabled=true,
         showPublicHeading=VALUES(showPublicHeading)`,
      [
        category.key,
        category.nameEn,
        category.nameEs,
        category.descriptionEn ?? null,
        category.descriptionEs ?? null,
        category.noteEn ?? null,
        category.noteEs ?? null,
        category.sortOrder,
        category.showPublicHeading,
      ]
    );
  }

  const [categoryRows] = await connection.query("SELECT id, `key` FROM addon_categories");
  const categoryIds = new Map(categoryRows.map(row => [row.key, Number(row.id)]));

  for (const addon of ALL_ADDON_SEED) {
    const categoryId = categoryIds.get(addon.categoryKey);
    if (!categoryId) throw new Error(`Missing seeded category: ${addon.categoryKey}`);
    await connection.execute(
      `INSERT INTO addons
        (categoryId, \`key\`, nameEn, nameEs, descriptionEn, descriptionEs,
         includedItemsEn, includedItemsEs, noteEn, noteEs, priceMode,
         startingPriceCents, mayVary, sortOrder, isEnabled, archivedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true, NULL)
       ON DUPLICATE KEY UPDATE
         categoryId=VALUES(categoryId), nameEn=VALUES(nameEn), nameEs=VALUES(nameEs),
         descriptionEn=VALUES(descriptionEn), descriptionEs=VALUES(descriptionEs),
         includedItemsEn=VALUES(includedItemsEn), includedItemsEs=VALUES(includedItemsEs),
         noteEn=VALUES(noteEn), noteEs=VALUES(noteEs), priceMode=VALUES(priceMode),
         startingPriceCents=VALUES(startingPriceCents), mayVary=VALUES(mayVary),
         sortOrder=VALUES(sortOrder), isEnabled=true, archivedAt=NULL`,
      [
        categoryId,
        addon.key,
        addon.nameEn,
        addon.nameEs,
        addon.descriptionEn ?? null,
        addon.descriptionEs ?? null,
        addon.includedItemsEn ? JSON.stringify(addon.includedItemsEn) : null,
        addon.includedItemsEs ? JSON.stringify(addon.includedItemsEs) : null,
        addon.noteEn ?? null,
        addon.noteEs ?? null,
        addon.priceMode,
        addon.startingPriceCents,
        addon.mayVary,
        addon.sortOrder,
      ]
    );
  }

  const [[counts]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM addon_categories) AS categories,
       (SELECT COUNT(*) FROM addons) AS addons,
       (SELECT settingValue FROM site_settings WHERE settingKey = ?) AS enabled`,
    [ADDON_CATALOG_FLAG_KEY]
  );
  if (Number(counts.categories) !== CATALOG_CATEGORY_SEED.length || Number(counts.addons) !== ALL_ADDON_SEED.length) {
    throw new Error(`Catalog parity failed: ${JSON.stringify(counts)}`);
  }
  await connection.commit();
  console.log(JSON.stringify({ ok: true, ...counts }));
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
