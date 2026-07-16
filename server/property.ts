/**
 * Property square-footage verification against public records.
 *
 * Primary source: Bexar County (San Antonio, TX) public GIS parcel service —
 * free, no API key, data straight from the Bexar County Appraisal District.
 *   https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query
 *
 * The lookup is best-effort: when no record is found (outside Bexar County,
 * new construction, unparseable address) we return `verified: false` and the
 * quote/booking proceeds with the customer-entered square footage.
 */

export interface PropertyLookupResult {
  verified: boolean;
  /** Living/building area in square feet from the county record. */
  sqft?: number;
  yearBuilt?: number;
  stories?: number;
  /** Which data source produced the match. */
  source?: "bexar_gis";
  /** The county situs address the record matched, for display/audit. */
  matchedAddress?: string;
  /** Why the lookup did not verify (coverage vs. no record), for UI/audit. */
  reason?: "outside_coverage" | "not_found" | "unparseable";
}

const BEXAR_QUERY_URL = "https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query";
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * Bexar County ZIP codes (San Antonio metro and county municipalities).
 * Used to decide coverage when the customer provides a ZIP: an address with a
 * non-Bexar ZIP is returned as unverified rather than risking a false match on
 * a same-named street inside the county.
 */
const BEXAR_ZIPS = new Set([
  "78002", "78015", "78023", "78039", "78052", "78054", "78056", "78059", "78063", "78064",
  "78069", "78073", "78101", "78109", "78112", "78124", "78148", "78150", "78152", "78154",
  "78163", "78201", "78202", "78203", "78204", "78205", "78206", "78207", "78208", "78209",
  "78210", "78211", "78212", "78213", "78214", "78215", "78216", "78217", "78218", "78219",
  "78220", "78221", "78222", "78223", "78224", "78225", "78226", "78227", "78228", "78229",
  "78230", "78231", "78232", "78233", "78234", "78235", "78236", "78237", "78238", "78239",
  "78240", "78241", "78242", "78243", "78244", "78245", "78246", "78247", "78248", "78249",
  "78250", "78251", "78252", "78253", "78254", "78255", "78256", "78257", "78258", "78259",
  "78260", "78261", "78263", "78264", "78265", "78266", "78268", "78269", "78270", "78278",
  "78279", "78280", "78283", "78284", "78285", "78288", "78289", "78291", "78292", "78293",
  "78294", "78295", "78296", "78297", "78298", "78299",
]);

/** Cities/places inside Bexar County (lowercased) for coverage detection when no ZIP is given. */
const BEXAR_CITIES = new Set([
  "san antonio", "alamo heights", "balcones heights", "castle hills", "china grove",
  "converse", "elmendorf", "fair oaks ranch", "grey forest", "helotes", "hill country village",
  "hollywood park", "kirby", "la vernia", "leon valley", "live oak", "lytle", "macdona",
  "olmos park", "saint hedwig", "st hedwig", "st. hedwig", "schertz", "selma", "shavano park",
  "somerset", "terrell hills", "universal city", "von ormy", "windcrest",
]);

export type Coverage = "in_coverage" | "outside_coverage" | "unknown";

/**
 * Decide whether an address is inside Bexar County based on ZIP (strongest
 * signal) or city name. Returns "unknown" when neither is provided — in that
 * case we still attempt the lookup (street-only match inside the county).
 */
export function detectBexarCoverage(city?: string, zip?: string): Coverage {
  const zip5 = zip?.trim().slice(0, 5);
  if (zip5 && /^\d{5}$/.test(zip5)) {
    return BEXAR_ZIPS.has(zip5) ? "in_coverage" : "outside_coverage";
  }
  const cityNorm = city?.trim().toLowerCase().replace(/\s+/g, " ");
  if (cityNorm) {
    if (BEXAR_CITIES.has(cityNorm)) return "in_coverage";
    // City given but not a Bexar municipality — treat as outside coverage.
    return "outside_coverage";
  }
  return "unknown";
}

/** Street-suffix words we strip so "5500 Grand Lake Dr" matches situs "5500  GRAND LAKE DR". */
const SUFFIX_WORDS = new Set([
  "ST", "STREET", "DR", "DRIVE", "RD", "ROAD", "AVE", "AVENUE", "BLVD", "BOULEVARD",
  "LN", "LANE", "CT", "COURT", "CIR", "CIRCLE", "PL", "PLACE", "WAY", "TRL", "TRAIL",
  "PKWY", "PARKWAY", "HWY", "HIGHWAY", "LOOP", "PASS", "RUN", "CV", "COVE", "XING",
  "CROSSING", "TER", "TERRACE", "SQ", "SQUARE", "PT", "POINT", "BND", "BEND", "VW", "VIEW",
]);

/** Unit designators — everything after these tokens is dropped. */
const UNIT_WORDS = new Set(["APT", "UNIT", "STE", "SUITE", "#", "BLDG", "FL", "FLOOR", "LOT"]);

export interface ParsedStreetAddress {
  houseNumber: string;
  /** Street name words without house number, unit, or trailing suffix. */
  streetCore: string;
}

/**
 * Parse a free-form street address line ("5500 Grand Lake Dr Apt 2") into a
 * house number and core street name ("GRAND LAKE") for situs matching.
 */
export function parseStreetAddress(addressLine: string): ParsedStreetAddress | null {
  const cleaned = addressLine
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/^(\d+[A-Z]?)\s+(.+)$/);
  if (!match) return null;
  const houseNumber = match[1].replace(/[A-Z]$/, ""); // "5500A" -> "5500"
  let words = match[2].split(" ");

  // Cut at the first unit designator.
  const unitIdx = words.findIndex(w => UNIT_WORDS.has(w) || w.startsWith("#"));
  if (unitIdx >= 0) words = words.slice(0, unitIdx);

  // Drop a trailing directional + suffix (e.g. "DR", "RD N").
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (SUFFIX_WORDS.has(last) || ["N", "S", "E", "W", "NE", "NW", "SE", "SW"].includes(last)) {
      words = words.slice(0, -1);
    } else {
      break;
    }
  }
  if (words.length === 0) return null;
  const streetCore = words.join(" ").trim();
  if (!streetCore || !houseNumber) return null;
  return { houseNumber, streetCore };
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface BexarFeature {
  attributes: Record<string, unknown>;
}

/**
 * Query the Bexar County GIS parcel layer for a street address.
 * Returns the best match (exact house number on the matching street).
 */
export async function lookupBexarProperty(addressLine: string): Promise<PropertyLookupResult> {
  const parsed = parseStreetAddress(addressLine);
  if (!parsed) return { verified: false, reason: "unparseable" };

  // Escape single quotes for the SQL-like where clause.
  const safeStreet = parsed.streetCore.replace(/'/g, "''");
  const where = `Situs LIKE '${parsed.houseNumber} %${safeStreet}%'`;
  const params = new URLSearchParams({
    where,
    outFields: "PropID,Situs,GBA,TOT_GBA,YrBlt,Stories,PropUse",
    returnGeometry: "false",
    resultRecordCount: "5",
    f: "json",
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(`${BEXAR_QUERY_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { verified: false, reason: "not_found" };
    const data = (await res.json()) as { features?: BexarFeature[]; error?: unknown };
    if (data.error || !Array.isArray(data.features) || data.features.length === 0) {
      return { verified: false, reason: "not_found" };
    }

    // Prefer the record with a usable building area.
    for (const feature of data.features) {
      const attrs = feature.attributes ?? {};
      const sqft = parsePositiveInt(attrs["TOT_GBA"]) ?? parsePositiveInt(attrs["GBA"]);
      if (!sqft || sqft < 100) continue;
      return {
        verified: true,
        sqft,
        yearBuilt: parsePositiveInt(attrs["YrBlt"]),
        stories: parsePositiveInt(attrs["Stories"]),
        source: "bexar_gis",
        matchedAddress: typeof attrs["Situs"] === "string" ? (attrs["Situs"] as string).replace(/\s+/g, " ").trim() : undefined,
      };
    }
    return { verified: false, reason: "not_found" };
  } catch {
    // Network failure / timeout — never block the quote.
    return { verified: false, reason: "not_found" };
  }
}

/** In-memory cache so repeated lookups of the same address don't re-hit the county service. */
const cache = new Map<string, { result: PropertyLookupResult; at: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const CACHE_MAX = 500;

export async function lookupPropertySqft(
  addressLine: string,
  city?: string,
  zip?: string
): Promise<PropertyLookupResult> {
  // County/coverage detection from the full address (ZIP is the strongest signal).
  const coverage = detectBexarCoverage(city, zip);
  if (coverage === "outside_coverage") {
    return { verified: false, reason: "outside_coverage" };
  }
  const key = [addressLine.trim(), city?.trim() ?? "", zip?.trim() ?? ""]
    .join("|")
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (!key) return { verified: false };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const result = await lookupBexarProperty(addressLine);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, at: Date.now() });
  return result;
}
