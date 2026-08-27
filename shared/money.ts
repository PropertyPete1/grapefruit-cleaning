/**
 * Exact-money bridge for the catalog-v2 rollout.
 *
 * Existing database columns store whole legacy dollars. New nullable columns
 * store integer cents. Reads prefer cents and fall back to legacy dollars;
 * writes populate both so the feature flag can roll back without dropping
 * data or changing the meaning of any historical column.
 */
export const CENTS_PER_DOLLAR = 100;

export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error("Money must be a finite number");
  return Math.round((dollars + Number.EPSILON) * CENTS_PER_DOLLAR);
}

export function centsToDollars(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("Cents must be an integer");
  return cents / CENTS_PER_DOLLAR;
}

/** Prefer an exact cents snapshot; otherwise lift the historical dollar value. */
export function moneyCents(cents: number | null | undefined, legacyDollars: number): number {
  return cents == null ? dollarsToCents(legacyDollars) : cents;
}

/** Compatibility value for the unchanged legacy INT columns. */
export function legacyWholeDollars(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("Cents must be an integer");
  return Math.round(cents / CENTS_PER_DOLLAR);
}

/** Deposit is rounded once, in cents, from the exact final total. */
export function depositCents(totalCents: number, rate: number): number {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("Total cents must be a non-negative integer");
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error("Deposit rate must be between 0 and 1");
  return Math.round(totalCents * rate);
}

export function dualMoney(cents: number): { cents: number; legacyDollars: number } {
  return { cents, legacyDollars: legacyWholeDollars(cents) };
}

export function formatCents(cents: number): string {
  return centsToDollars(cents).toFixed(2);
}
