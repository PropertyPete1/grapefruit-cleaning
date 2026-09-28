/**
 * The Services & Pricing tier editor: rows with their own min and max, a tier
 * inserted between any two, and a save that orders rows by max sq ft and
 * straightens the boundaries — with a warning for every one it had to.
 *
 * Position is never dragged; the max sq ft decides it. The stored ladder is
 * unchanged in shape (exclusive upper bounds), so the quote engine and the
 * server's strict validation are untouched: what this pins is the editor's
 * translation to and from that shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRICING, serializePricingConfig, validatePricingConfig, type PricingTier } from "@shared/pricing";
import { canInsertAfter, draftFromTiers, insertTierAfter, normalizeTierDraft, type DraftTier } from "@shared/tierDraft";

const ladder: PricingTier[] = [
  { maxSqft: 700, price: 79.99 },
  { maxSqft: 900, price: 89.99 },
  { maxSqft: 1100, price: 99.99 },
  { maxSqft: Infinity, price: 0, customQuote: true },
];

describe("draftFromTiers", () => {
  it("gives every row the min the stored shape implies", () => {
    expect(draftFromTiers(ladder)).toEqual([
      { minSqft: 0, maxSqft: 700, price: 79.99 },
      { minSqft: 700, maxSqft: 900, price: 89.99 },
      { minSqft: 900, maxSqft: 1100, price: 99.99 },
      { minSqft: 1100, maxSqft: Infinity, price: 0, customQuote: true },
    ]);
  });

  it("round-trips the shipped defaults with no warnings", () => {
    for (const table of Object.values(DEFAULT_PRICING.tiers)) {
      const result = normalizeTierDraft(draftFromTiers(table));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.tiers).toEqual(table);
    }
  });
});

describe("normalizeTierDraft", () => {
  it("orders rows by max sq ft on save, open-ended row last", () => {
    const rows: DraftTier[] = [
      { minSqft: 900, maxSqft: Infinity, price: 129.99 },
      { minSqft: 700, maxSqft: 1100, price: 99.99 },
      { minSqft: 0, maxSqft: 700, price: 79.99 },
      { minSqft: 1100, maxSqft: 900, price: 89.99 },
    ];
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.tiers.map(t => t.maxSqft)).toEqual([700, 900, 1100, Infinity]);
    expect(result.errors).toEqual([]);
  });

  it("warns about a gap and snaps the row down to its neighbour's max", () => {
    const rows = draftFromTiers(ladder);
    rows[2] = { ...rows[2], minSqft: 1000 }; // typed 1,000–1,100 above a row ending at 900
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "Residential tier 3: 900–1,000 sq ft had no tier (a gap) — this tier now starts at 900",
    ]);
    expect(result.draft[2].minSqft).toBe(900);
    expect(result.tiers).toEqual(ladder);
  });

  it("warns about an overlap and snaps the row up to its neighbour's max", () => {
    const rows = draftFromTiers(ladder);
    rows[2] = { ...rows[2], minSqft: 800 }; // typed 800–1,100 over a row ending at 900
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.warnings).toEqual([
      "Residential tier 3: 800–900 sq ft was covered twice (an overlap) — this tier now starts at 900",
    ]);
    expect(result.draft[2].minSqft).toBe(900);
  });

  it("describes the reorder a crossed max causes", () => {
    const rows = draftFromTiers(ladder);
    // Row 2's max typed past row 3's: 700–1,200 now sits after 900–1,100.
    rows[1] = { ...rows[1], maxSqft: 1200 };
    rows[2] = { ...rows[2], minSqft: 1200 };
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.tiers.map(t => t.maxSqft)).toEqual([700, 1100, 1200, Infinity]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join("\n")).toMatch(/gap|overlap/);
    // Whatever the warnings, the stored ladder is contiguous.
    expect(result.draft.map(r => r.minSqft)).toEqual([0, 700, 1100, 1200]);
  });

  it("rejects two rows that end at the same size — a total overlap the engine cannot price", () => {
    const rows = draftFromTiers(ladder);
    rows[1] = { ...rows[1], maxSqft: 1100 };
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.errors).toEqual([
      "Residential: two tiers both end at 1,100 sq ft — they overlap completely; change one of them",
    ]);
  });

  it("keeps the stored-ladder rules: an open-ended last row, one of them, custom quote last, sane numbers", () => {
    expect(normalizeTierDraft([{ minSqft: 0, maxSqft: 700, price: 79.99 }]).errors[0]).toMatch(/open-ended/);
    expect(
      normalizeTierDraft([
        { minSqft: 0, maxSqft: Infinity, price: 1 },
        { minSqft: 0, maxSqft: Infinity, price: 2 },
      ]).errors.join("\n")
    ).toMatch(/only one tier can be open-ended/);
    expect(
      normalizeTierDraft([
        { minSqft: 0, maxSqft: 700, price: 79.99, customQuote: true },
        { minSqft: 700, maxSqft: Infinity, price: 99.99 },
      ]).errors.join("\n")
    ).toMatch(/only the last tier may be a custom quote/);
    expect(
      normalizeTierDraft([
        { minSqft: 0, maxSqft: 0, price: 79.99 },
        { minSqft: 0, maxSqft: Infinity, price: 99.99 },
      ]).errors.join("\n")
    ).toMatch(/whole number above 0/);
    expect(
      normalizeTierDraft([
        { minSqft: 0, maxSqft: 700, price: -1 },
        { minSqft: 700, maxSqft: Infinity, price: 99.99 },
      ]).errors.join("\n")
    ).toMatch(/price must be a number, 0 or more/);
    expect(normalizeTierDraft([]).errors[0]).toMatch(/at least one tier/);
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ minSqft: i * 100, maxSqft: (i + 1) * 100, price: 50 + i }));
    tooMany.push({ minSqft: 2600, maxSqft: Infinity, price: 200 });
    expect(normalizeTierDraft(tooMany, "Residential", 25).errors.join("\n")).toMatch(/at most 25 tiers/);
  });

  it("produces a ladder the server's strict validation accepts", () => {
    const rows = draftFromTiers(ladder);
    rows[1] = { ...rows[1], maxSqft: 1200 };
    rows[2] = { ...rows[2], minSqft: 850 };
    const result = normalizeTierDraft(rows, "Residential");
    expect(result.errors).toEqual([]);
    const config = serializePricingConfig({ ...DEFAULT_PRICING, tiers: { ...DEFAULT_PRICING.tiers, residential: result.tiers } });
    expect(validatePricingConfig(config).ok).toBe(true);
  });

  it("carries the flags through", () => {
    const rows = draftFromTiers([
      { maxSqft: 3500, price: 249.99, startingAt: true },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ]);
    expect(normalizeTierDraft(rows).tiers).toEqual([
      { maxSqft: 3500, price: 249.99, startingAt: true },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ]);
  });
});

describe("insertTierAfter", () => {
  it("fits a new row halfway between two neighbours and hands the next row its new min", () => {
    const rows = draftFromTiers(ladder);
    const out = insertTierAfter(rows, 0)!;
    expect(out.map(r => [r.minSqft, r.maxSqft])).toEqual([
      [0, 700],
      [700, 800],
      [800, 900],
      [900, 1100],
      [1100, Infinity],
    ]);
    expect(out[1].price).toBe(84.99);
    expect(normalizeTierDraft(out).warnings).toEqual([]);
  });

  it("rounds a wide gap to 50 sq ft and prices midway", () => {
    const out = insertTierAfter(
      draftFromTiers([
        { maxSqft: 1000, price: 100 },
        { maxSqft: 1830, price: 150 },
        { maxSqft: Infinity, price: 200 },
      ]),
      0
    )!;
    expect(out[1]).toEqual({ minSqft: 1000, maxSqft: 1400, price: 125 });
    expect(out[2].minSqft).toBe(1400);
  });

  it("steps above the last bounded row when the next row is open-ended", () => {
    const out = insertTierAfter(draftFromTiers(ladder), 2)!;
    // 900→1,100 was a 200 sq ft step; the new row continues it, $20 up, and
    // the custom-quote row now starts where it ends.
    expect(out[3]).toEqual({ minSqft: 1100, maxSqft: 1300, price: 119.99 });
    expect(out[4]).toMatchObject({ minSqft: 1300, maxSqft: Infinity, customQuote: true });
  });

  it("refuses when the two rows sit too close for a whole tier", () => {
    const rows = draftFromTiers([
      { maxSqft: 700, price: 79.99 },
      { maxSqft: 701, price: 89.99 },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ]);
    expect(insertTierAfter(rows, 0)).toBeNull();
    expect(canInsertAfter(rows, 0)).toBe(false);
    expect(canInsertAfter(rows, 1)).toBe(true);
    // Nothing goes after the open-ended row.
    expect(insertTierAfter(rows, 2)).toBeNull();
  });

  it("squeezes a small room without rounding past the neighbour", () => {
    const rows = draftFromTiers([
      { maxSqft: 700, price: 79.99 },
      { maxSqft: 760, price: 89.99 },
      { maxSqft: Infinity, price: 0, customQuote: true },
    ]);
    const out = insertTierAfter(rows, 0)!;
    expect(out[1].maxSqft).toBe(730);
    expect(out[2].minSqft).toBe(730);
  });
});

describe("the editor page", () => {
  const source = readFileSync(fileURLToPath(new URL("../client/src/pages/admin/AdminServices.tsx", import.meta.url)), "utf-8");

  it("edits min and max inline, inserts between rows, and saves through the normalizer", () => {
    expect(source).toContain("Min sq ft");
    expect(source).toContain("Max sq ft");
    expect(source).toMatch(/Insert \$\{label\} tier after tier/);
    expect(source).toContain("insertTierAfter(rows, idx)");
    expect(source).toContain("normalizeTierDraft(rows, SERVICE_LABELS[service] ?? service, MAX_TIERS_PER_SERVICE)");
    expect(source).toContain("rows are ordered by max sq ft when you save");
    // Saving adopts the sorted, snapped rows and sends the stored shape.
    expect(source).toContain("residential: reports.residential.tiers");
    expect(source).toContain("residential: reports.residential.draft");
    expect(source).toContain("save.mutate({ config: serializePricingConfig({ ...draft, tiers }) })");
  });

  it("shows warnings without blocking, and errors as blockers", () => {
    expect(source).toContain("tier-warnings-${svc}");
    expect(source).toContain("report.warnings.map(warning =>");
    expect(source).toContain("report.errors.map(problem =>");
    expect(source).toContain("disabled={!dirty || save.isPending || problems.length > 0}");
  });

  it("couples a typed min to the row above's max, and a typed max to the row below's min", () => {
    expect(source).toContain("rows[idx - 1] = { ...rows[idx - 1], maxSqft: n }");
    expect(source).toContain("rows[idx + 1] = { ...rows[idx + 1], minSqft: n }");
  });

  it("has no drag handles — position comes from the numbers", () => {
    expect(source).not.toMatch(/draggable|onDragStart|GripVertical/);
  });
});
