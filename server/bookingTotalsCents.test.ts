/**
 * Booking totals keep their cents end to end.
 *
 * The production case: a deep clean at 3,000 sq ft ($413.99) plus a $60
 * add-on is $473.99, and the confirmation page showed "$474". The bookings
 * table stores the exact figure in `totalAmountCents` and a whole-dollar
 * copy in the legacy `totalAmount` INT column (kept for rollback); the
 * post-checkout confirmation, the status lookup, every list payload, the tip
 * page and the admin views read the legacy column and dropped the cents.
 *
 * What this file pins:
 *   - exactDollars: cents when recorded, the legacy dollars otherwise;
 *   - every list payload (stripPayToken) carries exact totals and deposits;
 *   - booking.confirm and booking.byReference — the confirmation page — are
 *     exact, as is the tip page, the balance-approval context and the brain
 *     ticker;
 *   - the confirmation page formats the figure with its cents;
 *   - the reported arithmetic, start to finish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetBookingByReference = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetBookingByTipToken = vi.fn();
const mockGetCustomerById = vi.fn();
const mockListAwaiting = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getBookingByReference: (...a: unknown[]) => mockGetBookingByReference(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getBookingByTipToken: (...a: unknown[]) => mockGetBookingByTipToken(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    listInvoicesAwaitingApproval: (...a: unknown[]) => mockListAwaiting(...a),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    listBookings: vi.fn().mockResolvedValue([]),
    listInvoices: vi.fn().mockResolvedValue([]),
    getOccupiedBookings: vi.fn().mockResolvedValue([]),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    updateBooking: vi.fn().mockResolvedValue(undefined),
    createBooking: vi.fn().mockResolvedValue(99),
    findOrCreateCustomer: vi.fn().mockResolvedValue(7),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setSetting: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: vi.fn().mockResolvedValue({ messageId: "1" }) }) },
}));

import { dollarsToCents, exactDollars, legacyWholeDollars } from "@shared/money";
import { calculateQuote, DEFAULT_PRICING } from "@shared/pricing";
import { _resetRateLimits } from "./antiSpam";
import { stripPayToken } from "./db";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { tipRouter } from "./routers/tip";
import { tipPresets } from "./tip";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const ORIGIN = "https://grapeclean.example";

/** GFC-9RZ3VG's shape: a deep clean plus a $60 add-on, $473.99, stored as 474 in the legacy column. */
const BOOKING = {
  id: 501,
  reference: "GFC-9RZ3VG",
  customerId: 41,
  serviceType: "deep",
  frequency: "onetime",
  status: "confirmed",
  scheduledDate: "2026-10-02",
  scheduledTime: "09:00",
  locale: "en",
  totalAmount: 474,
  totalAmountCents: 47399,
  depositAmount: 118,
  depositAmountCents: 11850,
  stripeSessionId: "cs_1",
  stripePaymentIntentId: "pi_1",
  paymentPreference: null,
  kind: "self_serve",
  extras: '["oven"]',
  tipToken: "t".repeat(48),
  tipPaidAt: null,
  tipDeclinedAt: null,
  payToken: "p".repeat(48),
};

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
const tipCaller = () =>
  tipRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetBookingByReference.mockResolvedValue(BOOKING);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetBookingByTipToken.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue({ id: 41, firstName: "Maria", lastName: "Prado", email: "maria@example.com" });
  mockListAwaiting.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the reported arithmetic", () => {
  it("a deep clean at 3,000 sq ft is $413.99; with a $60 add-on it is $473.99, never $474", () => {
    const base = calculateQuote({ type: "deep", bedrooms: 3, bathrooms: 2, sqft: 3000, extras: [], frequency: "onetime" }, DEFAULT_PRICING);
    expect(base.total).toBe(413.99);
    const withAddon = dollarsToCents(413.99) + 6000;
    expect(withAddon).toBe(47399);
    // The legacy column really does hold 474 — that is what leaked.
    expect(legacyWholeDollars(withAddon)).toBe(474);
    expect(exactDollars(withAddon, legacyWholeDollars(withAddon))).toBe(473.99);
  });

  it("exactDollars prefers the cents and falls back to the legacy dollars for rows without them", () => {
    expect(exactDollars(47399, 474)).toBe(473.99);
    expect(exactDollars(null, 474)).toBe(474);
    expect(exactDollars(undefined, 85)).toBe(85);
    expect(exactDollars(0, 5)).toBe(0);
  });
});

describe("every list payload carries exact money", () => {
  it("stripPayToken replaces the whole-dollar copies with the recorded cents", () => {
    const row = stripPayToken(BOOKING);
    expect(row.totalAmount).toBe(473.99);
    expect(row.depositAmount).toBe(118.5);
    expect(row.hasPayToken).toBe(true);
    expect("payToken" in row).toBe(false);
    expect("tipToken" in row).toBe(false);
  });

  it("a row from before the cents columns keeps its whole-dollar figures", () => {
    const row = stripPayToken({ ...BOOKING, totalAmountCents: null, depositAmountCents: null, totalAmount: 85, depositAmount: 17 });
    expect(row.totalAmount).toBe(85);
    expect(row.depositAmount).toBe(17);
  });

  it("a row without money fields is left alone", () => {
    const row = stripPayToken({ id: 1, payToken: null, tipToken: null, reference: "GFC-X" });
    expect(row).toEqual({ id: 1, reference: "GFC-X", hasPayToken: false });
  });
});

describe("the confirmation page", () => {
  it("booking.confirm returns the exact total and deposit for a paid booking", async () => {
    const result = await publicCaller().confirm({ sessionId: "cs_1", reference: "GFC-9RZ3VG" });
    expect(result.confirmed).toBe(true);
    if (!result.confirmed) throw new Error("unreachable");
    expect(result.booking.total).toBe(473.99);
    expect(result.booking.deposit).toBe(118.5);
  });

  it("booking.byReference is exact too", async () => {
    const result = await publicCaller().byReference({ reference: "GFC-9RZ3VG" });
    expect(result?.total).toBe(473.99);
    expect(result?.deposit).toBe(118.5);
  });

  it("the page formats the figure with its cents rather than printing the raw number", () => {
    const page = source("../client/src/pages/Booking.tsx");
    expect(page).toContain("${formatPrice(confirmed.total)}");
    expect(page).not.toContain("${confirmed.total}");
  });
});

describe("the other readers of the legacy column", () => {
  it("the tip page and its presets start from the exact job total", async () => {
    const page = await tipCaller().get({ token: BOOKING.tipToken });
    expect(page.booking?.total).toBe(473.99);
    expect(page.booking?.presets).toEqual(tipPresets(473.99));
  });

  it("the balance-approval context shows the exact booking total and credited deposit", async () => {
    mockListAwaiting.mockResolvedValue([
      { id: 9, number: "INV-1", kind: "balance", status: "awaiting_approval", bookingId: 501, customerId: 41, amount: 355, amountCents: 35549, payToken: "x" },
    ]);
    const [row] = await adminCaller().awaitingApprovalInvoices();
    expect(row?.bookingTotal).toBe(473.99);
    expect(row?.depositCredited).toBe(118.5);
    expect("payToken" in (row ?? {})).toBe(false);
  });

  it("no router hands the confirmation page or the brain the legacy whole-dollar column", () => {
    const booking = source("./routers/booking.ts");
    expect(booking).not.toContain("total: updated.totalAmount");
    expect(booking).not.toContain("total: booking.totalAmount");
    expect(booking).toContain("total: exactDollars(updated.totalAmountCents, updated.totalAmount)");
    expect(booking).toContain("total: exactDollars(booking.totalAmountCents, booking.totalAmount)");
    expect(source("./brainRoutes.ts")).toContain("totalAmount: exactDollars(row.totalAmountCents, row.totalAmount)");
    expect(source("./routers/admin.ts")).toContain("basePrice: priced ? exactDollars(booking.totalAmountCents, booking.totalAmount) : null");
    expect(source("./tip.ts")).toContain("const jobTotal = exactDollars(booking.totalAmountCents, booking.totalAmount);");
    expect(source("./routers/tip.ts")).not.toContain("tipPresets(booking.totalAmount)");
  });
});
