/**
 * Pure rules for an admin-created booking's deposit link, shared by the admin
 * router, the pay-page procedures and the appointments list. Kept free of DB
 * and Stripe imports so they are unit-testable (same shape as bookingRules.ts
 * and balanceRules.ts).
 *
 * The flow these describe: the owner takes a lead by phone or text, enters the
 * basics, and sends a personal link. The CUSTOMER opens it, picks their own
 * extras, watches the price move, and pays the deposit. Everything about the
 * money is recomputed server-side at that moment — the client sends extra IDs
 * and nothing else.
 */
import type { BookingNeeds, DepositLinkStatus } from "@shared/depositLinkStatus";
import { STALE_DEPOSIT_MINUTES } from "./bookingRules";

/**
 * The link's validity window is the slot hold, not a separate clock.
 *
 * Deliberately the same span: the link's whole promise is "this appointment is
 * yours until X". A token outliving the hold would take a deposit for a slot
 * already given away; a token dying first would strand a customer holding an
 * appointment they can no longer pay for.
 */
export function depositLinkExpiresAt(createdAt: Date, holdMinutes: number): Date {
  return new Date(createdAt.getTime() + holdMinutes * 60_000);
}

export type { BookingNeeds, DepositLinkStatus };

/** The row fields completeness is judged from. */
export interface CompletionFields {
  serviceType?: string | null;
  sqft?: number | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
}

/**
 * What a booking still needs before its deposit can be taken.
 *
 * Judged from the row alone: a NULL fact is a missing fact, whoever's turn it
 * is to supply it. This is what the customer page's question list and the
 * admin table's "incomplete" badge are both derived from, so they can never
 * disagree about whether a link is finished.
 */
export function bookingNeeds(booking: CompletionFields): BookingNeeds {
  return {
    service: booking.serviceType == null,
    size: booking.sqft == null,
    slot: booking.scheduledDate == null || booking.scheduledTime == null,
  };
}

/** True once every fact needed to price and schedule the job is present. */
export function isBookingComplete(booking: CompletionFields): boolean {
  const needs = bookingNeeds(booking);
  return !needs.service && !needs.size && !needs.slot;
}

/** Facts the owner locked at creation, parsed from the adminProvided CSV. */
export type ProvidedFact = "service" | "size" | "address" | "slot";

export function parseAdminProvided(raw: string | null | undefined): Set<ProvidedFact> {
  if (!raw) return new Set();
  const valid: ProvidedFact[] = ["service", "size", "address", "slot"];
  return new Set(
    raw
      .split(",")
      .map(part => part.trim())
      .filter((part): part is ProvidedFact => (valid as string[]).includes(part))
  );
}

export function serializeAdminProvided(facts: Iterable<ProvidedFact>): string | undefined {
  const list = Array.from(new Set(facts));
  return list.length > 0 ? list.join(",") : undefined;
}

/**
 * Deposit-link state shown in Admin → Appointments.
 * - "none": no link was ever issued (every self-serve booking).
 * - "paid": the deposit landed — the booking is confirmed or beyond.
 * - "expired": the window closed with the deposit still unpaid.
 * - "awaiting_payment": link is live and payable.
 */
export function depositLinkStatus(
  booking: CompletionFields & {
    status: string;
    /** The token itself server-side; list rows pass hasPayToken instead. */
    payToken?: string | null;
    hasPayToken?: boolean;
    payTokenExpiresAt?: Date | string | null;
  },
  now: Date = new Date()
): DepositLinkStatus {
  const issued = booking.payToken ? true : (booking.hasPayToken ?? false);
  if (!issued) return "none";
  // Checked before the clock: a booking that has been paid is never "expired",
  // however long ago the window closed. Same reasoning as balanceLinkStatus.
  if (booking.status !== "pending_deposit") {
    return booking.status === "cancelled" || booking.status === "expired" ? "expired" : "paid";
  }
  if (booking.payTokenExpiresAt) {
    const expires = new Date(booking.payTokenExpiresAt).getTime();
    // A dead link outranks an unfinished one: whatever is missing, the fix is
    // the same — resend — and "incomplete" would suggest the customer can
    // still open it.
    if (Number.isFinite(expires) && expires <= now.getTime()) return "expired";
  }
  return isBookingComplete(booking) ? "awaiting_payment" : "incomplete";
}

/** True while the link may still mint a Checkout Session. */
export function isDepositLinkPayable(
  booking: CompletionFields & {
    status: string;
    payToken?: string | null;
    hasPayToken?: boolean;
    payTokenExpiresAt?: Date | string | null;
  },
  now: Date = new Date()
): boolean {
  return depositLinkStatus(booking, now) === "awaiting_payment";
}

/** True while the customer may still open the link and work on it. */
export function isDepositLinkOpen(
  booking: CompletionFields & {
    status: string;
    payToken?: string | null;
    hasPayToken?: boolean;
    payTokenExpiresAt?: Date | string | null;
  },
  now: Date = new Date()
): boolean {
  const status = depositLinkStatus(booking, now);
  return status === "awaiting_payment" || status === "incomplete";
}

/**
 * Lifetime to give one Stripe Checkout Session minted from this link, in
 * seconds, clamped to what Stripe accepts (30 minutes to 24 hours).
 *
 * A fresh session per attempt is what lets the customer change their extras and
 * pay again, so the session only has to outlive one sitting. It is capped at
 * the remaining hold so a session cannot outlive the slot it is paying for.
 */
export function depositSessionSeconds(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date()
): number {
  const MIN = 30 * 60;
  const MAX = 24 * 60 * 60;
  if (!expiresAt) return STALE_DEPOSIT_MINUTES * 60;
  const remaining = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(remaining)) return STALE_DEPOSIT_MINUTES * 60;
  return Math.max(MIN, Math.min(MAX, remaining));
}

/** Customer-facing deposit link for a booking token. */
export function depositPayUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/pay/deposit/${token}`;
}
