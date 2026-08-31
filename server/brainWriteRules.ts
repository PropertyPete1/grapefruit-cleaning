/**
 * Pure decision logic for the brain write API (see brainWriteRoutes.ts).
 *
 * Kept free of Express, DB and Stripe imports so it stays unit-testable, in
 * the same spirit as bookingRules.ts and balanceRules.ts. Two rules live here:
 * what a matched customer row may learn from a brain write (blanks only,
 * never an overwrite), and how an attribution line joins a booking's notes
 * without disturbing the customer-written section.
 */
import type { Customer } from "../drizzle/schema";
import { adminNotesOf, customerNotesOf, mergeCustomerNotes } from "./notesMerge";

/** The contact fields a brain write may propose for an existing customer. */
export interface BrainCustomerFacts {
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  zip?: string;
}

/**
 * What a matched customer row actually learns from a brain write: blanks
 * filled, nothing overwritten. `findOrCreateCustomer` as it stands rewrites
 * the matched row's name and contact fields from the input — right for the
 * admin panel, where the owner is looking at the form, and wrong for a voice
 * write, where the brain proposes "create" and must never silently rewrite.
 * An empty result means the row already knew everything offered.
 */
export function customerFillsFor(
  existing: Pick<Customer, "lastName" | "email" | "phone" | "address" | "city" | "zip">,
  incoming: BrainCustomerFacts
): Partial<BrainCustomerFacts> {
  const fills: Partial<BrainCustomerFacts> = {};
  if (!existing.lastName && incoming.lastName) fills.lastName = incoming.lastName;
  if (!existing.email && incoming.email) fills.email = incoming.email;
  if (!existing.phone && incoming.phone) fills.phone = incoming.phone;
  if (!existing.address && incoming.address) fills.address = incoming.address;
  if (!existing.city && incoming.city) fills.city = incoming.city;
  if (!existing.zip && incoming.zip) fills.zip = incoming.zip;
  return fills;
}

/**
 * A booking's notes with an attribution line appended to the ADMIN section.
 *
 * The line lands before the "From customer:" boundary, so the customer's own
 * section survives verbatim and the audit line stays on the staff-only side —
 * the pay page never renders the admin part, which is exactly where
 * "[via PRIMARY — <operator>]" belongs.
 */
export function withAuditLine(notes: string | null | undefined, line: string): string {
  const admin = adminNotesOf(notes);
  return mergeCustomerNotes(admin ? `${admin}\n${line}` : line, customerNotesOf(notes));
}
