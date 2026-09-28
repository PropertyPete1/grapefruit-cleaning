/**
 * An add-on the service already includes is never charged on top.
 *
 * The production case: a Deep Cleaning at 3,000 sq ft, quoted $413.99, was
 * confirmed at $473.99 with "Extras: Deep cleaning" — the customer tapped the
 * $60 Deep cleaning add-on on the extras step, which every add-on list
 * offered for every service, and the server accepted it. Nothing auto-selected
 * it; it was simply selectable, and nothing refused it.
 *
 * What this file pins:
 *   - the rule (shared/addonRules.ts): deep ⇔ deepClean, moveinout ⇔ moveOut;
 *     the same add-on stays a legitimate upsell on any other service;
 *   - booking.calculate and booking.create refuse a duplicate, in the
 *     customer's language, writing nothing — on the legacy extras path and on
 *     the dynamic catalog path alike;
 *   - the deposit link refuses one at every pay entry point, drops one when
 *     the service is chosen after the extra, and never prices a stale one;
 *   - invoices refuse one on approval and on a manual invoice for that service;
 *   - every add-on list (quote wizard, booking form, deposit link, invoice
 *     checklist) shows the add-on as included and unselectable, and a service
 *     change drops it from whatever was chosen before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetBookingByPayToken = vi.fn();
const mockGetBookingById = vi.fn();
const mockUpdateBooking = vi.fn();
const mockCreateBooking = vi.fn();
const mockCreateBookingWithAddons = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockListAddonCategories = vi.fn();
const mockListAddons = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getBookingByPayToken: (...a: unknown[]) => mockGetBookingByPayToken(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    createBookingWithAddons: (...a: unknown[]) => mockCreateBookingWithAddons(...a),
    getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    listAddonCategories: (...a: unknown[]) => mockListAddonCategories(...a),
    listAddons: (...a: unknown[]) => mockListAddons(...a),
    updateBookingWithAddons: vi.fn().mockResolvedValue(undefined),
    findOrCreateCustomer: vi.fn().mockResolvedValue(7),
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    getOccupiedBookings: vi.fn().mockResolvedValue([]),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    listBalanceInvoicesForBookings: vi.fn().mockResolvedValue([]),
    createInvoice: vi.fn().mockResolvedValue(77),
    updateInvoice: vi.fn().mockResolvedValue(undefined),
    findCustomersByContact: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./property", async () => {
  const actual = await vi.importActual<typeof import("./property")>("./property");
  return { ...actual, lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a) };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a), expire: vi.fn() } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { ADDON_CATALOG_FLAG_KEY } from "@shared/addonCatalog";
import {
  addonIncludedIn,
  duplicateAddonMessage,
  duplicateAddons,
  INCLUDED_ADDONS,
  includedAddonKeys,
  includedInServiceLabel,
  withoutIncludedAddons,
} from "@shared/addonRules";
import { CLEANING_TYPES } from "@shared/pricing";
import { assertNoDuplicateAddons } from "./addonRules";
import { _resetRateLimits } from "./antiSpam";
import { approveBalanceInvoice, issueManualInvoice, resolveLineItems } from "./balance";
import { bookingRouter } from "./routers/booking";
import { depositLinkRouter } from "./routers/depositLink";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const ORIGIN = "https://grapeclean.example";
const TOKEN = "f".repeat(48);
const DEEP_EN = "Deep cleaning is already included in a Deep Cleaning — remove that add-on; it is never charged twice.";
const DEEP_ES = "Limpieza profunda ya está incluido en el servicio de Limpieza Profunda — quite ese extra; nunca se cobra dos veces.";

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
const payCaller = () =>
  depositLinkRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

/** The reported booking's inputs: a deep clean at 3,000 sq ft. */
const deepInput = (extras: string[], locale: "en" | "es" = "en") => ({
  quote: { type: "deep" as const, bedrooms: 3, bathrooms: 2, sqft: 3000, extras, frequency: "onetime" as const },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "5125550134",
  address: "800 Congress Ave",
  city: "Austin",
  zip: "78701",
  locale,
});

/** A deposit link for a deep clean the owner set up, waiting on the customer. */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  reference: "GFC-LINK1",
  customerId: 7,
  grandfatheredCustomerId: null,
  grandfatheredBaseCents: null,
  serviceType: "deep",
  frequency: "onetime",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "10:00",
  bedrooms: 3,
  bathrooms: 2,
  sqft: 3000,
  extras: "[]",
  addonsAmountCents: 0,
  addressLine: "1 Main St",
  unitNumber: null,
  propertyType: "house",
  city: "San Antonio",
  zip: "78201",
  notes: null,
  locale: "en",
  totalAmount: 414,
  totalAmountCents: 41399,
  depositAmount: 103,
  depositAmountCents: 10350,
  status: "pending_deposit",
  couponCode: null,
  discountApplied: 0,
  estimatedHours: 4,
  verifiedSqft: null,
  sqftMismatch: false,
  stripePaymentIntentId: null,
  paymentPreference: null,
  kind: "admin",
  holdMinutes: 24 * 60,
  payToken: TOKEN,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  adminProvided: "service,size,address,slot",
  createdAt: new Date(),
  ...overrides,
});

/** The dynamic catalog with the two legacy add-ons the case turns on, plus one that is fine anywhere. */
const CATALOG_ROWS = {
  categories: [
    { id: 1, key: "legacy-general", nameEn: "Add-ons", nameEs: "Extras", descriptionEn: null, descriptionEs: null, noteEn: null, noteEs: null, sortOrder: 10, isEnabled: true, showPublicHeading: false, updatedAt: new Date("2026-09-01T00:00:00Z") },
  ],
  addons: [
    { id: 1, key: "deepClean", categoryId: 1, nameEn: "Deep cleaning", nameEs: "Limpieza profunda", descriptionEn: null, descriptionEs: null, includedItemsEn: null, includedItemsEs: null, noteEn: null, noteEs: null, priceMode: "fixed", startingPriceCents: 6000, mayVary: false, sortOrder: 20, isEnabled: true, archivedAt: null, updatedAt: new Date("2026-09-01T00:00:00Z") },
    { id: 2, key: "moveOut", categoryId: 1, nameEn: "Move out condition", nameEs: "Condición de mudanza", descriptionEn: null, descriptionEs: null, includedItemsEn: null, includedItemsEs: null, noteEn: null, noteEs: null, priceMode: "fixed", startingPriceCents: 7000, mayVary: false, sortOrder: 30, isEnabled: true, archivedAt: null, updatedAt: new Date("2026-09-01T00:00:00Z") },
    { id: 3, key: "oven", categoryId: 1, nameEn: "Inside oven", nameEs: "Interior del horno", descriptionEn: null, descriptionEs: null, includedItemsEn: null, includedItemsEs: null, noteEn: null, noteEs: null, priceMode: "fixed", startingPriceCents: 3500, mayVary: false, sortOrder: 40, isEnabled: true, archivedAt: null, updatedAt: new Date("2026-09-01T00:00:00Z") },
  ],
};

const catalogOn = () => {
  mockGetSetting.mockImplementation(async (key: string) => (key === ADDON_CATALOG_FLAG_KEY ? "true" : null));
  mockListAddonCategories.mockResolvedValue(CATALOG_ROWS.categories);
  mockListAddons.mockResolvedValue(CATALOG_ROWS.addons);
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockListAddonCategories.mockResolvedValue([]);
  mockListAddons.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockCreateBookingWithAddons.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetBookingByPayToken.mockResolvedValue(linkRow());
  mockGetBookingById.mockResolvedValue(linkRow());
  mockGetInvoiceById.mockResolvedValue(undefined);
  mockGetCustomerById.mockResolvedValue({ id: 7, firstName: "Ana", lastName: "Lopez", email: "ana@example.com", phone: "5125550134" });
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The rule.
// ---------------------------------------------------------------------------

describe("which add-ons a service already includes", () => {
  it("a deep clean includes the deep-cleaning add-on; a move in/out includes the move-out condition", () => {
    expect(includedAddonKeys("deep")).toEqual(["deepClean"]);
    expect(includedAddonKeys("moveinout")).toEqual(["moveOut"]);
    for (const type of ["residential", "commercial", "airbnb", "office"] as const) {
      expect(includedAddonKeys(type), type).toEqual([]);
    }
    // Every service has an entry, so a new service cannot silently opt out of the rule.
    expect(Object.keys(INCLUDED_ADDONS).sort()).toEqual([...CLEANING_TYPES].sort());
  });

  it("finds the duplicates and keeps everything else", () => {
    expect(duplicateAddons("deep", ["deepClean", "oven"])).toEqual(["deepClean"]);
    expect(duplicateAddons("residential", ["deepClean", "oven"])).toEqual([]);
    expect(withoutIncludedAddons("deep", ["deepClean", "oven", "windows"])).toEqual(["oven", "windows"]);
    expect(withoutIncludedAddons("moveinout", ["moveOut"])).toEqual([]);
    expect(withoutIncludedAddons(null, ["deepClean"])).toEqual(["deepClean"]);
    expect(addonIncludedIn("deep", "deepClean")).toBe(true);
    expect(addonIncludedIn("deep", "moveOut")).toBe(false);
    expect(addonIncludedIn(undefined, "deepClean")).toBe(false);
    expect(addonIncludedIn("carpet", "deepClean")).toBe(false);
  });

  it("the refusal and the badge are worded in both languages", () => {
    expect(duplicateAddonMessage({ addonName: "Deep cleaning", serviceName: "Deep Cleaning", locale: "en" })).toBe(DEEP_EN);
    expect(duplicateAddonMessage({ addonName: "Limpieza profunda", serviceName: "Limpieza Profunda", locale: "es" })).toBe(DEEP_ES);
    expect(includedInServiceLabel("Deep Cleaning", "en")).toBe("Included in Deep Cleaning");
    expect(includedInServiceLabel("Limpieza Profunda", "es")).toBe("Incluido en Limpieza Profunda");
    expect(() => assertNoDuplicateAddons("deep", ["deepClean"], "es")).toThrow(DEEP_ES);
    expect(() => assertNoDuplicateAddons("deep", ["oven"])).not.toThrow();
    expect(() => assertNoDuplicateAddons(null, ["deepClean"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The public flow.
// ---------------------------------------------------------------------------

describe("booking.create — the reported case", () => {
  it("refuses the Deep cleaning add-on on a Deep Cleaning, in the customer's language, and writes nothing", async () => {
    await expect(publicCaller().create(deepInput(["deepClean"]))).rejects.toMatchObject({ code: "BAD_REQUEST", message: DEEP_EN });
    await expect(publicCaller().create(deepInput(["deepClean", "oven"], "es"))).rejects.toMatchObject({ message: DEEP_ES });
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("prices the deep clean at $413.99, and a legitimate add-on on top keeps its cents", async () => {
    await publicCaller().create(deepInput([]));
    expect((mockCreateBooking.mock.calls[0]![0] as { totalAmountCents: number }).totalAmountCents).toBe(41399);
    mockCreateBooking.mockClear();
    await publicCaller().create(deepInput(["oven"]));
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.totalAmountCents).toBe(44899);
    expect(written.totalAmount).toBe(448.99);
    expect(written.extras).toBe('["oven"]');
  });

  it("the same add-on stays a real upsell on a service that does not include it", async () => {
    await publicCaller().create({ ...deepInput(["deepClean"]), quote: { ...deepInput([]).quote, type: "residential", sqft: 1200, extras: ["deepClean"] } });
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.totalAmountCents).toBe(11299 + 6000);
  });

  it("the move-out condition is refused on a move in/out cleaning", async () => {
    await expect(
      publicCaller().create({ ...deepInput([]), quote: { ...deepInput([]).quote, type: "moveinout", extras: ["moveOut"] } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /Move out condition is already included in a Move In\/Out Cleaning/ });
  });

  it("refuses on the dynamic catalog path too, and accepts a legitimate catalog add-on", async () => {
    catalogOn();
    await expect(publicCaller().create(deepInput(["deepClean"]))).rejects.toMatchObject({ code: "BAD_REQUEST", message: DEEP_EN });
    expect(mockCreateBookingWithAddons).not.toHaveBeenCalled();
    await publicCaller().create(deepInput(["oven"]));
    const [written, snapshots] = mockCreateBookingWithAddons.mock.calls[0]! as [Record<string, unknown>, { addonKey: string }[]];
    expect(written.totalAmountCents).toBe(44899);
    expect(snapshots.map(s => s.addonKey)).toEqual(["oven"]);
  });

  it("booking.calculate refuses the duplicate as well — no preview ever shows the stacked price", async () => {
    const quote = deepInput(["deepClean"]).quote;
    await expect(publicCaller().calculate(quote)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await publicCaller().calculate({ ...quote, extras: ["oven"] });
    expect(ok.total).toBe(448.99);
    catalogOn();
    await expect(publicCaller().calculate(quote)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// The deposit link.
// ---------------------------------------------------------------------------

describe("the deposit link", () => {
  it("refuses a duplicate at every pay entry point", async () => {
    for (const call of [
      () => payCaller().createSession({ token: TOKEN, extras: ["deepClean"] }),
      () => payCaller().confirm({ token: TOKEN, extras: ["deepClean"] }),
      () => payCaller().chooseCash({ token: TOKEN, extras: ["deepClean"] }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST", message: DEEP_EN });
    }
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("in Spanish for a Spanish link", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ locale: "es" }));
    await expect(payCaller().createSession({ token: TOKEN, extras: ["deepClean"] })).rejects.toMatchObject({ message: DEEP_ES });
  });

  it("still takes a legitimate add-on, with its cents", async () => {
    await payCaller().createSession({ token: TOKEN, extras: ["oven"] });
    const patch = mockUpdateBooking.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.extras).toBe('["oven"]');
    expect(patch.totalAmountCents).toBe(44899);
  });

  it("choosing a deep clean after tapping Deep cleaning drops the add-on from the link", async () => {
    // The owner left the service open; the customer tapped extras first.
    const open = linkRow({ serviceType: null, sqft: null, adminProvided: "address", extras: '["deepClean","oven"]', scheduledDate: null, scheduledTime: null });
    mockGetBookingByPayToken.mockResolvedValue(open);
    mockGetBookingById.mockResolvedValue({ ...open, serviceType: "deep", extras: '["oven"]' });
    await payCaller().updateDetails({ token: TOKEN, serviceType: "deep" });
    expect(mockUpdateBooking).toHaveBeenCalledWith(99, expect.objectContaining({ serviceType: "deep", extras: '["oven"]' }));
  });

  it("a stale duplicate stored before the rule never prices again on the page", async () => {
    mockGetBookingByPayToken.mockResolvedValue(linkRow({ extras: '["deepClean"]' }));
    const page = await payCaller().get({ token: TOKEN });
    expect(page.booking?.selectedExtras).toEqual([]);
    expect(page.booking?.total).toBe(413.99);
  });
});

// ---------------------------------------------------------------------------
// Invoices.
// ---------------------------------------------------------------------------

describe("invoices", () => {
  it("a manual invoice for a deep clean refuses the deep-cleaning add-on and bills any other", async () => {
    await expect(
      issueManualInvoice({ customerId: 7, amount: 413.99, addonIds: ["deepClean"], serviceType: "deep", origin: ORIGIN })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: DEEP_EN });
    const items = await resolveLineItems(["oven"], [], "deep");
    expect(items).toHaveLength(1);
    // With no service named there is nothing to duplicate.
    expect(await resolveLineItems(["deepClean"], [], null)).toHaveLength(1);
  });

  it("approving a deep clean's balance refuses the deep-cleaning add-on", async () => {
    mockGetInvoiceById.mockResolvedValue({ id: 9, kind: "balance", status: "awaiting_approval", bookingId: 99, customerId: 7, amount: 310, amountCents: 31049 });
    mockGetBookingById.mockResolvedValue(linkRow({ status: "completed", kind: "self_serve" }));
    await expect(
      approveBalanceInvoice({ invoiceId: 9, approvedByUserId: 1, origin: ORIGIN, addonIds: ["deepClean"] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: DEEP_EN });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Every add-on list.
// ---------------------------------------------------------------------------

describe("the add-on lists", () => {
  it("the shared catalog picker shows an included add-on as included and unselectable", () => {
    const picker = source("../client/src/components/AddonCatalogPicker.tsx");
    expect(picker).toContain("serviceType?: string | null;");
    expect(picker).toContain("const bundled = addonIncludedIn(serviceType, addon.key);");
    expect(picker).toContain("disabled={bundled}");
    expect(picker).toContain("onClick={() => !bundled && onToggle(addon.key)}");
    expect(picker).toContain("{INCLUDED_LABEL[locale]}");
  });

  it("the quote wizard and the booking form drop the service's own work and never offer it", () => {
    for (const rel of ["../client/src/pages/Quote.tsx", "../client/src/pages/Booking.tsx"]) {
      const page = source(rel);
      expect(page, rel).toContain("if (addonIncludedIn(type, id)) return;");
      expect(page, rel).toContain("setExtras(prev => withoutIncludedAddons(next, prev));");
      expect(page, rel).toContain("onClick={() => chooseType(svc.id)}");
      expect(page, rel).not.toContain("onClick={() => setType(svc.id)}");
      expect(page, rel).toContain("serviceType={type}");
      expect(page, rel).toContain('data-included={bundled ? "true" : undefined}');
      expect(page, rel).toContain("includedInServiceLabel(");
    }
    // A handoff URL (or an old link) never carries the service's own work.
    expect(source("../client/src/pages/Booking.tsx")).toContain('return withoutIncludedAddons(type, raw.split(",")');
  });

  it("the deposit link page and the invoice checklist follow the same rule", () => {
    const pay = source("../client/src/pages/PayDeposit.tsx");
    expect(pay).toContain("const chosen = withoutIncludedAddons(booking?.serviceType ?? null, extras ?? (booking?.selectedExtras ?? []));");
    expect(pay).toContain("serviceType={booking.serviceType}");
    expect(pay).toContain("const bundled = addonIncludedIn(booking.serviceType, id);");
    expect(pay).toContain("{bundled ? INCLUDED_LABEL[locale] : `+${money(price)}`}");
    const editor = source("../client/src/pages/admin/InvoiceItemsEditor.tsx");
    expect(editor).toContain("const bundled = addonIncludedIn(serviceType, option.id);");
    expect(editor).toContain('{bundled ? "Included" : `+${fmtMoney(option.price)}`}');
    const invoices = source("../client/src/pages/admin/AdminInvoices.tsx");
    expect(invoices).toContain("serviceType={invoice.serviceType}");
    expect(invoices).toContain("serviceType={form.serviceType || null}");
    expect(invoices).toContain("setNewAddons(prev => withoutIncludedAddons(v, prev));");
  });
});
