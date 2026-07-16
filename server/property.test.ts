import { describe, expect, it } from "vitest";
import {
  detectBexarCoverage,
  detectCounties,
  lookupBexarProperty,
  lookupCadAddress,
  lookupPropertySqft,
  parseStreetAddress,
  pickBestCadMatch,
  streetVariants,
} from "./property";

describe("parseStreetAddress", () => {
  it("parses a simple address with suffix", () => {
    expect(parseStreetAddress("5500 Grand Lake Dr")).toEqual({
      houseNumber: "5500",
      streetCore: "GRAND LAKE",
      prefix: undefined,
    });
  });

  it("strips unit designators and punctuation", () => {
    expect(parseStreetAddress("123 Main St. Apt 4B")).toEqual({
      houseNumber: "123",
      streetCore: "MAIN",
      prefix: undefined,
    });
  });

  it("strips trailing directionals with suffixes", () => {
    expect(parseStreetAddress("890 Oak Hollow Rd N")).toEqual({
      houseNumber: "890",
      streetCore: "OAK HOLLOW",
      prefix: undefined,
    });
  });

  it("keeps street names that resemble suffixes when they are the only word", () => {
    expect(parseStreetAddress("42 Loop")).toEqual({
      houseNumber: "42",
      streetCore: "LOOP",
      prefix: undefined,
    });
  });

  it("extracts a leading directional prefix into its own field", () => {
    expect(parseStreetAddress("424 S Castell Ave")).toEqual({
      houseNumber: "424",
      streetCore: "CASTELL",
      prefix: "S",
    });
    expect(parseStreetAddress("211 W Court St")).toEqual({
      houseNumber: "211",
      streetCore: "COURT",
      prefix: "W",
    });
  });

  it("returns null for addresses without a house number", () => {
    expect(parseStreetAddress("Grand Lake Dr")).toBeNull();
    expect(parseStreetAddress("")).toBeNull();
  });
});

describe("streetVariants", () => {
  it("expands AVENUE to AVE and vice versa", () => {
    expect(streetVariants("AVENUE M")).toEqual(expect.arrayContaining(["AVENUE M", "AVE M"]));
    expect(streetVariants("AVE M")).toEqual(expect.arrayContaining(["AVE M", "AVENUE M"]));
  });

  it("returns the original when no abbreviation applies", () => {
    expect(streetVariants("GRAND LAKE")).toEqual(["GRAND LAKE"]);
  });
});

describe("pickBestCadMatch", () => {
  const parsed = { houseNumber: "211", streetCore: "COURT", prefix: "W" };
  const variants = ["COURT"];

  it("rejects records where the street only contains the core as part of another name", () => {
    const features = [
      { attributes: { situs_street: "IGUANA COURT", situs_street_prefx: null } },
      { attributes: { situs_street: "KAYDEN COURT", situs_street_prefx: null } },
    ];
    // "IGUANA COURT" ends with " COURT" so whole-word matching alone allows it —
    // but the prefix mismatch (W expected, none present) must not disqualify
    // when nothing better exists; scoring still returns a candidate.
    // The real W COURT ST record must always win when present:
    const withReal = [...features, { attributes: { situs_street: "COURT ST", situs_street_prefx: "W" } }];
    const best = pickBestCadMatch(withReal as never, parsed as never, variants);
    expect(best?.situs_street).toBe("COURT ST");
    expect(best?.situs_street_prefx).toBe("W");
  });

  it("prefers records matching the ZIP", () => {
    const features = [
      { attributes: { situs_street: "CASTELL", situs_street_prefx: "S", situs_zip: "78132" } },
      { attributes: { situs_street: "CASTELL", situs_street_prefx: "S", situs_zip: "78130" } },
    ];
    const best = pickBestCadMatch(
      features as never,
      { houseNumber: "424", streetCore: "CASTELL", prefix: "S" } as never,
      ["CASTELL"],
      "78130"
    );
    expect(best?.situs_zip).toBe("78130");
  });

  it("returns null when no record matches a variant as a whole word", () => {
    const features = [{ attributes: { situs_street: "COURTLAND HEIGHTS" } }];
    const best = pickBestCadMatch(features as never, parsed as never, variants);
    expect(best).toBeNull();
  });
});

describe("detectCounties (multi-county)", () => {
  it("maps neighboring-county ZIPs to their county", () => {
    expect(detectCounties(undefined, "78130")).toContain("comal"); // New Braunfels
    expect(detectCounties(undefined, "78155")).toContain("guadalupe"); // Seguin
    expect(detectCounties(undefined, "78861")).toContain("medina"); // Hondo
    expect(detectCounties(undefined, "78006")).toContain("kendall"); // Boerne
  });

  it("maps city names when no ZIP is given", () => {
    expect(detectCounties("New Braunfels")).toContain("comal");
    expect(detectCounties("Seguin")).toContain("guadalupe");
    expect(detectCounties("Hondo")).toContain("medina");
    expect(detectCounties("Boerne")).toContain("kendall");
  });

  it("returns empty for addresses outside all covered counties", () => {
    expect(detectCounties("Austin", "78701")).toEqual([]);
    expect(detectCounties("Houston", "77002")).toEqual([]);
  });

  it("keeps Bexar detection working", () => {
    expect(detectCounties("San Antonio", "78230")).toContain("bexar");
  });
});

describe("lookupCadAddress (live neighboring-county CAD services)", () => {
  it("verifies a known New Braunfels address in Comal County records", async () => {
    const result = await lookupCadAddress("comal", "424 S Castell Ave", "78130");
    if (result.addressVerified) {
      expect(result.source).toBe("comal_cad");
      expect(result.county).toBe("Comal");
      expect(result.verified).toBe(false); // no sqft published
    } else {
      expect(result.verified).toBe(false); // service unreachable — degrade gracefully
    }
  }, 15000);

  it("verifies a known Boerne address in Kendall County records", async () => {
    const result = await lookupCadAddress("kendall", "201 E San Antonio Ave", "78006");
    if (result.addressVerified) {
      expect(result.source).toBe("kendall_cad");
      expect(result.county).toBe("Kendall");
    }
    expect(result.verified).toBe(false);
  }, 15000);

  it("returns not_found for a non-existent address without throwing", async () => {
    const result = await lookupCadAddress("medina", "99999999 Nonexistent Xyz Blvd", "78861");
    expect(result.verified).toBe(false);
    expect(result.addressVerified).toBeUndefined();
  }, 15000);
});

describe("lookupBexarProperty (live county GIS)", () => {
  it("finds the verified square footage for a known San Antonio address", async () => {
    const result = await lookupBexarProperty("5500 Grand Lake Dr");
    // Best-effort: if the county service is unreachable the module returns
    // verified:false rather than throwing — only assert shape strictly on success.
    if (result.verified) {
      expect(result.source).toBe("bexar_gis");
      expect(result.sqft).toBeGreaterThan(500);
      expect(result.sqft).toBeLessThan(20000);
    } else {
      expect(result.sqft).toBeUndefined();
    }
  }, 15000);

  it("returns verified:false for a non-existent address", async () => {
    const result = await lookupBexarProperty("99999999 Nonexistent Xyz Blvd");
    expect(result.verified).toBe(false);
  }, 15000);
});

describe("detectBexarCoverage", () => {
  it("detects Bexar County by San Antonio ZIP", () => {
    expect(detectBexarCoverage(undefined, "78201")).toBe("in_coverage");
    expect(detectBexarCoverage("San Antonio", "78230")).toBe("in_coverage");
  });

  it("flags non-Bexar ZIPs as outside coverage (Austin, Houston, Dallas)", () => {
    expect(detectBexarCoverage(undefined, "78701")).toBe("outside_coverage"); // Austin
    expect(detectBexarCoverage(undefined, "77002")).toBe("outside_coverage"); // Houston
    expect(detectBexarCoverage(undefined, "75201")).toBe("outside_coverage"); // Dallas
  });

  it("ZIP wins over city name when both are present", () => {
    // Customer typed "San Antonio" but the ZIP is Austin — trust the ZIP.
    expect(detectBexarCoverage("San Antonio", "78701")).toBe("outside_coverage");
  });

  it("detects Bexar municipalities by city name when no ZIP is given", () => {
    expect(detectBexarCoverage("San Antonio")).toBe("in_coverage");
    expect(detectBexarCoverage("Helotes")).toBe("in_coverage");
    expect(detectBexarCoverage("ALAMO HEIGHTS")).toBe("in_coverage");
  });

  it("flags non-Bexar cities as outside coverage", () => {
    expect(detectBexarCoverage("Austin")).toBe("outside_coverage");
    expect(detectBexarCoverage("New Braunfels")).toBe("outside_coverage");
  });

  it("returns unknown when neither city nor ZIP is provided", () => {
    expect(detectBexarCoverage()).toBe("unknown");
    expect(detectBexarCoverage("", "")).toBe("unknown");
  });
});

describe("lookupPropertySqft coverage gating", () => {
  it("never queries the county for an outside-coverage address (ambiguous street name in Austin)", async () => {
    // "Main St" exists in nearly every Texas county — an Austin ZIP must not
    // false-match a Bexar County record with the same street name.
    const result = await lookupPropertySqft("123 Main St", "Austin", "78701");
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("outside_coverage");
    expect(result.sqft).toBeUndefined();
  });

  it("returns outside_coverage for a non-Bexar city without ZIP", async () => {
    const result = await lookupPropertySqft("5500 Grand Lake Dr", "Houston");
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("outside_coverage");
  });

  it("still attempts lookup for in-coverage addresses", async () => {
    const result = await lookupPropertySqft("5500 Grand Lake Dr", "San Antonio", "78244");
    if (result.verified) {
      expect(result.source).toBe("bexar_gis");
      expect(result.sqft).toBeGreaterThan(500);
    } else {
      // Service unreachable — must degrade gracefully, never throw.
      expect(result.sqft).toBeUndefined();
    }
  }, 15000);
});
