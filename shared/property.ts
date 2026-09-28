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

/**
 * The largest home any quote will price, and the smallest. A county record
 * above the cap is a building, a strip mall, or a parcel mismatch — never one
 * customer's home — and is treated as a failed lookup even with no entered
 * figure to compare against. The same cap bounds every square-footage input,
 * public and admin, so an absurd number cannot reach a quote by any road.
 */
export const MAX_HOME_SQFT = 10_000;
export const MIN_HOME_SQFT = 200;

export function plausibleVerifiedSqft(
  enteredSqft: number | null | undefined,
  verifiedSqft: number
): boolean {
  if (!Number.isFinite(verifiedSqft) || verifiedSqft <= 0 || verifiedSqft > MAX_HOME_SQFT) return false;
  if (enteredSqft == null || enteredSqft <= 0) return true;
  return verifiedSqft <= enteredSqft * VERIFIED_SQFT_MAX_MULTIPLE;
}

/**
 * Whether a street line names a unit — "Apt 204", "Unit 5B", "#12", "Ste
 * 300", "Condo 7". A unit address is an apartment or condo whatever the
 * property-type toggle says, so the county lookup (which would return the
 * whole building) is skipped and the customer is asked for the unit's own
 * square footage. Street names that merely contain one of these words
 * ("Building Blvd") do not count: the designator has to be followed by a unit
 * token.
 */
export function looksLikeUnitAddress(addressLine: string | null | undefined): boolean {
  const line = (addressLine ?? "").trim();
  if (!line) return false;
  // A unit token is a number-led code ("204", "5B", "300-A") or a single
  // letter ("B") — never a whole word, so "Condo Ln" and "Building Blvd" stay
  // street names.
  const token = String.raw`(?:\d[a-z0-9-]*|[a-z](?:\d[a-z0-9-]*)?)\b`;
  if (new RegExp(String.raw`(?:^|[\s,])#\s*${token}`, "i").test(line)) return true;
  return new RegExp(
    String.raw`(?:^|[\s,])(?:apt|apartment|unit|ste|suite|condo|bldg|building|fl|floor)\.?\s*#?\s*${token}`,
    "i"
  ).test(line);
}

/**
 * A square footage a quote may be built on: a whole number inside the home
 * range. Null for anything else — blank, text, a building.
 */
export function acceptableSqft(value: number | string | null | undefined): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (n == null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_HOME_SQFT || rounded > MAX_HOME_SQFT) return null;
  return rounded;
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
/**
 * A part that is genuinely absent — null, undefined, blank, or the literal
 * strings "null"/"undefined" that a stringified nullable leaves behind. The
 * last two should never reach the database, but an address that renders as
 * "null, null" is embarrassing enough to guard against at the render boundary
 * rather than trusting every writer forever.
 */
function presentPart(part: string | null | undefined): string | null {
  if (typeof part !== "string") return null;
  const trimmed = part.trim();
  if (!trimmed || /^(null|undefined)$/i.test(trimmed)) return null;
  return trimmed;
}

export function composeAddress(parts: {
  addressLine?: string | null;
  unitNumber?: string | null;
  city?: string | null;
  zip?: string | null;
}): string {
  const unit = presentPart(parts.unitNumber) ?? undefined;
  const unitLabel = unit
    ? /^(apt|unit|ste|suite|bldg|fl|floor|#|no\.?)\b/i.test(unit) || /^#/.test(unit)
      ? unit
      : `Apt ${unit}`
    : null;
  return [presentPart(parts.addressLine), unitLabel, presentPart(parts.city), presentPart(parts.zip)]
    .filter(Boolean)
    .join(", ");
}

/**
 * The address as a display string, with a friendly fallback when no part of
 * it exists yet — a slotless phone lead is a name and a number, and its card
 * should say so rather than rendering an empty cell (or worse, "null, null",
 * which is what a raw template literal once made of it).
 */
export function composeAddressOr(
  parts: Parameters<typeof composeAddress>[0],
  fallback: string
): string {
  return composeAddress(parts) || fallback;
}
