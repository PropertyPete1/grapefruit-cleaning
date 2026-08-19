/**
 * Invoice line items: what a balance invoice is actually billing FOR.
 *
 * Before these, an admin could only overwrite the invoice's single amount —
 * the customer got a bigger number with no explanation, and the admin had no
 * record of why. Now the review screen picks add-ons from the live catalog
 * and names any one-off charge, and the invoice stores the itemization as a
 * snapshot.
 *
 * SNAPSHOT, deliberately: each item carries the name and price it was billed
 * at, resolved at approval time. Editing the catalog later must not rewrite
 * a sent invoice — the same pinning rule as estimatedHours and totalAmount.
 * Add-on items also keep their catalog id so customer-facing surfaces can
 * label them in the customer's own language; custom items render their given
 * name verbatim in both.
 *
 * Shared between server and admin UI so the approval screen's running total
 * previews the exact arithmetic the server will charge.
 */
import { EXTRA_IDS, type ExtraId } from "./pricing";

export interface AddonLineItem {
  kind: "addon";
  /** Catalog id, kept so emails can localize the label. */
  id: ExtraId;
  /** English display name as billed — the admin-facing snapshot. */
  name: string;
  /** Whole dollars, price at approval time. */
  amount: number;
}

export interface CustomLineItem {
  kind: "custom";
  /**
   * REQUIRED and non-empty: an unlabeled amount is exactly the mystery charge
   * this feature exists to kill.
   */
  name: string;
  /** Whole dollars. */
  amount: number;
}

export type InvoiceLineItem = AddonLineItem | CustomLineItem;

/** Bounds for a single custom item, in whole dollars. */
export const CUSTOM_ITEM_MIN = 1;
export const CUSTOM_ITEM_MAX = 25000;
/** Sanity cap on items per invoice. */
export const MAX_LINE_ITEMS = 20;

/** Sum of an item list, in whole dollars. */
export function lineItemsTotal(items: InvoiceLineItem[]): number {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

/**
 * True for a well-formed item. The rules the whole feature hangs on:
 * every item is named, every amount is a positive whole-dollar figure within
 * bounds, and add-on ids come from the catalog.
 */
export function isValidLineItem(item: unknown): item is InvoiceLineItem {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) return false;
  if (candidate.name.length > 120) return false;
  if (
    typeof candidate.amount !== "number" ||
    !Number.isInteger(candidate.amount) ||
    candidate.amount < CUSTOM_ITEM_MIN ||
    candidate.amount > CUSTOM_ITEM_MAX
  ) {
    return false;
  }
  if (candidate.kind === "custom") return true;
  if (candidate.kind === "addon") {
    return typeof candidate.id === "string" && (EXTRA_IDS as readonly string[]).includes(candidate.id);
  }
  return false;
}

/**
 * Parse the stored lineItems column. Missing or corrupt input is an empty
 * list — an invoice without items is the pre-feature shape and must keep
 * working — and individually malformed entries are dropped rather than
 * poisoning the rest.
 */
export function parseLineItems(raw: string | null | undefined): InvoiceLineItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidLineItem).slice(0, MAX_LINE_ITEMS);
  } catch {
    return [];
  }
}

/** Serialize for storage; empty lists store NULL so old rows and new agree. */
export function serializeLineItems(items: InvoiceLineItem[]): string | null {
  return items.length > 0 ? JSON.stringify(items) : null;
}

/**
 * The base (service) portion of an invoice whose stored amount includes
 * items: what is left after the itemized charges. Never below zero — a
 * corrupt row must not render a negative service line.
 */
export function baseAmountOf(invoiceAmount: number, items: InvoiceLineItem[]): number {
  return Math.max(0, invoiceAmount - lineItemsTotal(items));
}
