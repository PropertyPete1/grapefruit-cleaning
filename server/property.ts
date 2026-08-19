/**
 * Property square-footage verification against public records.
 *
 * Primary source: Bexar County (San Antonio, TX) public GIS parcel service —
 * free, no API key, data straight from the Bexar County Appraisal District.
 *   https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query
 *
 * Neighboring counties (Comal, Guadalupe, Medina, Kendall) are covered through
 * their appraisal districts' public ArcGIS FeatureServers. Those layers publish
 * parcel/situs records but NOT living-area square footage, so for them we
 * verify the address exists in county records ("address_verified") while the
 * square footage remains customer-entered (confirmed at the appointment).
 *
 * Travis County (Austin) is covered through the US Census Bureau geocoder —
 * ADDRESS VERIFICATION ONLY. Two rounds of live production findings ruled
 * out every TCAD-side source: the county's own GIS host serves no public
 * catalog, and the one reachable parcel layer stores bare house numbers in
 * its SITUS field with no street, city, ZIP, or living-area columns — it
 * cannot verify an address at all. The Census geocoder can, nationwide, with
 * county context attached. Same posture as the CAD counties: a match proves
 * the address, the square footage stays customer-entered.
 *
 * Hays County (San Marcos, Kyle, Buda, Dripping Springs) rides the same
 * Census verify-only tier as Travis.
 *
 * Every county hangs off COUNTY_ADAPTERS: one entry per county, each an
 * independent lookup function. Adding the next county means adding ZIPs/cities
 * for detection and one adapter entry.
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
  source?: PropertySource;
  /** The county situs address the record matched, for display/audit. */
  matchedAddress?: string;
  /** County the address resolved to (display name), when known. */
  county?: string;
  /**
   * True when the address was found in county records but the county does not
   * publish living-area sqft (Comal/Guadalupe/Medina/Kendall). `verified` is
   * false in that case — sqft stays customer-entered.
   */
  addressVerified?: boolean;
  /** Why the lookup did not verify (coverage vs. no record), for UI/audit. */
  reason?: "outside_coverage" | "not_found" | "unparseable" | "address_verified";
}

export type PropertySource =
  | "bexar_gis"
  | "comal_cad"
  | "guadalupe_cad"
  | "medina_cad"
  | "kendall_cad"
  | "census_geocoder";

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

export type CountyKey = "bexar" | "comal" | "guadalupe" | "medina" | "kendall" | "travis" | "hays";

export const COUNTY_NAMES: Record<CountyKey, string> = {
  bexar: "Bexar",
  comal: "Comal",
  guadalupe: "Guadalupe",
  medina: "Medina",
  kendall: "Kendall",
  travis: "Travis",
  hays: "Hays",
};

/**
 * ZIP codes for neighboring counties. Some ZIPs straddle county lines (e.g.
 * 78163 Bulverde spans Bexar/Comal), so detection returns a *candidate list*
 * and the lookup tries each county's provider in order until one matches.
 */
const COMAL_ZIPS = new Set([
  "78070", "78130", "78131", "78132", "78133", "78135", "78163", "78266", "78623", "78606",
]);
const COMAL_CITIES = new Set([
  "new braunfels", "canyon lake", "spring branch", "bulverde", "fischer", "sattler",
  "startzville", "garden ridge", "smithson valley",
]);
const GUADALUPE_ZIPS = new Set([
  "78108", "78123", "78124", "78154", "78155", "78156", "78638", "78655", "78666", "78121",
]);
const GUADALUPE_CITIES = new Set([
  "seguin", "schertz", "cibolo", "marion", "mcqueeney", "geronimo", "kingsbury",
  "new berlin", "santa clara", "staples", "zuehl",
]);
const MEDINA_ZIPS = new Set([
  "78009", "78016", "78039", "78056", "78059", "78066", "78850", "78861", "78886", "78003",
]);
const MEDINA_CITIES = new Set([
  "hondo", "castroville", "devine", "natalia", "lacoste", "la coste", "d'hanis", "dhanis",
  "yancey", "mico", "rio medina", "bandera falls",
]);
const KENDALL_ZIPS = new Set([
  "78004", "78006", "78013", "78015", "78027", "78074", "78606", "78624",
]);
const KENDALL_CITIES = new Set([
  "boerne", "comfort", "kendalia", "waring", "sisterdale", "bergheim", "fair oaks ranch",
]);
/**
 * Travis County (Austin metro). A few edge ZIPs straddle Williamson/Hays/
 * Bastrop lines; a straddler only means the Travis provider is TRIED, and a
 * miss falls through gracefully like any other not-found.
 */
const TRAVIS_ZIPS = new Set([
  "78617", "78652", "78653", "78660", "78669", "78701", "78702", "78703", "78704", "78705",
  "78712", "78719", "78721", "78722", "78723", "78724", "78725", "78726", "78727", "78728",
  "78729", "78730", "78731", "78732", "78733", "78734", "78735", "78736", "78737", "78738",
  "78739", "78741", "78742", "78744", "78745", "78746", "78747", "78748", "78749", "78750",
  "78751", "78752", "78753", "78754", "78756", "78757", "78758", "78759",
]);
const TRAVIS_CITIES = new Set([
  "austin", "pflugerville", "manor", "del valle", "lakeway", "bee cave", "bee caves",
  "west lake hills", "rollingwood", "sunset valley", "jonestown", "lago vista",
  "point venture", "the hills", "briarcliff", "creedmoor", "manchaca", "hornsby bend",
  "hudson bend", "garfield", "webberville",
]);

/**
 * Hays County (San Marcos corridor), the second Census verify-only county.
 * 78666 straddles the Guadalupe line — a straddler only orders the candidate
 * list, and a miss in one county falls through to the next.
 */
const HAYS_ZIPS = new Set([
  "78610", "78619", "78620", "78640", "78656", "78666", "78667", "78676",
]);
const HAYS_CITIES = new Set([
  "san marcos", "kyle", "buda", "dripping springs", "wimberley", "driftwood",
  "niederwald", "uhland", "mountain city", "hays city",
]);

const COUNTY_ZIPS: Record<CountyKey, Set<string>> = {
  bexar: BEXAR_ZIPS,
  comal: COMAL_ZIPS,
  guadalupe: GUADALUPE_ZIPS,
  medina: MEDINA_ZIPS,
  kendall: KENDALL_ZIPS,
  travis: TRAVIS_ZIPS,
  hays: HAYS_ZIPS,
};
const COUNTY_CITIES: Record<CountyKey, Set<string>> = {
  bexar: BEXAR_CITIES,
  comal: COMAL_CITIES,
  guadalupe: GUADALUPE_CITIES,
  medina: MEDINA_CITIES,
  kendall: KENDALL_CITIES,
  travis: TRAVIS_CITIES,
  hays: HAYS_CITIES,
};
const COUNTY_ORDER: CountyKey[] = ["bexar", "comal", "guadalupe", "medina", "kendall", "travis", "hays"];

/**
 * Resolve candidate counties for an address. ZIP is the strongest signal;
 * city narrows/orders candidates further. Returns [] when the address is
 * clearly outside all covered counties, or all counties when nothing is known.
 */
export function detectCounties(city?: string, zip?: string): CountyKey[] {
  const zip5 = zip?.trim().slice(0, 5);
  const cityNorm = city?.trim().toLowerCase().replace(/\s+/g, " ");

  const zipMatches = zip5 && /^\d{5}$/.test(zip5)
    ? COUNTY_ORDER.filter(c => COUNTY_ZIPS[c].has(zip5))
    : null;
  const cityMatches = cityNorm
    ? COUNTY_ORDER.filter(c => COUNTY_CITIES[c].has(cityNorm))
    : null;

  if (zipMatches && zipMatches.length > 0) {
    if (cityMatches && cityMatches.length > 0) {
      // Order ZIP candidates so counties also matching the city come first.
      const both = zipMatches.filter(c => cityMatches.includes(c));
      if (both.length > 0) return [...both, ...zipMatches.filter(c => !both.includes(c))];
    }
    return zipMatches;
  }
  if (zipMatches && zipMatches.length === 0) {
    // Valid ZIP given but not in any covered county.
    return [];
  }
  if (cityMatches) {
    return cityMatches; // may be [] → outside coverage
  }
  // Nothing known — try every provider (street match still requires exact house number).
  return [...COUNTY_ORDER];
}

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
  /** Leading directional (N/S/E/W...) when present, e.g. "S" in "S Castell Ave". */
  prefix?: string;
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

  // Strip a leading directional ("S CASTELL AVE" → core "CASTELL"); county CAD
  // layers store it in a separate situs_street_prefx field.
  let prefix: string | undefined;
  if (words.length > 1 && ["N", "S", "E", "W", "NE", "NW", "SE", "SW"].includes(words[0])) {
    prefix = words[0];
    words = words.slice(1);
  }

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
  return { houseNumber, streetCore, prefix };
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

/**
 * BIS Consulting CAD FeatureServers for neighboring counties. Same PACS schema:
 * situs_num (string), situs_street (no suffix), situs_street_sufix, situs_city,
 * situs_zip. These layers do NOT publish living-area sqft — a match verifies
 * the address only.
 */
const CAD_SERVICES: Record<Exclude<CountyKey, "bexar" | "travis" | "hays">, { url: string; source: PropertySource }> = {
  comal: {
    url: "https://services7.arcgis.com/Yz6eib2o8WvEgWq8/arcgis/rest/services/ComalCADWebService/FeatureServer/0/query",
    source: "comal_cad",
  },
  guadalupe: {
    url: "https://services9.arcgis.com/1l4hbpt78hjlsIcl/arcgis/rest/services/GuadalupeCADWebService/FeatureServer/0/query",
    source: "guadalupe_cad",
  },
  medina: {
    url: "https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/MedinaCADWebService/FeatureServer/0/query",
    source: "medina_cad",
  },
  kendall: {
    url: "https://services9.arcgis.com/AugxDVA2CqlsdRYC/arcgis/rest/services/KendallCADWebService/FeatureServer/0/query",
    source: "kendall_cad",
  },
};

/**
 * Query a neighboring county's CAD parcel layer to verify an address exists.
 * Returns `addressVerified: true` (with matched situs) on success; sqft is not
 * available from these layers.
 */
export async function lookupCadAddress(
  county: Exclude<CountyKey, "bexar" | "travis" | "hays">,
  addressLine: string,
  zip?: string
): Promise<PropertyLookupResult> {
  const parsed = parseStreetAddress(addressLine);
  if (!parsed) return { verified: false, reason: "unparseable" };

  const svc = CAD_SERVICES[county];
  // Build street-name variants so "Avenue M" matches "AVE M" and vice versa.
  const variants = streetVariants(parsed.streetCore);
  const likeClauses = variants
    .map(v => `UPPER(situs_street) LIKE '%${v.replace(/'/g, "''")}%'`)
    .join(" OR ");
  // Some CAD layers store situs_num with trailing spaces ("605 ") — match both.
  const clauses = [
    `(situs_num = '${parsed.houseNumber}' OR situs_num LIKE '${parsed.houseNumber} %' OR situs_num = '${parsed.houseNumber} ')`,
    `(${likeClauses})`,
  ];
  const params = new URLSearchParams({
    where: clauses.join(" AND "),
    outFields: "prop_id,situs_num,situs_street_prefx,situs_street,situs_street_sufix,situs_city,situs_zip",
    returnGeometry: "false",
    resultRecordCount: "10",
    f: "json",
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(`${svc.url}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { verified: false, reason: "not_found" };
    const data = (await res.json()) as { features?: BexarFeature[]; error?: unknown };
    if (data.error || !Array.isArray(data.features) || data.features.length === 0) {
      return { verified: false, reason: "not_found" };
    }
    const zip5 = zip?.trim().slice(0, 5);
    const best = pickBestCadMatch(data.features, parsed, variants, zip5);
    if (!best) return { verified: false, reason: "not_found" };
    const attrs = best;
    const situs = [
      attrs["situs_num"],
      attrs["situs_street_prefx"],
      attrs["situs_street"],
      attrs["situs_street_sufix"],
      attrs["situs_city"],
      attrs["situs_zip"],
    ]
      .filter(v => typeof v === "string" && (v as string).trim().length > 0)
      .map(v => (v as string).trim())
      .join(" ");
    return {
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: svc.source,
      county: COUNTY_NAMES[county],
      matchedAddress: situs || undefined,
    };
  } catch {
    return { verified: false, reason: "not_found" };
  }
}

/** Expand a street core into equivalent spellings ("AVENUE M" ↔ "AVE M"). */
export function streetVariants(streetCore: string): string[] {
  const out = new Set<string>([streetCore]);
  const swaps: Array<[RegExp, string]> = [
    [/\bAVENUE\b/g, "AVE"],
    [/\bAVE\b/g, "AVENUE"],
    [/\bSTREET\b/g, "ST"],
    [/\bST\b/g, "STREET"],
    [/\bROAD\b/g, "RD"],
    [/\bRD\b/g, "ROAD"],
    [/\bDRIVE\b/g, "DR"],
    [/\bDR\b/g, "DRIVE"],
    [/\bLANE\b/g, "LN"],
    [/\bLN\b/g, "LANE"],
    [/\bCOURT\b/g, "CT"],
    [/\bCT\b/g, "COURT"],
    [/\bHIGHWAY\b/g, "HWY"],
    [/\bHWY\b/g, "HIGHWAY"],
  ];
  for (const [re, rep] of swaps) {
    if (re.test(streetCore)) out.add(streetCore.replace(re, rep));
  }
  return Array.from(out);
}

/**
 * Choose the best CAD candidate: the record's street must contain one of the
 * expected variants as a whole word sequence (so "COURT ST" matches core
 * "COURT" but "IGUANA COURT" does not when the query was "W Court St").
 * Prefers records whose directional prefix and ZIP also agree.
 */
export function pickBestCadMatch(
  features: BexarFeature[],
  parsed: ParsedStreetAddress,
  variants: string[],
  zip5?: string
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const f of features) {
    const attrs = f.attributes ?? {};
    const street = String(attrs["situs_street"] ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    if (!street) continue;
    // Whole-word match: street starts with the variant or contains it bounded by spaces.
    const matched = variants.find(v => street === v || street.startsWith(`${v} `) || street.endsWith(` ${v}`) || street.includes(` ${v} `));
    if (!matched) continue;
    let score = 1;
    if (street === matched) score += 2; // exact street name
    const prefx = String(attrs["situs_street_prefx"] ?? "").trim().toUpperCase();
    if (parsed.prefix && prefx === parsed.prefix) score += 2;
    else if (parsed.prefix && prefx && prefx !== parsed.prefix) score -= 2;
    const recZip = String(attrs["situs_zip"] ?? "").trim().slice(0, 5);
    if (zip5 && recZip === zip5) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = attrs;
    }
  }
  return bestScore >= 1 ? best : null;
}

const CENSUS_GEOCODER_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

/**
 * Score a street line ("1100 CONGRESS AVE" / a situs / the street half of a
 * geocoder match) against a parsed input address. Null when implausible:
 * the line must START with the exact house number (1100 never matches 11001)
 * and carry the street core as whole words (CONGRESS matches "1100 CONGRESS
 * AVE", not "1100 CONGRESSIONAL LOOP"). A directional prefix, when the
 * caller gave one, prefers agreeing lines and penalizes contradicting ones.
 */
export function matchStreetLine(
  line: string,
  parsed: ParsedStreetAddress,
  variants: string[]
): number | null {
  const normalized = line.toUpperCase().replace(/\s+/g, " ").trim();
  if (!normalized.startsWith(`${parsed.houseNumber} `)) return null;
  const rest = normalized.slice(parsed.houseNumber.length + 1);
  const wordMatch = variants.find(
    v => rest === v || rest.startsWith(`${v} `) || rest.endsWith(` ${v}`) || rest.includes(` ${v} `)
  );
  if (!wordMatch) return null;
  let score = 1;
  if (rest.startsWith(wordMatch)) score += 1;
  if (parsed.prefix) {
    if (rest.startsWith(`${parsed.prefix} `)) score += 2;
    else if (/^(N|S|E|W|NE|NW|SE|SW) /.test(rest)) score -= 2;
  }
  return score;
}

/** The slice of a Census geographies/onelineaddress response this reads. */
interface CensusAddressMatch {
  matchedAddress?: string;
  geographies?: { Counties?: { NAME?: string; BASENAME?: string }[] };
}

/**
 * Verify an address exists via the US Census Bureau geocoder, constrained to
 * one county.
 *
 * The geocoder (geocoding.geo.census.gov, benchmark Public_AR_Current, no
 * key) resolves an address against TIGER address ranges and returns the
 * county it landed in — which is the whole trick: a plausible match in the
 * WRONG county is somebody else's street with the same name, and is refused.
 * Plausibility itself is the same rule every adapter uses (matchStreetLine):
 * exact house number, street core as whole words.
 *
 * ADDRESS-VERIFY-ONLY by nature — the Census knows where addresses are, not
 * how big the homes on them are — so the outcome tier is exactly the CAD
 * counties': address_verified, entered sqft stands. Built as a per-county
 * helper rather than Travis-inline because it backs any verify-only county
 * with one adapter-table entry — Travis first, Hays since.
 */
export async function censusAddressVerify(
  county: CountyKey,
  addressLine: string,
  zip?: string,
  city?: string
): Promise<PropertyLookupResult> {
  const parsed = parseStreetAddress(addressLine);
  if (!parsed) return { verified: false, reason: "unparseable" };

  const oneline = [addressLine.trim(), city?.trim() || "", "TX", zip?.trim() || ""]
    .filter(Boolean)
    .join(", ");
  const params = new URLSearchParams({
    address: oneline,
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    layers: "Counties",
    format: "json",
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(`${CENSUS_GEOCODER_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { verified: false, reason: "not_found" };
    const data = (await res.json()) as { result?: { addressMatches?: CensusAddressMatch[] } };
    const matches = data.result?.addressMatches ?? [];
    if (matches.length === 0) return { verified: false, reason: "not_found" };

    const countyName = COUNTY_NAMES[county].toUpperCase();
    const variants = streetVariants(parsed.streetCore);
    let best: string | null = null;
    let bestScore = -1;
    for (const match of matches) {
      if (typeof match.matchedAddress !== "string") continue;
      // County context is the geocoder's own: BASENAME "Travis" / NAME
      // "Travis County". A match outside the target county is a same-named
      // street somewhere else — refused, not verified.
      const countyRec = match.geographies?.Counties?.[0];
      const recName = (countyRec?.BASENAME ?? countyRec?.NAME ?? "").toUpperCase();
      if (!recName.includes(countyName)) continue;
      // Plausibility runs on the street half of "1100 CONGRESS AVE, AUSTIN,
      // TX, 78701" — the same exact-number/whole-word rule as every adapter.
      const streetHalf = match.matchedAddress.split(",")[0] ?? "";
      const score = matchStreetLine(streetHalf, parsed, variants);
      if (score === null) continue;
      if (score > bestScore) {
        bestScore = score;
        best = match.matchedAddress.toUpperCase().replace(/\s+/g, " ").trim();
      }
    }
    if (best === null) return { verified: false, reason: "not_found" };
    return {
      verified: false,
      addressVerified: true,
      reason: "address_verified",
      source: "census_geocoder",
      county: COUNTY_NAMES[county],
      matchedAddress: best,
    };
  } catch {
    // Timeout or network failure — never block the quote.
    return { verified: false, reason: "not_found" };
  }
}

/**
 * One lookup function per covered county. lookupPropertySqft walks the
 * candidate list from detectCounties through this table — adding a county
 * touches the detection sets and this record, nothing else.
 */
export const COUNTY_ADAPTERS: Record<
  CountyKey,
  (addressLine: string, zip?: string, city?: string) => Promise<PropertyLookupResult>
> = {
  bexar: addressLine => lookupBexarProperty(addressLine),
  comal: (addressLine, zip) => lookupCadAddress("comal", addressLine, zip),
  guadalupe: (addressLine, zip) => lookupCadAddress("guadalupe", addressLine, zip),
  medina: (addressLine, zip) => lookupCadAddress("medina", addressLine, zip),
  kendall: (addressLine, zip) => lookupCadAddress("kendall", addressLine, zip),
  travis: (addressLine, zip, city) => censusAddressVerify("travis", addressLine, zip, city),
  hays: (addressLine, zip, city) => censusAddressVerify("hays", addressLine, zip, city),
};

/** In-memory cache so repeated lookups of the same address don't re-hit the county service. */
const cache = new Map<string, { result: PropertyLookupResult; at: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const CACHE_MAX = 500;

export async function lookupPropertySqft(
  addressLine: string,
  city?: string,
  zip?: string
): Promise<PropertyLookupResult> {
  // Resolve candidate counties (ZIP strongest signal; ambiguous ZIPs return several).
  const candidates = detectCounties(city, zip);
  if (candidates.length === 0) {
    return { verified: false, reason: "outside_coverage" };
  }
  const key = [addressLine.trim(), city?.trim() ?? "", zip?.trim() ?? ""]
    .join("|")
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (!key) return { verified: false };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  // Try each candidate county's adapter until one yields a match. Bexar and
  // Travis can verify sqft; the CAD-only counties verify the address.
  let result: PropertyLookupResult = { verified: false, reason: "not_found" };
  for (const county of candidates) {
    const attempt = await COUNTY_ADAPTERS[county](addressLine, zip, city);
    if (attempt.reason === "unparseable") {
      result = attempt;
      break;
    }
    if (attempt.verified || attempt.addressVerified) {
      result = { county: COUNTY_NAMES[county], ...attempt };
      break;
    }
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, at: Date.now() });
  return result;
}
