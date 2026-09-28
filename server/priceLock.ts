/**
 * Grandfathered pricing, server side: finding the customer a set of contact
 * details belongs to, and the lock that prices a booking.
 *
 * The rules themselves — how an email or phone is normalized, when a lock
 * applies — live in shared/priceLock.ts so the pay page's preview and the
 * admin panel run the same ones. This file only adds the database.
 */
import { findLockedCustomer, lockAppliesTo, lockFromCustomer, type PriceLock } from "@shared/priceLock";
import * as db from "./db";

/**
 * The grandfathered customer these contact details identify, or null. Blank
 * details identify nobody, and so does anyone whose email and phone are both
 * new to us — the lock is never applied on a guess.
 */
export async function findGrandfatheredCustomer(contact: { email?: string | null; phone?: string | null }) {
  if (!contact.email?.trim() && !contact.phone?.trim()) return null;
  const candidates = await db.listGrandfatheredCustomers();
  if (candidates.length === 0) return null;
  return findLockedCustomer(candidates, contact);
}

/**
 * The lock that prices a booking's service right now: the record the owner
 * tied it to by hand if there is one, else the booking's own customer — and
 * only when that record's locked service is this booking's service. Read
 * live rather than from the booking's snapshot, so a link where the customer
 * changes service reprices correctly and a rate the owner removed stops
 * applying.
 */
export async function lockForBooking(
  booking: { customerId: number; grandfatheredCustomerId: number | null },
  serviceType: string | null | undefined
): Promise<PriceLock | null> {
  if (!serviceType) return null;
  const customer = await db.getCustomerById(booking.grandfatheredCustomerId ?? booking.customerId);
  const lock = lockFromCustomer(customer);
  return lockAppliesTo(lock, serviceType) ? lock : null;
}

/** The booking columns that record which rate priced it (or that the catalog did). */
export function grandfatheredColumns(lock: PriceLock | null | undefined): {
  grandfatheredBaseCents: number | null;
  grandfatheredCustomerId: number | null;
} {
  return {
    grandfatheredBaseCents: lock ? lock.basePriceCents : null,
    grandfatheredCustomerId: lock ? lock.customerId : null,
  };
}
