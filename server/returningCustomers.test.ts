/**
 * Recurring plans are for returning customers (PR C2).
 *
 * What this file pins:
 *   - the rule (shared/returningCustomer.ts): a customer is returning when
 *     their normalized email OR phone matches a customer with a booking that is
 *     completed AND paid — a paid invoice (card through the balance link,
 *     Test D; cash the owner recorded, Test F; an Airbnb balance, Test E), or
 *     a captured deposit that covered the whole job. Never an open invoice, a
 *     cancelled job, or a completed job nobody ever billed;
 *   - the public lookup answers yes or no and nothing else, and is rate-limited;
 *   - booking.create refuses a recurring frequency from a first-time customer
 *     with one localized message and writes nothing; accepts it from a
 *     returning one at the discounted price; one-time never consults the rule;
 *     the owner's own form is never gated;
 *   - the public pages: the pricing page has no frequency toggle and shows the
 *     note; the quote wizard has no frequency step and shows the note; the
 *     booking form shows the note on the first step and offers the plans on
 *     the review step only once the contact details are recognised — in both
 *     languages, with the exact sentence from the spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockGetCustomerById = vi.fn();
const mockFindCustomersByContact = vi.fn();
const mockListCompleted = vi.fn();
const mockListInvoiceStates = vi.fn();
const mockSessionCreate = vi.fn();
const mockLookupProperty = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    findOrCreateCustomer: (...a: unknown[]) => mockFindOrCreateCustomer(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    findCustomersByContact: (...a: unknown[]) => mockFindCustomersByContact(...a),
    listCompletedBookingsForCustomers: (...a: unknown[]) => mockListCompleted(...a),
    listInvoiceStatesForBookings: (...a: unknown[]) => mockListInvoiceStates(...a),
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    getBookingById: vi.fn().mockResolvedValue(undefined),
    getBookingByPayToken: vi.fn().mockResolvedValue(undefined),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
    listElapsedDepositBookings: vi.fn().mockResolvedValue([]),
    expireElapsedDepositBooking: vi.fn().mockResolvedValue(false),
    setBookingRescheduleToken: vi.fn().mockResolvedValue(undefined),
    listBookingAddonsByBooking: vi.fn().mockResolvedValue([]),
    listBalanceInvoicesForBookings: vi.fn().mockResolvedValue([]),
    listBookings: vi.fn().mockResolvedValue([]),
    listInvoices: vi.fn().mockResolvedValue([]),
    listInvoicesAwaitingApproval: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./property", async () => {
  const actual = await vi.importActual<typeof import("./property")>("./property");
  return { ...actual, lookupPropertySqft: (...a: unknown[]) => mockLookupProperty(...a) };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { dollarsToCents } from "@shared/money";
import { calculateQuote, DEFAULT_PRICING } from "@shared/pricing";
import {
  bookingCompletedAndPaid,
  frequencyAllowedFor,
  isRecurringFrequency,
  isReturningFrom,
  matchingCustomerIds,
  RECURRING_LOCKED_MESSAGE,
  RECURRING_UNLOCK_NOTE,
} from "@shared/returningCustomer";
import { _resetRateLimits } from "./antiSpam";
import { isReturningCustomer } from "./returningCustomers";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const ORIGIN = "https://grapeclean.example";

/** A returning customer's row, contact stored the way people type it. */
const ROSA = { id: 42, email: "Rosa.Delgado@Example.com", phone: "(210) 555-0160" };
/** Someone we have never cleaned for. */
const NEW_CONTACT = { email: "first.timer@example.com", phone: "512-555-0101" };

const completed = (overrides: Record<string, unknown> = {}) => ({
  id: 500,
  customerId: 42,
  status: "completed",
  totalAmount: 112.99,
  totalAmountCents: 11299,
  depositAmount: 22.6,
  depositAmountCents: 2260,
  stripePaymentIntentId: "pi_deposit",
  ...overrides,
});

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

const publicInput = (overrides: Record<string, unknown> = {}) => ({
  quote: { type: "residential" as const, bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [] as string[], frequency: "biweekly" as const },
  date: OPEN_MONDAY,
  time: "10:00",
  firstName: "Rosa",
  lastName: "Delgado",
  email: "rosa.delgado@example.com",
  phone: "2105550160",
  address: "88 Pecan St",
  city: "San Antonio",
  zip: "78205",
  locale: "en" as const,
  ...overrides,
});

/** Make the mocked database say "returning" (or not) for whoever asks. */
const returningInDb = (yes: boolean) => {
  mockFindCustomersByContact.mockResolvedValue(yes ? [ROSA] : []);
  mockListCompleted.mockResolvedValue(yes ? [completed()] : []);
  mockListInvoiceStates.mockResolvedValue(yes ? [{ bookingId: 500, status: "paid", paidAt: new Date("2026-09-02T00:00:00Z") }] : []);
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockLookupProperty.mockResolvedValue({ verified: false, addressVerified: false });
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockFindOrCreateCustomer.mockImplementation(async (data: { customerId?: number }) => data.customerId ?? 7);
  mockGetCustomerById.mockResolvedValue(undefined);
  returningInDb(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The rule.
// ---------------------------------------------------------------------------

describe("what makes a booking count: completed and paid", () => {
  it("Test D — a regular customer's balance paid through the link", () => {
    expect(bookingCompletedAndPaid(completed(), [{ status: "paid" }])).toBe(true);
  });

  it("Test F — a cash payment the owner recorded settles the invoice the same way", () => {
    expect(bookingCompletedAndPaid(completed(), [{ status: "paid", paidVia: "manual", paidMethod: "cash" } as never])).toBe(true);
  });

  it("Test E — an Airbnb job, no deposit ever, paid through its balance invoice", () => {
    const airbnb = completed({ depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null });
    expect(bookingCompletedAndPaid(airbnb, [{ status: "paid" }])).toBe(true);
    expect(bookingCompletedAndPaid(airbnb, [{ status: "sent" }])).toBe(false);
  });

  it("an open invoice — sent, overdue, awaiting approval, draft — is money still owed", () => {
    for (const status of ["sent", "overdue", "awaiting_approval", "draft"]) {
      expect(bookingCompletedAndPaid(completed(), [{ status }]), status).toBe(false);
    }
    // Even alongside an older paid one? No: any paid invoice settles it.
    expect(bookingCompletedAndPaid(completed(), [{ status: "paid" }, { status: "void" }])).toBe(true);
  });

  it("with no invoice, a captured deposit that covered the whole job is paid", () => {
    const zeroBalance = completed({ depositAmountCents: 11299, depositAmount: 112.99 });
    expect(bookingCompletedAndPaid(zeroBalance, [])).toBe(true);
    // Voided invoices do not count either way.
    expect(bookingCompletedAndPaid(zeroBalance, [{ status: "void" }])).toBe(true);
  });

  it("with no invoice, a deposit that covered only part of the job is not paid — nobody billed the rest", () => {
    expect(bookingCompletedAndPaid(completed(), [])).toBe(false);
  });

  it("a deposit counts only once Stripe captured it", () => {
    const unpaidDeposit = completed({ depositAmountCents: 11299, depositAmount: 112.99, stripePaymentIntentId: null });
    expect(bookingCompletedAndPaid(unpaidDeposit, [])).toBe(false);
  });

  it("Test A — a cancelled booking never counts, whatever its invoice says", () => {
    expect(bookingCompletedAndPaid(completed({ status: "cancelled" }), [{ status: "paid" }])).toBe(false);
    expect(bookingCompletedAndPaid(completed({ status: "confirmed" }), [{ status: "paid" }])).toBe(false);
  });

  it("a legacy row with no cents still prices from the whole-dollar columns", () => {
    const legacy = completed({ totalAmountCents: null, depositAmountCents: null, totalAmount: 85, depositAmount: 85 });
    expect(bookingCompletedAndPaid(legacy, [])).toBe(true);
  });
});

describe("who the contact details identify", () => {
  it("matches by normalized email — case and spacing do not matter", () => {
    expect(matchingCustomerIds([ROSA], { email: "  ROSA.DELGADO@example.com " })).toEqual([42]);
  });

  it("matches by normalized phone — formatting and a leading 1 do not matter", () => {
    expect(matchingCustomerIds([ROSA], { phone: "+1 210-555-0160" })).toEqual([42]);
    expect(matchingCustomerIds([ROSA], { phone: "2105550160" })).toEqual([42]);
  });

  it("blank details identify nobody, and a stranger matches nobody", () => {
    expect(matchingCustomerIds([ROSA], {})).toEqual([]);
    expect(matchingCustomerIds([ROSA], { email: "", phone: "" })).toEqual([]);
    expect(matchingCustomerIds([ROSA], NEW_CONTACT)).toEqual([]);
  });

  it("the whole rule over loaded rows", () => {
    const rows = {
      customers: [ROSA],
      bookings: [completed()],
      invoices: [{ bookingId: 500, status: "paid" }],
    };
    expect(isReturningFrom({ contact: { email: "rosa.delgado@example.com" }, ...rows })).toBe(true);
    expect(isReturningFrom({ contact: NEW_CONTACT, ...rows })).toBe(false);
    // Rosa's history, but the invoice is still open: not yet.
    expect(isReturningFrom({ contact: { phone: "2105550160" }, ...rows, invoices: [{ bookingId: 500, status: "sent" }] })).toBe(false);
    // Somebody else's paid booking says nothing about Rosa.
    expect(isReturningFrom({ contact: { phone: "2105550160" }, ...rows, bookings: [completed({ customerId: 7 })] })).toBe(false);
  });

  it("one-time is always allowed; a recurring plan only for a returning customer", () => {
    expect(isRecurringFrequency("onetime")).toBe(false);
    expect(isRecurringFrequency("biweekly")).toBe(true);
    expect(frequencyAllowedFor("onetime", false)).toBe(true);
    expect(frequencyAllowedFor("monthly", false)).toBe(false);
    expect(frequencyAllowedFor("monthly", true)).toBe(true);
  });

  it("the note and the refusal are the spec's words, in both languages", () => {
    expect(RECURRING_UNLOCK_NOTE.en).toBe("Recurring plans with savings unlock after your first cleaning.");
    expect(RECURRING_UNLOCK_NOTE.es).toContain("primera limpieza");
    expect(RECURRING_LOCKED_MESSAGE.en).toContain("unlock after your first cleaning");
    expect(RECURRING_LOCKED_MESSAGE.es).toContain("primera limpieza");
  });
});

// ---------------------------------------------------------------------------
// The server loader.
// ---------------------------------------------------------------------------

describe("isReturningCustomer", () => {
  it("asks the database nothing for blank details", async () => {
    expect(await isReturningCustomer({ email: " ", phone: "" })).toBe(false);
    expect(mockFindCustomersByContact).not.toHaveBeenCalled();
  });

  it("is false for a contact we have never seen", async () => {
    expect(await isReturningCustomer(NEW_CONTACT)).toBe(false);
    expect(mockListCompleted).not.toHaveBeenCalled();
  });

  it("is false for a known customer with no completed booking", async () => {
    mockFindCustomersByContact.mockResolvedValue([ROSA]);
    mockListCompleted.mockResolvedValue([]);
    expect(await isReturningCustomer({ phone: "210 555 0160" })).toBe(false);
    expect(mockListCompleted).toHaveBeenCalledWith([42]);
    expect(mockListInvoiceStates).not.toHaveBeenCalled();
  });

  it("is true once a completed booking of theirs is paid", async () => {
    returningInDb(true);
    expect(await isReturningCustomer({ phone: "210 555 0160" })).toBe(true);
    expect(mockListInvoiceStates).toHaveBeenCalledWith([500]);
  });
});

// ---------------------------------------------------------------------------
// The public lookup.
// ---------------------------------------------------------------------------

describe("booking.returningCustomer", () => {
  it("answers yes or no — and nothing else about the customer", async () => {
    returningInDb(true);
    const answer = await publicCaller().returningCustomer({ email: "rosa.delgado@example.com" });
    expect(answer).toEqual({ returning: true });
    returningInDb(false);
    expect(await publicCaller().returningCustomer(NEW_CONTACT)).toEqual({ returning: false });
  });

  it("is rate-limited per address, like every other public lookup", async () => {
    for (let i = 0; i < 20; i += 1) await publicCaller().returningCustomer({ email: `probe${i}@example.com` });
    await expect(publicCaller().returningCustomer({ email: "probe21@example.com" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});

// ---------------------------------------------------------------------------
// booking.create.
// ---------------------------------------------------------------------------

describe("booking.create enforces the rule", () => {
  it("refuses a recurring plan from a first-time customer, in their language, and writes nothing", async () => {
    await expect(publicCaller().create(publicInput({ ...NEW_CONTACT }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: RECURRING_LOCKED_MESSAGE.en,
    });
    await expect(publicCaller().create(publicInput({ ...NEW_CONTACT, locale: "es" }))).rejects.toMatchObject({
      message: RECURRING_LOCKED_MESSAGE.es,
    });
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("accepts a recurring plan from a returning customer at the discounted price", async () => {
    returningInDb(true);
    const result = await publicCaller().create(publicInput());
    expect(result.checkoutUrl).toBe("https://stripe.test/pay");
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.frequency).toBe("biweekly");
    const expected = calculateQuote(
      { type: "residential", bedrooms: 2, bathrooms: 1, sqft: 1200, extras: [], frequency: "biweekly" },
      DEFAULT_PRICING
    );
    expect(written.totalAmountCents).toBe(dollarsToCents(expected.total));
    expect(expected.discount).toBeGreaterThan(0);
  });

  it("recognises the returning customer by phone alone, under a brand-new email", async () => {
    returningInDb(true);
    await publicCaller().create(publicInput({ email: "rosa.new.address@example.com", phone: "+1 (210) 555-0160" }));
    expect(mockFindCustomersByContact).toHaveBeenCalledWith({ email: "rosa.new.address@example.com", phone: "+1 (210) 555-0160" });
    expect(mockCreateBooking).toHaveBeenCalled();
  });

  it("never consults the rule for a one-time booking — the first-time path is unchanged", async () => {
    const result = await publicCaller().create(publicInput({ ...NEW_CONTACT, quote: { ...publicInput().quote, frequency: "onetime" } }));
    expect(result.checkoutUrl).toBe("https://stripe.test/pay");
    expect(mockFindCustomersByContact).not.toHaveBeenCalled();
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.frequency).toBe("onetime");
    expect(written.totalAmountCents).toBe(11299);
  });

  it("the owner can still put anyone on a recurring plan by hand", async () => {
    const result = await adminCaller().createBooking({
      firstName: "Brand",
      lastName: "New",
      phone: "5125550101",
      serviceType: "residential",
      frequency: "biweekly",
      sqft: 1200,
      locale: "en",
      sendEmail: false,
    });
    expect(result.reference).toMatch(/^GFC-/);
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.frequency).toBe("biweekly");
    expect(mockFindCustomersByContact).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The pages.
// ---------------------------------------------------------------------------

describe("the public pages", () => {
  const pricing = source("../client/src/pages/Pricing.tsx");
  const quote = source("../client/src/pages/Quote.tsx");
  const booking = source("../client/src/pages/Booking.tsx");

  it("the pricing page shows one-time prices only, no toggle, and the note", () => {
    expect(pricing).toContain("const frequency: Frequency = DEFAULT_PUBLIC_FREQUENCY;");
    expect(pricing).not.toContain("setFrequency");
    expect(pricing).not.toContain("Discount}");
    expect(pricing).toContain('data-testid="recurring-unlock-note"');
    expect(pricing).toContain("RECURRING_UNLOCK_NOTE[locale]");
    expect(pricing).toContain("publicTierPrice(tier.price, frequency, pricing)");
  });

  it("the quote wizard has no frequency step and never shows a discount", () => {
    expect(quote).toContain('const frequency: Frequency = "onetime";');
    expect(quote).toContain("const stepTitles = [t.quote.steps.type, t.quote.steps.details, t.quote.steps.extras, t.quote.steps.result];");
    expect(quote).not.toContain('key="frequency"');
    expect(quote).not.toContain("frequencyBadges");
    expect(quote).not.toContain("t.quote.savings");
    expect(quote).toContain("RECURRING_UNLOCK_NOTE[locale]");
    // The handoff no longer carries a plan the customer could not have chosen.
    expect(quote).not.toMatch(/^\s+frequency,\n/m);
  });

  it("the booking form prices one-time until the contact is recognised, then offers the plans", () => {
    expect(booking).toContain("trpc.booking.returningCustomer.useQuery(");
    expect(booking).toContain("enabled: step >= 4 &&");
    expect(booking).toContain('const effectiveFrequency: Frequency = returning ? frequency : "onetime";');
    expect(booking).toContain("quote: { type, bedrooms, bathrooms, sqft, extras, frequency: effectiveFrequency },");
    expect(booking).toContain("frequency: effectiveFrequency }");
    // The old step-0 chips are gone; the note stands where they were.
    expect(booking).not.toContain("{/* Frequency inline */}");
    expect(booking.split('data-testid="recurring-unlock-note"').length - 1).toBe(2);
    // The plan chooser exists only inside the returning branch of the review step.
    expect(booking).toContain("{returning ? (");
    expect(booking).toContain('data-testid="recurring-plans"');
    expect(booking).toContain("aria-pressed={frequency === f}");
    // The URL default the hotfix pinned still stands.
    expect(booking).toContain('(q as Frequency) : "onetime"');
  });

  it("the copy exists in both languages", () => {
    const en = source("../client/src/i18n/translations/en.ts");
    const es = source("../client/src/i18n/translations/es.ts");
    expect(en).toContain('recurringWelcome: "Welcome back!');
    expect(es).toContain('recurringWelcome: "¡Bienvenido de nuevo!');
    expect(en).toContain("recurring plans with savings unlock after your first cleaning");
    expect(es).toContain("se desbloquean después de su primera limpieza");
  });
});
