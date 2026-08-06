/**
 * Fine-grained tier ladders: server-side validation of admin tier edits, the
 * shipped default ladder, quote behavior at the finer boundaries, and the
 * county-verified sqft re-pricing that those finer tiers feed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockCreateBooking = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  createBooking: (...args: unknown[]) => mockCreateBooking(...args),
  getBookedSlots: vi.fn().mockResolvedValue([]),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  updateBooking: vi.fn(),
  listSettings: vi.fn().mockResolvedValue([]),
}));

vi.mock("./property", () => ({
  lookupPropertySqft: (...args: unknown[]) => mockLookupProperty(...args),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...args: unknown[]) => mockSessionCreate(...args) } } }),
}));

import {
  calculateQuote,
  DEFAULT_PRICING,
  getTier,
  MAX_TIERS_PER_SERVICE,
  parsePricingConfig,
  PRICING_SETTING_KEY,
  serializePricingConfig,
  startingPriceFor,
  tierRangeLabel,
  validatePricingConfig,
  type PricingTier,
} from "@shared/pricing";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

/** A mutable deep copy of the defaults in stored (JSON) form. */
const storedDefaults = () => JSON.parse(serializePricingConfig(DEFAULT_PRICING));

const adminCaller = () => adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetting.mockResolvedValue(null);
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockCreateBooking.mockResolvedValue(99);
});

// ---------------------------------------------------------------------------
// Tier ladder validation (server-side, never trusting the client)
// ---------------------------------------------------------------------------

describe("validatePricingConfig — tier ladder rules", () => {
  it("accepts the shipped defaults", () => {
    const result = validatePricingConfig(serializePricingConfig(DEFAULT_PRICING));
    expect(result.ok).toBe(true);
  });

  it("accepts a hand-built ladder with a single unbounded tier", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential = [
      { maxSqft: 800, price: 70 },
      { maxSqft: 1600, price: 120 },
      { maxSqft: null, price: 200, startingAt: true },
    ];
    expect(validatePricingConfig(cfg).ok).toBe(true);
  });

  it("rejects boundaries that are not strictly increasing", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[3].maxSqft = 900; // equal to tier 2's boundary
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/must be greater than/i);
  });

  it("rejects duplicate (overlapping) boundaries", () => {
    const cfg = storedDefaults();
    cfg.tiers.deep[5].maxSqft = cfg.tiers.deep[4].maxSqft;
    expect(validatePricingConfig(cfg).ok).toBe(false);
  });

  it("rejects non-integer and non-positive boundaries", () => {
    for (const bad of [1250.5, 0, -400]) {
      const cfg = storedDefaults();
      cfg.tiers.residential[2].maxSqft = bad;
      const result = validatePricingConfig(cfg);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/positive whole number|greater than/i);
    }
  });

  it("rejects a table with no unbounded tier", () => {
    const cfg = storedDefaults();
    cfg.tiers.deep = [{ maxSqft: 1000, price: 100 }];
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/unbounded/i);
  });

  it("rejects more than one unbounded tier", () => {
    const cfg = storedDefaults();
    cfg.tiers.moveinout = [
      { maxSqft: null, price: 100 },
      { maxSqft: null, price: 200 },
    ];
    expect(validatePricingConfig(cfg).ok).toBe(false);
  });

  it("rejects an unbounded tier that is not last", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential = [
      { maxSqft: null, price: 200 },
      { maxSqft: 1000, price: 100 },
    ];
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/last/i);
  });

  it("rejects an empty tier table", () => {
    const cfg = storedDefaults();
    cfg.tiers.deep = [];
    expect(validatePricingConfig(cfg).ok).toBe(false);
  });

  it(`rejects more than ${MAX_TIERS_PER_SERVICE} tiers`, () => {
    const cfg = storedDefaults();
    cfg.tiers.residential = Array.from({ length: MAX_TIERS_PER_SERVICE + 1 }, (_, i) => ({
      maxSqft: i === MAX_TIERS_PER_SERVICE ? null : (i + 1) * 100,
      price: 50 + i,
    }));
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/at most 25 tiers/i);
  });

  it(`accepts exactly ${MAX_TIERS_PER_SERVICE} tiers`, () => {
    const cfg = storedDefaults();
    cfg.tiers.residential = Array.from({ length: MAX_TIERS_PER_SERVICE }, (_, i) => ({
      maxSqft: i === MAX_TIERS_PER_SERVICE - 1 ? null : (i + 1) * 100,
      price: 50 + i,
    }));
    expect(validatePricingConfig(cfg).ok).toBe(true);
  });

  it("rejects negative prices", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[0].price = -1;
    expect(validatePricingConfig(cfg).ok).toBe(false);
  });

  it("allows a zero price", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[0].price = 0;
    expect(validatePricingConfig(cfg).ok).toBe(true);
  });

  it("rejects a custom-quote tier anywhere but last", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[0].customQuote = true;
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/only the last tier/i);
  });

  it("rejects malformed JSON outright", () => {
    const result = validatePricingConfig("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/not valid JSON/i);
  });

  it("names the offending service and tier in the error", () => {
    const cfg = storedDefaults();
    cfg.tiers.moveinout[4].maxSqft = 10;
    const result = validatePricingConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("tiers.moveinout");
  });
});

// ---------------------------------------------------------------------------
// Admin save path
// ---------------------------------------------------------------------------

describe("admin.savePricingConfig", () => {
  it("stores a valid ladder", async () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[0].price = 84.99;
    await adminCaller().savePricingConfig({ config: JSON.stringify(cfg) });

    expect(mockSetSetting).toHaveBeenCalledTimes(1);
    const [key, value] = mockSetSetting.mock.calls[0]!;
    expect(key).toBe(PRICING_SETTING_KEY);
    expect(parsePricingConfig(value as string).tiers.residential[0].price).toBe(84.99);
  });

  it("rejects an invalid ladder without writing anything", async () => {
    const cfg = storedDefaults();
    cfg.tiers.residential[3].maxSqft = 100;
    await expect(adminCaller().savePricingConfig({ config: JSON.stringify(cfg) })).rejects.toThrow(
      /Invalid pricing configuration/i
    );
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("normalizes what it stores, so Infinity round-trips as null", async () => {
    await adminCaller().savePricingConfig({ config: serializePricingConfig(DEFAULT_PRICING) });
    const [, value] = mockSetSetting.mock.calls[0]!;
    expect(String(value)).not.toContain("Infinity");
    const top = parsePricingConfig(value as string).tiers.residential.at(-1)!;
    expect(top.maxSqft).toBe(Infinity);
  });

  it("blocks an invalid ladder smuggled through the generic settings endpoint", async () => {
    const cfg = storedDefaults();
    cfg.tiers.deep = [{ maxSqft: 500, price: 10 }]; // no unbounded tier
    await expect(
      adminCaller().saveSetting({ key: PRICING_SETTING_KEY, value: JSON.stringify(cfg) })
    ).rejects.toThrow(/Invalid pricing configuration/i);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("leaves unrelated settings alone", async () => {
    await adminCaller().saveSetting({ key: "business_phone", value: "210-555-0100" });
    expect(mockSetSetting).toHaveBeenCalledWith("business_phone", "210-555-0100");
  });
});

// ---------------------------------------------------------------------------
// The shipped default ladder
// ---------------------------------------------------------------------------

describe("default tier ladder", () => {
  const residential = DEFAULT_PRICING.tiers.residential;

  it("prices the smallest homes at $79.99 and steps ~200 sq ft", () => {
    expect(residential[0]).toMatchObject({ maxSqft: 700, price: 79.99 });
    const bounded = residential.filter(t => Number.isFinite(t.maxSqft)).map(t => t.maxSqft);
    expect(bounded.slice(0, 10)).toEqual([700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2300, 2500]);
  });

  it("ends with a starting-at tier and a custom-quote catch-all", () => {
    const startingTier = residential.at(-2)!;
    expect(startingTier).toMatchObject({ maxSqft: 3500, price: 249.99, startingAt: true });
    expect(residential.at(-1)).toMatchObject({ maxSqft: Infinity, customQuote: true });
  });

  it("gives every tiered service the same 14-step ladder", () => {
    for (const svc of ["residential", "deep", "moveinout"] as const) {
      const table = DEFAULT_PRICING.tiers[svc];
      expect(table).toHaveLength(14);
      expect(table.at(-1)!.maxSqft).toBe(Infinity);
    }
  });

  it("keeps deep at ~1.8x and move in/out at ~1.6x residential", () => {
    const res = DEFAULT_PRICING.tiers.residential;
    for (let i = 0; i < res.length - 1; i++) {
      expect(DEFAULT_PRICING.tiers.deep[i]!.price / res[i]!.price).toBeCloseTo(1.8, 1);
      expect(DEFAULT_PRICING.tiers.moveinout[i]!.price / res[i]!.price).toBeCloseTo(1.6, 1);
    }
  });

  it("prices every ladder strictly upward with .99 endings", () => {
    for (const svc of ["residential", "deep", "moveinout"] as const) {
      const priced = DEFAULT_PRICING.tiers[svc].filter(t => !t.customQuote);
      priced.forEach((tier, i) => {
        expect(Math.round((tier.price % 1) * 100)).toBe(99);
        if (i > 0) expect(tier.price).toBeGreaterThan(priced[i - 1]!.price);
      });
    }
  });

  it("passes its own validation rules", () => {
    expect(validatePricingConfig(serializePricingConfig(DEFAULT_PRICING)).ok).toBe(true);
  });

  it("is what 'Reset to defaults' would save", () => {
    // The admin Reset button seeds the draft from DEFAULT_PRICING and saves it.
    const result = validatePricingConfig(serializePricingConfig(DEFAULT_PRICING));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tiers.residential.map(t => t.price)).toEqual([
        79.99, 89.99, 99.99, 112.99, 124.99, 136.99, 149.99, 162.99, 176.99, 189.99, 209.99, 229.99, 249.99, 0,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Quote engine against the finer tiers (unchanged code, verified not assumed)
// ---------------------------------------------------------------------------

describe("quote engine at fine tier boundaries", () => {
  it("treats the upper bound as exclusive at 900 sq ft", () => {
    expect(getTier("residential", 899)?.price).toBe(89.99);
    expect(getTier("residential", 900)?.price).toBe(99.99);
    expect(getTier("residential", 901)?.price).toBe(99.99);
  });

  it("prices whole quotes consistently across a boundary", () => {
    const at = (sqft: number) =>
      calculateQuote({ type: "residential", bedrooms: 2, bathrooms: 1, sqft, extras: [], frequency: "onetime" });
    expect(at(899).total).toBe(89.99);
    expect(at(900).total).toBe(99.99);
    expect(at(901).total).toBe(99.99);
  });

  it("walks the whole ladder without gaps", () => {
    const seen = new Set<number>();
    for (let sqft = 200; sqft <= 5000; sqft += 25) {
      const tier = getTier("residential", sqft);
      expect(tier).toBeTruthy();
      seen.add(tier!.maxSqft);
    }
    // Every tier in the table is reachable by some home size.
    expect(seen.size).toBe(DEFAULT_PRICING.tiers.residential.length);
  });

  it("needs no code change to read an admin-authored 20-tier ladder", () => {
    const cfg = storedDefaults();
    cfg.tiers.residential = Array.from({ length: 20 }, (_, i) => ({
      maxSqft: i === 19 ? null : 500 + i * 150,
      price: 60 + i * 10,
    }));
    const parsed = parsePricingConfig(JSON.stringify(cfg));
    const q = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1250, extras: [], frequency: "onetime" },
      parsed
    );
    // 1,250 sq ft lands in the tier bounded at 1,400 (index 6) → 60 + 60 = 120
    expect(q.total).toBe(120);
  });

  it("advertises the cheapest tier as each service's starting price", () => {
    expect(startingPriceFor("residential")).toBe(79.99);
    expect(startingPriceFor("deep")).toBe(143.99);
    expect(startingPriceFor("moveinout")).toBe(127.99);
    // Airbnb follows the residential table rather than its base price.
    expect(startingPriceFor("airbnb")).toBe(79.99);
    // Non-tiered services keep their custom-quote baseline.
    expect(startingPriceFor("office")).toBe(DEFAULT_PRICING.basePrices.office);
  });
});

describe("tierRangeLabel", () => {
  const labels = { under: "Under", over: "Over", sqft: "sq ft", anySize: "Any size" };
  const res = DEFAULT_PRICING.tiers.residential;

  it("labels the first tier from its own boundary, not a hard-coded one", () => {
    expect(tierRangeLabel(res[0]!, undefined, labels)).toBe("Under 700 sq ft");
  });

  it("labels middle and top tiers from their neighbours", () => {
    expect(tierRangeLabel(res[2]!, res[1], labels)).toBe("900–1,100 sq ft");
    expect(tierRangeLabel(res.at(-1)!, res.at(-2), labels)).toBe("Over 3,500 sq ft");
  });

  it("labels a lone unbounded tier as any size", () => {
    const only: PricingTier = { maxSqft: Infinity, price: 100 };
    expect(tierRangeLabel(only, undefined, labels)).toBe("Any size");
  });
});

// ---------------------------------------------------------------------------
// Stored overrides survive a deploy
// ---------------------------------------------------------------------------

describe("stored override precedence", () => {
  it("uses the stored config, not the new defaults, when an override exists", async () => {
    const stored = storedDefaults();
    stored.tiers.residential = [
      { maxSqft: 1000, price: 149.99 },
      { maxSqft: null, price: 249.99, startingAt: true },
    ];
    mockGetSetting.mockResolvedValue(JSON.stringify(stored));

    const caller = bookingRouter.createCaller({
      user: null,
      req: { protocol: "https", headers: { origin: "https://example.com" } } as unknown as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    });
    const quote = await caller.calculate({
      type: "residential",
      bedrooms: 2,
      bathrooms: 1,
      sqft: 800,
      extras: [],
      frequency: "onetime",
    });

    // The owner's stored $149.99 wins; the new $89.99 default is not applied.
    expect(quote.total).toBe(149.99);
  });

  it("falls back to the new defaults only when nothing is stored", async () => {
    mockGetSetting.mockResolvedValue(null);
    const caller = bookingRouter.createCaller({
      user: null,
      req: { protocol: "https", headers: { origin: "https://example.com" } } as unknown as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    });
    const quote = await caller.calculate({
      type: "residential",
      bedrooms: 2,
      bathrooms: 1,
      sqft: 800,
      extras: [],
      frequency: "onetime",
    });
    expect(quote.total).toBe(89.99);
  });

  it("keeps an old 6-tier stored ladder working unchanged", () => {
    const legacy = {
      ...storedDefaults(),
      tiers: {
        residential: [
          { maxSqft: 1000, price: 99.99 },
          { maxSqft: 1500, price: 129.99 },
          { maxSqft: 2000, price: 159.99 },
          { maxSqft: 2500, price: 199.99 },
          { maxSqft: 3500, price: 249.99, startingAt: true },
          { maxSqft: null, price: 0, customQuote: true },
        ],
        deep: storedDefaults().tiers.deep,
        moveinout: storedDefaults().tiers.moveinout,
      },
    };
    const parsed = parsePricingConfig(JSON.stringify(legacy));
    expect(parsed.tiers.residential).toHaveLength(6);
    expect(getTier("residential", 1200, parsed)?.price).toBe(129.99);
    // And it still satisfies the new write-path rules, so it can be re-saved.
    expect(validatePricingConfig(legacy).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// County-verified sqft re-pricing across the finer tiers
// ---------------------------------------------------------------------------

describe("county-verified sqft re-pricing", () => {
  const bookingCaller = () =>
    bookingRouter.createCaller({
      user: null,
      req: { protocol: "https", headers: { origin: "https://example.com" } } as unknown as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    });

  const input = (sqft: number) => ({
    quote: {
      type: "residential" as const,
      bedrooms: 2,
      bathrooms: 1,
      sqft,
      extras: [] as never[],
      frequency: "onetime" as const,
    },
    date: "2026-07-20", // Monday — open under the default schedule
    time: "10:00",
    firstName: "Ana",
    lastName: "Lopez",
    email: "ana@example.com",
    phone: "2105550000",
    address: "1 Main St",
    city: "San Antonio",
    zip: "78201",
    locale: "en" as const,
  });

  it("re-prices up when the verified sqft lands one fine tier higher", async () => {
    // Customer enters 1,050 (900–1,100 → $99.99); county says 1,150 (1,100–1,300 → $112.99).
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 1150, source: "bexar_gis" });
    await bookingCaller().create(input(1050));

    const booking = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(booking.totalAmount).toBe(112.99);
    expect(booking.sqft).toBe(1150);
    expect(booking.verifiedSqft).toBe(1150);
    expect(booking.sqftMismatch).toBe(true);
  });

  it("catches a small understatement the old 500 sq ft bands would have missed", async () => {
    // 1,450 and 1,550 both sat in the old 1,000–1,500/1,500–2,000 split coarsely;
    // on the fine ladder they are $124.99 vs $136.99.
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 1550, source: "bexar_gis" });
    await bookingCaller().create(input(1450));

    const booking = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(booking.totalAmount).toBe(136.99);
    expect(booking.sqftMismatch).toBe(true);
  });

  it("keeps the entered sqft when the verified record prices no higher", async () => {
    // Verified 1,000 is a lower tier than the entered 1,200 — never re-price down.
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 1000, source: "bexar_gis" });
    await bookingCaller().create(input(1200));

    const booking = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(booking.totalAmount).toBe(112.99);
    expect(booking.sqft).toBe(1200);
    expect(booking.sqftMismatch).toBe(false);
  });

  it("does not re-price when both sizes sit in the same fine tier", async () => {
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 1250, source: "bexar_gis" });
    await bookingCaller().create(input(1150));

    const booking = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(booking.totalAmount).toBe(112.99);
    expect(booking.sqftMismatch).toBe(false);
  });

  it("re-prices against the owner's stored ladder, not the defaults", async () => {
    const stored = storedDefaults();
    stored.tiers.residential = [
      { maxSqft: 1100, price: 200 },
      { maxSqft: null, price: 400, startingAt: true },
    ];
    mockGetSetting.mockResolvedValue(JSON.stringify(stored));
    mockLookupProperty.mockResolvedValue({ verified: true, addressVerified: true, sqft: 1200, source: "bexar_gis" });
    await bookingCaller().create(input(1000));

    const booking = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(booking.totalAmount).toBe(400);
    expect(booking.sqftMismatch).toBe(true);
  });
});
