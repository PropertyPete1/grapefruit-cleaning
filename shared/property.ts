/**
 * Property facts shared by client and server: the house/apartment distinction,
 * the plausibility guard on county-verified square footage, and the one way an
 * address (with its unit) is rendered anywhere.
 */

/**
 * What kind of property is being cleaned.
 *
 * The distinction exists because county parcels are BUILDING-level: a lookup
 * for "Unit 204" either finds nothing or finds the whole complex — and the
 * whole complex's square footage must never reprice a one-bedroom upward. So
 * apartments and condos skip county verification entirely; the entered size
 * stands, confirmed at the appointment like any unverified home.
 */
export const PROPERTY_TYPES = ["house", "apartment"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * Whether a county-verified square footage is believable for the size the
 * customer entered.
 *
 * A parcel more than 4x the entered figure is almost never the customer's
 * home — it is the complex, the strip mall, or a mismatched record — and is
 * treated as a FAILED lookup rather than a reprice. Only bites when there is
 * an entered figure to compare against; an address-only lookup has no baseline
 * and the record stands.
 *
 * Shared because the compare runs in four places — the public quote preview,
 * the booking page preview, booking.create, and the admin/link pricing — and
 * a guard applied in three of them is a guard with a hole in it.
 */
export const VERIFIED_SQFT_MAX_MULTIPLE = 4;

export function plausibleVerifiedSqft(
  enteredSqft: number | null | undefined,
  verifiedSqft: number
): boolean {
  if (enteredSqft == null || enteredSqft <= 0) return true;
  return verifiedSqft <= enteredSqft * VERIFIED_SQFT_MAX_MULTIPLE;
}

/**
 * The one way an address renders, unit included: "1 Main St, Apt 204, San
 * Antonio, 78201". The crew reads this off job cards and emails, and "Apt 204"
 * is the difference between a cleaning and twenty minutes of knocking on
 * doors.
 *
 * A unit that already names its own designator ("Unit 5B", "#12", "Ste 300")
 * renders as typed; a bare number gets "Apt" in front.
 */
export function composeAddress(parts: {
  addressLine?: string | null;
  unitNumber?: string | null;
  city?: string | null;
  zip?: string | null;
}): string {
  const unit = parts.unitNumber?.trim();
  const unitLabel = unit
    ? /^(apt|unit|ste|suite|bldg|fl|floor|#|no\.?)\b/i.test(unit) || /^#/.test(unit)
      ? unit
      : `Apt ${unit}`
    : null;
  return [parts.addressLine, unitLabel, parts.city, parts.zip]
    .map(part => (typeof part === "string" ? part.trim() : part))
    .filter(Boolean)
    .join(", ");
}
