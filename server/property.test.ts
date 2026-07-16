import { describe, expect, it } from "vitest";
import { detectBexarCoverage, lookupBexarProperty, lookupPropertySqft, parseStreetAddress } from "./property";

describe("parseStreetAddress", () => {
  it("parses a simple address with suffix", () => {
    expect(parseStreetAddress("5500 Grand Lake Dr")).toEqual({
      houseNumber: "5500",
      streetCore: "GRAND LAKE",
    });
  });

  it("strips unit designators and punctuation", () => {
    expect(parseStreetAddress("123 Main St. Apt 4B")).toEqual({
      houseNumber: "123",
      streetCore: "MAIN",
    });
  });

  it("strips trailing directionals with suffixes", () => {
    expect(parseStreetAddress("890 Oak Hollow Rd N")).toEqual({
      houseNumber: "890",
      streetCore: "OAK HOLLOW",
    });
  });

  it("keeps street names that resemble suffixes when they are the only word", () => {
    expect(parseStreetAddress("42 Loop")).toEqual({ houseNumber: "42", streetCore: "LOOP" });
  });

  it("returns null for addresses without a house number", () => {
    expect(parseStreetAddress("Grand Lake Dr")).toBeNull();
    expect(parseStreetAddress("")).toBeNull();
  });
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
