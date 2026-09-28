/**
 * The pricing tier editor's working model.
 *
 * The stored ladder is a list of exclusive upper bounds (`maxSqft`), each row
 * starting where the one before it ends — there is no room in that shape for a
 * gap or an overlap, which is what lets the quote engine price every size. The
 * editor, though, has to let the owner type a min and a max on each row,
 * insert a row between two others, and get rows out of order while doing it.
 * So it edits THIS shape — every row with its own min and max — and turns it
 * back into the stored ladder on save: sorted by max sq ft, mins snapped to the
 * previous row's max, and a warning for every place the typed boundaries did
 * not line up so the owner sees what the snap did.
 *
 * Position is never dragged; it is decided by the max sq ft, and nothing else.
 */
import type { PricingTier } from "./pricing";

export interface DraftTier {
  /** Lower bound in sq ft (inclusive). 0 for the first row. */
  minSqft: number;
  /** Upper bound in sq ft (exclusive). Infinity for the open-ended top row. */
  maxSqft: number;
  price: number;
  startingAt?: boolean;
  customQuote?: boolean;
}

export interface TierDraftResult {
  /** The ladder as it will be stored, sorted, mins implied. */
  tiers: PricingTier[];
  /** The same rows in stored order with their snapped mins, for the editor to adopt. */
  draft: DraftTier[];
  /** Blocking: the ladder cannot be stored while any of these hold. */
  errors: string[];
  /** Non-blocking: boundaries the save straightened out, described. */
  warnings: string[];
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "∞");

/** The stored ladder as editable rows: each row's min is its predecessor's max. */
export function draftFromTiers(tiers: readonly PricingTier[]): DraftTier[] {
  let previous = 0;
  return tiers.map(tier => {
    const row: DraftTier = { ...tier, minSqft: previous, maxSqft: tier.maxSqft };
    previous = Number.isFinite(tier.maxSqft) ? tier.maxSqft : previous;
    return row;
  });
}

/**
 * Sorts by max sq ft (open-ended row last), validates the result against the
 * stored-ladder rules, and reports every boundary that had to be snapped.
 */
export function normalizeTierDraft(rows: readonly DraftTier[], label = "tiers", maxRows = 25): TierDraftResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rows.length === 0) {
    return { tiers: [], draft: [], errors: [`${label}: needs at least one tier`], warnings };
  }
  if (rows.length > maxRows) errors.push(`${label}: at most ${maxRows} tiers (currently ${rows.length})`);

  const sorted = [...rows].sort((a, b) => {
    const aTop = !Number.isFinite(a.maxSqft);
    const bTop = !Number.isFinite(b.maxSqft);
    if (aTop !== bTop) return aTop ? 1 : -1;
    return a.maxSqft - b.maxSqft;
  });

  const open = sorted.filter(row => !Number.isFinite(row.maxSqft));
  if (open.length === 0) errors.push(`${label}: the last tier must be open-ended (no max sq ft) so every home size has a price`);
  if (open.length > 1) errors.push(`${label}: only one tier can be open-ended`);

  sorted.forEach((row, index) => {
    const position = index + 1;
    if (row.customQuote && index !== sorted.length - 1) {
      errors.push(`${label} tier ${position}: only the last tier may be a custom quote`);
    }
    if (!Number.isFinite(row.price) || row.price < 0) {
      errors.push(`${label} tier ${position}: price must be a number, 0 or more`);
    }
    if (!Number.isFinite(row.maxSqft)) return;
    if (!Number.isInteger(row.maxSqft) || row.maxSqft <= 0) {
      errors.push(`${label} tier ${position}: max sq ft must be a whole number above 0`);
      return;
    }
    const previous = index > 0 ? sorted[index - 1] : undefined;
    if (previous && Number.isFinite(previous.maxSqft) && previous.maxSqft === row.maxSqft) {
      errors.push(
        `${label}: two tiers both end at ${fmt(row.maxSqft)} sq ft — they overlap completely; change one of them`
      );
    }
  });

  // Snap mins and describe every boundary that moved. Each row's real lower
  // bound is its predecessor's max; a typed min above that leaves sizes with no
  // row of their own (they price at this row), and one below it claims sizes the
  // previous row already covers (they price at the previous row).
  let previousMax = 0;
  const draft: DraftTier[] = sorted.map((row, index) => {
    const position = index + 1;
    const typedMin = Number.isFinite(row.minSqft) ? Math.max(0, Math.round(row.minSqft)) : previousMax;
    if (index > 0 && typedMin !== previousMax && Number.isFinite(previousMax)) {
      if (typedMin > previousMax) {
        warnings.push(
          `${label} tier ${position}: ${fmt(previousMax)}–${fmt(typedMin)} sq ft had no tier (a gap) — this tier now starts at ${fmt(previousMax)}`
        );
      } else {
        warnings.push(
          `${label} tier ${position}: ${fmt(typedMin)}–${fmt(previousMax)} sq ft was covered twice (an overlap) — this tier now starts at ${fmt(previousMax)}`
        );
      }
    } else if (index === 0 && typedMin !== 0) {
      warnings.push(`${label} tier 1: the first tier always starts at 0 sq ft (was ${fmt(typedMin)})`);
    }
    const snapped: DraftTier = { ...row, minSqft: previousMax };
    if (Number.isFinite(row.maxSqft)) previousMax = row.maxSqft;
    return snapped;
  });

  const tiers: PricingTier[] = draft.map(row => {
    const tier: PricingTier = { maxSqft: row.maxSqft, price: row.price };
    if (row.startingAt) tier.startingAt = true;
    if (row.customQuote) tier.customQuote = true;
    return tier;
  });

  return { tiers, draft, errors, warnings };
}

/** Rounds to the nearest step, never below `floor`. */
function roundTo(n: number, step: number, floor: number): number {
  return Math.max(floor, Math.round(n / step) * step);
}

/**
 * A new row directly after `index`, sized to fit between its neighbours: its
 * max midway to the next row's max (to the nearest 50 sq ft), or one step
 * above when the next row is open-ended; its price midway between the two, or
 * a step above the row it follows. Null when the two rows sit too close for a
 * whole tier to fit between them.
 */
export function insertTierAfter(rows: readonly DraftTier[], index: number): DraftTier[] | null {
  const anchor = rows[index];
  if (!anchor || !Number.isFinite(anchor.maxSqft)) return null;
  const next = rows[index + 1];
  const previous = index > 0 ? rows[index - 1] : undefined;
  const width =
    previous && Number.isFinite(previous.maxSqft) ? Math.max(100, anchor.maxSqft - previous.maxSqft) : 200;

  let maxSqft: number;
  let price: number;
  if (next && Number.isFinite(next.maxSqft)) {
    const room = next.maxSqft - anchor.maxSqft;
    if (room < 2) return null;
    maxSqft = room >= 100 ? roundTo(anchor.maxSqft + room / 2, 50, anchor.maxSqft + 1) : anchor.maxSqft + Math.floor(room / 2);
    if (maxSqft >= next.maxSqft) maxSqft = anchor.maxSqft + Math.floor(room / 2);
    const nextPrice = next.customQuote ? anchor.price + 20 : next.price;
    price = Math.round(((anchor.price + nextPrice) / 2) * 100) / 100;
  } else {
    maxSqft = anchor.maxSqft + width;
    price = next?.customQuote || !next ? Math.round((anchor.price + 20) * 100) / 100 : Math.round(((anchor.price + next.price) / 2) * 100) / 100;
  }

  const inserted: DraftTier = { minSqft: anchor.maxSqft, maxSqft, price };
  const out = [...rows];
  out.splice(index + 1, 0, inserted);
  if (next) out[index + 2] = { ...next, minSqft: maxSqft };
  return out;
}

/** Whether a tier can be inserted after this row (see insertTierAfter). */
export function canInsertAfter(rows: readonly DraftTier[], index: number): boolean {
  return insertTierAfter(rows, index) !== null;
}
