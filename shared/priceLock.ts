/**
 * Grandfathered pricing — one customer's locked per-cleaning price, and the
 * matching that decides when it applies.
 *
 * Customers have no accounts; a booking is a guest checkout. So the lock is
 * keyed to the customer RECORD and found again at booking time by contact
 * details, normalized the way people actually type them: email lowercased and
 * trimmed, phone reduced to its digits (with a leading US country code
 * dropped). The service address is a SECONDARY signal only — it never applies a
 * price on its own (a new tenant at an old address is not the old client), but
 * it lets the admin pages suggest the manual fallback when the contact did not
 * match.
 *
 * Shared because three writers price bookings (the public flow, the admin
 * form, the deposit link) and two previews draw them (the pay page, the admin
 * panel): one definition of "matches" and one of "applies", or the lock leaks
 * to someone else somewhere.
 */
import type { CleaningType } from "./pricing";

/** The lock as the pricing engine consumes it. */
export interface PriceLock {
  /** Locked per-visit price before extras, in cents. */
  basePriceCents: number;
  /** The one service the lock is for; other services price from the catalog. */
  serviceType: CleaningType;
  /** Whose rate this is — for the admin label and the booking's audit columns. */
  customerId: number;
  customerName: string;
}

/** The customer columns the lock is read from. */
export interface GrandfatheredCustomerRow {
  id: number;
  firstName: string;
  lastName: string;
  grandfatheredPriceCents: number | null;
  grandfatheredServiceType: string | null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

/**
 * Digits only, with a leading "1" dropped from an 11-digit US number so
 * "+1 (210) 555-0134" and "210-555-0134" are the same phone. Fewer than seven
 * digits is not a phone number and never matches anything.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length >= 7 ? national : null;
}

/**
 * A street line reduced to what identifies it: lowercase, one space between
 * words, punctuation gone, common suffixes spelled the short way. "5500 Grand
 * Lake Drive" and "5500 grand lake dr." compare equal; the unit is stripped so
 * a customer record without one still matches a booking that names it.
 */
export function normalizeAddressLine(value: string | null | undefined): string | null {
  let line = (value ?? "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return null;
  line = line.replace(/\b(apt|apartment|unit|ste|suite|bldg|building|fl|floor|no)\s*[a-z0-9-]+\b/g, "").trim();
  const suffixes: Record<string, string> = {
    street: "st",
    avenue: "ave",
    boulevard: "blvd",
    drive: "dr",
    road: "rd",
    lane: "ln",
    court: "ct",
    circle: "cir",
    place: "pl",
    parkway: "pkwy",
    trail: "trl",
    terrace: "ter",
    highway: "hwy",
  };
  line = line
    .split(" ")
    .map(word => suffixes[word] ?? word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return line || null;
}

/** The lock a customer row carries, or null when they pay catalog prices. */
export function lockFromCustomer(customer: GrandfatheredCustomerRow | null | undefined): PriceLock | null {
  if (!customer || customer.grandfatheredPriceCents == null || !customer.grandfatheredServiceType) return null;
  if (!Number.isInteger(customer.grandfatheredPriceCents) || customer.grandfatheredPriceCents <= 0) return null;
  return {
    basePriceCents: customer.grandfatheredPriceCents,
    serviceType: customer.grandfatheredServiceType as CleaningType,
    customerId: customer.id,
    customerName: `${customer.firstName} ${customer.lastName}`.trim(),
  };
}

/** Whether a booking for this service is priced by the lock. */
export function lockAppliesTo(lock: PriceLock | null | undefined, serviceType: string | null | undefined): lock is PriceLock {
  return Boolean(lock && serviceType && lock.serviceType === serviceType);
}

/**
 * Whether new contact details belong to this customer row — normalized email
 * OR normalized phone. Blank details match nothing.
 */
export function contactMatchesCustomer(
  customer: { email: string | null; phone: string | null },
  contact: { email?: string | null; phone?: string | null }
): boolean {
  const email = normalizeEmail(contact.email);
  const phone = normalizePhone(contact.phone);
  if (email && normalizeEmail(customer.email) === email) return true;
  if (phone && normalizePhone(customer.phone) === phone) return true;
  return false;
}

/**
 * The secondary signal: the booking's service address is the customer's
 * address on file (street line, plus ZIP when both sides have one).
 */
export function addressMatchesCustomer(
  customer: { address: string | null; zip: string | null },
  booking: { addressLine: string | null; zip: string | null }
): boolean {
  const mine = normalizeAddressLine(customer.address);
  const theirs = normalizeAddressLine(booking.addressLine);
  if (!mine || !theirs || mine !== theirs) return false;
  const myZip = (customer.zip ?? "").trim().slice(0, 5);
  const theirZip = (booking.zip ?? "").trim().slice(0, 5);
  if (myZip && theirZip && myZip !== theirZip) return false;
  return true;
}

/**
 * Among the grandfathered customers, the one these contact details belong to.
 * An email match outranks a phone match; with neither, nobody — the address
 * deliberately plays no part here.
 */
export function findLockedCustomer<T extends GrandfatheredCustomerRow & { email: string | null; phone: string | null }>(
  candidates: readonly T[],
  contact: { email?: string | null; phone?: string | null }
): T | null {
  const email = normalizeEmail(contact.email);
  const phone = normalizePhone(contact.phone);
  const locked = candidates.filter(c => lockFromCustomer(c) !== null);
  if (email) {
    const byEmail = locked.find(c => normalizeEmail(c.email) === email);
    if (byEmail) return byEmail;
  }
  if (phone) {
    const byPhone = locked.find(c => normalizePhone(c.phone) === phone);
    if (byPhone) return byPhone;
  }
  return null;
}

/**
 * The per-visit figure a past booking shows the customer paid — the total with
 * that visit's extras taken back out when the exact snapshot exists, so the
 * owner's dialog prefills the rate itself rather than a total that happened to
 * include an oven.
 */
export function paidPerVisitCents(booking: {
  totalAmount: number;
  totalAmountCents: number | null;
  addonsAmountCents: number | null;
}): number {
  const total = booking.totalAmountCents ?? Math.round(booking.totalAmount * 100);
  const extras = booking.addonsAmountCents ?? 0;
  return Math.max(0, total - extras);
}
