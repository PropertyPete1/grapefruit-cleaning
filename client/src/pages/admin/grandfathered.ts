/**
 * The grandfathered-price dialog's arithmetic, kept apart from its markup so
 * the rule "prefill from what she actually paid" can be tested on its own.
 */
import type { CleaningType } from "@shared/pricing";
import { paidPerVisitCents } from "@shared/priceLock";

/** The booking facts the history reads (a subset of the customerDetail rows). */
export interface HistoryBooking {
  id: number;
  reference: string;
  status: string;
  serviceType: string | null;
  frequency: string;
  sqft: number | null;
  scheduledDate: string | null;
  totalAmount: number;
  totalAmountCents: number | null;
  addonsAmountCents: number | null;
  grandfatheredBaseCents?: number | null;
}

/** Completed jobs, newest first — what she has actually paid. */
export function completedHistory(bookings: readonly HistoryBooking[]): HistoryBooking[] {
  return bookings
    .filter(b => b.status === "completed")
    .sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""));
}

/**
 * The prefill: her current rate if one is set, else what her last completed
 * cleaning came to per visit (that visit's extras taken back out), else blank.
 * The owner confirms; nothing is set from here.
 */
export function suggestedRate(
  customer: { grandfatheredPriceCents: number | null; grandfatheredServiceType: string | null },
  history: readonly HistoryBooking[]
): { price: string; serviceType: CleaningType; from: HistoryBooking | null } {
  const latest = history[0] ?? null;
  if (customer.grandfatheredPriceCents != null && customer.grandfatheredServiceType) {
    return {
      price: (customer.grandfatheredPriceCents / 100).toFixed(2),
      serviceType: customer.grandfatheredServiceType as CleaningType,
      from: latest,
    };
  }
  if (latest) {
    return {
      price: (paidPerVisitCents(latest) / 100).toFixed(2),
      serviceType: (latest.serviceType as CleaningType | null) ?? "residential",
      from: latest,
    };
  }
  return { price: "", serviceType: "residential", from: null };
}
