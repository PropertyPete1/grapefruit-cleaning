/**
 * Itemized balance invoices: the review screen picks add-ons from the live
 * catalog and names one-off charges; the invoice stores the snapshot; the
 * email and the Stripe checkout itemize; and no amount ever travels unnamed.
 *
 * This file is also the scripted half of the adversarial sweep — scenarios
 * 5 through 11 and 16/17 from the review checklist run here as tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetSetting = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();
const mockTipRequest = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  getInvoiceById: (...args: unknown[]) => mockGetInvoiceById(...args),
  updateInvoice: (...args: unknown[]) => mockUpdateInvoice(...args),
  updateBooking: vi.fn(),
  createPayment: vi.fn(),
  listInvoices: vi.fn().mockResolvedValue([]),
  listInvoicesAwaitingApproval: vi.fn().mockResolvedValue([]),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionCreate(...args) } },
  }),
}));

vi.mock("./tip", () => ({
  sendTipRequestEmailSafely: (...args: unknown[]) => mockTipRequest(...args),
  TIP_PAYMENT_TYPE: "tip",
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import {
  baseAmountOf,
  isValidLineItem,
  lineItemsTotal,
  parseLineItems,
  serializeLineItems,
} from "@shared/invoiceItems";
import { DEFAULT_PRICING } from "@shared/pricing";
import { approveBalanceInvoice, buildStripeLineItems, resendBalanceLink, resolveLineItems } from "./balance";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";

const ORIGIN = "https://grapefruitclean.com";

const BOOKING = {
  id: 42,
  reference: "GFC-ITM42",
  customerId: 7,
  serviceType: "residential" as const,
  frequency: "onetime" as const,
  scheduledDate: "2026-08-01",
  scheduledTime: "09:00",
  locale: "en" as const,
  status: "completed" as const,
  totalAmount: 250,
  depositAmount: 50,
  addressLine: "123 Main St",
  unitNumber: null,
  city: "San Antonio",
  zip: "78201",
  extras: "[]",
  couponCode: null,
  stripePaymentIntentId: "pi_deposit_1",
};

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  preferredLocale: "en",
};

const PENDING = {
  id: 501,
  number: "INV-ITM-01",
  bookingId: 42,
  customerId: 7,
  amount: 200,
  computedAmount: 200,
  kind: "balance" as const,
  status: "awaiting_approval" as const,
  payToken: null as string | null,
  stripeSessionId: null as string | null,
  stripePaymentIntentId: null as string | null,
  paidVia: null as "stripe" | "manual" | null,
  refundNeeded: false,
  lineItems: null as string | null,
  linkExpiresAt: null as Date | null,
  linkSentAt: null as Date | null,
  dueDate: null as string | null,
  paidAt: null as Date | null,
  approvedAt: null as Date | null,
  approvedByUserId: null as number | null,
  reminderCount: 0,
  lastReminderAt: null as Date | null,
  reminderExhaustedAlertAt: null as Date | null,
  createdAt: new Date(),
};

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

/** The single merged patch updateInvoice applied. */
const invoicePatch = () =>
  Object.assign({}, ...mockUpdateInvoice.mock.calls.map(c => c[1] as Record<string, unknown>));

/** Stripe line items of the last minted session, as {name, dollars}. */
const mintedLines = () => {
  const args = mockSessionCreate.mock.calls.at(-1)![0] as {
    line_items: { price_data: { unit_amount: number; product_data: { name: string } } }[];
  };
  return args.line_items.map(line => ({
    name: line.price_data.product_data.name,
    dollars: line.price_data.unit_amount / 100,
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetSetting.mockResolvedValue(null);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetInvoiceById.mockResolvedValue({ ...PENDING });
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockSessionCreate.mockResolvedValue({ id: "cs_itm_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockTipRequest.mockResolvedValue(undefined);
});

describe("the line-item primitives", () => {
  it("requires a non-empty name on every item — the point of the feature", () => {
    expect(isValidLineItem({ kind: "custom", name: "", amount: 30 })).toBe(false);
    expect(isValidLineItem({ kind: "custom", name: "   ", amount: 30 })).toBe(false);
    expect(isValidLineItem({ kind: "custom", name: "Carpet spot", amount: 30 })).toBe(true);
    expect(isValidLineItem({ kind: "addon", id: "laundry", name: "Laundry", amount: 30 })).toBe(true);
    expect(isValidLineItem({ kind: "addon", id: "notReal", name: "X", amount: 30 })).toBe(false);
  });

  it("rejects zero, negative, fractional and absurd amounts", () => {
    for (const amount of [0, -5, 12.5, 25001]) {
      expect(isValidLineItem({ kind: "custom", name: "X", amount })).toBe(false);
    }
  });

  it("round-trips through storage and survives garbage", () => {
    const items = [
      { kind: "addon" as const, id: "laundry" as const, name: "Laundry & folding", amount: 30 },
      { kind: "custom" as const, name: "Fridge deep clean", amount: 45 },
    ];
    expect(parseLineItems(serializeLineItems(items))).toEqual(items);
    expect(serializeLineItems([])).toBeNull();
    expect(parseLineItems(null)).toEqual([]);
    expect(parseLineItems("not json")).toEqual([]);
    expect(parseLineItems('{"a":1}')).toEqual([]);
    // Malformed entries drop; well-formed neighbours survive.
    expect(parseLineItems(JSON.stringify([items[0], { kind: "custom", name: "", amount: 5 }]))).toEqual([
      items[0],
    ]);
  });

  it("base + items always reassembles the invoice amount", () => {
    const items = [
      { kind: "custom" as const, name: "A", amount: 30 },
      { kind: "custom" as const, name: "B", amount: 45 },
    ];
    expect(lineItemsTotal(items)).toBe(75);
    expect(baseAmountOf(275, items)).toBe(200);
    expect(baseAmountOf(50, items)).toBe(0); // corrupt row → never negative
  });
});

describe("scenario 5 — approve with 2 add-ons + 1 custom item", () => {
  const APPROVAL = {
    invoiceId: 501,
    approvedByUserId: 1,
    origin: ORIGIN,
    addonIds: ["laundry", "oven"] as ("laundry" | "oven")[],
    customItems: [{ name: "Garage sweep-out", amount: 45 }],
  };
  const laundry = Math.max(1, Math.round(DEFAULT_PRICING.extras.laundry));
  const oven = Math.max(1, Math.round(DEFAULT_PRICING.extras.oven));
  const expectedTotal = 200 + laundry + oven + 45;

  it("bills base + catalog prices + custom, and stores the snapshot", async () => {
    const result = await approveBalanceInvoice(APPROVAL);
    expect(result).toMatchObject({ outcome: "approved", amount: expectedTotal });
    const patch = invoicePatch();
    expect(patch.amount).toBe(expectedTotal);
    const stored = parseLineItems(patch.lineItems as string);
    expect(stored).toEqual([
      { kind: "addon", id: "laundry", name: "Laundry & folding", amount: laundry },
      { kind: "addon", id: "oven", name: "Inside oven", amount: oven },
      { kind: "custom", name: "Garage sweep-out", amount: 45 },
    ]);
  });

  it("the Stripe session itemizes and sums exactly to the invoice amount", async () => {
    await approveBalanceInvoice(APPROVAL);
    const lines = mintedLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ name: "Remaining balance — Residential Cleaning", dollars: 200 });
    expect(lines.map(l => l.name)).toEqual([
      "Remaining balance — Residential Cleaning",
      "Laundry & folding",
      "Inside oven",
      "Garage sweep-out",
    ]);
    expect(lines.reduce((sum, l) => sum + l.dollars, 0)).toBe(expectedTotal);
  });

  it("the email itemizes every charge by name before the totals", async () => {
    await approveBalanceInvoice(APPROVAL);
    const body = (mockSendMail.mock.calls[0]![0] as { text?: string; to: string }).text ?? "";
    expect(body).toContain(`Service: $200 USD`);
    expect(body).toContain(`Laundry & folding: $${laundry} USD`);
    expect(body).toContain(`Inside oven: $${oven} USD`);
    expect(body).toContain(`Garage sweep-out: $45 USD`);
    expect(body).toContain(`Remaining balance due: $${expectedTotal} USD`);
  });

  it("a plain approval stays un-itemized — the pre-feature shape", async () => {
    await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });
    expect(invoicePatch().lineItems).toBeNull();
    expect(mintedLines()).toHaveLength(1);
    const body = (mockSendMail.mock.calls[0]![0] as { text?: string }).text ?? "";
    expect(body).not.toContain("Service: $");
  });
});

describe("scenarios 6 & 7 — custom item validation at the API edge", () => {
  it("rejects an empty or whitespace name", async () => {
    for (const name of ["", "   "]) {
      await expect(
        adminCaller().approveBalanceInvoice({
          invoiceId: 501,
          customItems: [{ name, amount: 30 }],
        })
      ).rejects.toThrow(/needs a name/i);
    }
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });

  it("rejects $0, negative, fractional, and absurd amounts", async () => {
    for (const amount of [0, -20, 12.5]) {
      await expect(
        adminCaller().approveBalanceInvoice({
          invoiceId: 501,
          customItems: [{ name: "Thing", amount }],
        })
      ).rejects.toThrow();
    }
    await expect(
      adminCaller().approveBalanceInvoice({
        invoiceId: 501,
        customItems: [{ name: "Thing", amount: 999999 }],
      })
    ).rejects.toThrow(/tops out/i);
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });
});

describe("scenario 8 — adjust base down and add add-ons in one approval", () => {
  it("the math composes: adjusted base + items", async () => {
    const laundry = Math.max(1, Math.round(DEFAULT_PRICING.extras.laundry));
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      adjustedAmount: 150,
      addonIds: ["laundry"],
    });
    expect(result).toMatchObject({ outcome: "approved", amount: 150 + laundry });
    const lines = mintedLines();
    expect(lines[0]!.dollars).toBe(150);
    expect(lines.reduce((sum, l) => sum + l.dollars, 0)).toBe(150 + laundry);
  });
});

describe("scenario 9 — zero-total settles without a session", () => {
  it("settles, fires the tip ask, mints nothing", async () => {
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      adjustedAmount: 0,
    });
    expect(result).toMatchObject({ outcome: "settled_without_link" });
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockTipRequest).toHaveBeenCalledWith(42, ORIGIN);
    expect(invoicePatch()).toMatchObject({ status: "paid", amount: 0, lineItems: null });
  });

  it("but zero base PLUS items still bills the items", async () => {
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      adjustedAmount: 0,
      customItems: [{ name: "Key drop-off trip", amount: 15 }],
    });
    expect(result).toMatchObject({ outcome: "approved", amount: 15 });
    const lines = mintedLines();
    // No zero-dollar base line — the items ARE the invoice.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ name: "Key drop-off trip", dollars: 15 });
  });
});

describe("scenario 10 — resend uses the stored snapshot", () => {
  it("re-bills exactly what was approved, whatever the catalog says now", async () => {
    const snapshot = serializeLineItems([
      { kind: "addon", id: "laundry", name: "Laundry & folding", amount: 30 },
      { kind: "custom", name: "Garage sweep-out", amount: 45 },
    ]);
    // The catalog has since TRIPLED laundry — the snapshot must not care.
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "pricing_config"
        ? JSON.stringify({ ...DEFAULT_PRICING, extras: { ...DEFAULT_PRICING.extras, laundry: 90 } })
        : null
    );
    mockGetInvoiceById.mockResolvedValue({
      ...PENDING,
      status: "sent",
      amount: 275,
      lineItems: snapshot,
      payToken: "tok123",
    });
    const result = await resendBalanceLink(501, ORIGIN);
    expect(result.outcome).toBe("resent");
    const lines = mintedLines();
    expect(lines).toEqual([
      { name: "Remaining balance — Residential Cleaning", dollars: 200 },
      { name: "Laundry & folding", dollars: 30 },
      { name: "Garage sweep-out", dollars: 45 },
    ]);
    const body = (mockSendMail.mock.calls[0]![0] as { text?: string }).text ?? "";
    expect(body).toContain("Laundry & folding: $30 USD");
    expect(body).not.toContain("$90");
  });
});

describe("scenario 11 — double approval is refused", () => {
  it("a second approve of the same invoice neither re-bills nor re-emails", async () => {
    await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });
    const sessionsAfterFirst = mockSessionCreate.mock.calls.length;
    const mailsAfterFirst = mockSendMail.mock.calls.length;
    // The row is now "sent" — as the DB would return it.
    mockGetInvoiceById.mockResolvedValue({ ...PENDING, status: "sent", amount: 200 });
    const second = await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });
    expect(second).toMatchObject({ outcome: "not_awaiting_approval", status: "sent" });
    expect(mockSessionCreate.mock.calls.length).toBe(sessionsAfterFirst);
    expect(mockSendMail.mock.calls.length).toBe(mailsAfterFirst);
  });
});

describe("scenario 16 — Spanish email with add-ons", () => {
  it("labels add-ons from the ES dictionary, custom names verbatim", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      addonIds: ["laundry"],
      customItems: [{ name: "Garage sweep-out", amount: 45 }],
    });
    const body = (mockSendMail.mock.calls[0]![0] as { text?: string }).text ?? "";
    expect(body).toContain("Lavandería y doblado:");
    expect(body).toContain("Servicio: $200 USD");
    expect(body).toContain("Garage sweep-out: $45 USD");
    expect(body).not.toContain("Laundry & folding");
    // The Stripe line labels localize too.
    expect(mintedLines().map(l => l.name)).toContain("Lavandería y doblado");
  });
});

describe("scenario 17 — SMTP failure during approval", () => {
  it("keeps the invoice consistent, reports emailed:false, and resend recovers", async () => {
    mockSendMail.mockRejectedValue(new Error("535 Authentication failed"));
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      addonIds: ["laundry"],
    });
    // The approval itself lands — amount, snapshot, link — the EMAIL failed.
    expect(result).toMatchObject({ outcome: "approved", emailed: false });
    expect(invoicePatch()).toMatchObject({ status: "sent" });
    expect(parseLineItems(invoicePatch().lineItems as string)).toHaveLength(1);

    // The admin retries via resend once the mailbox is fixed.
    mockSendMail.mockResolvedValue({ messageId: "2" });
    mockGetInvoiceById.mockResolvedValue({
      ...PENDING,
      status: "sent",
      amount: invoicePatch().amount as number,
      lineItems: invoicePatch().lineItems as string,
      payToken: "tok123",
    });
    const resent = await resendBalanceLink(501, ORIGIN);
    expect(resent).toMatchObject({ outcome: "resent", emailed: true });
  });
});

describe("resolveLineItems snapshots the live catalog", () => {
  it("prices add-ons from the config of the moment", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "pricing_config"
        ? JSON.stringify({ ...DEFAULT_PRICING, extras: { ...DEFAULT_PRICING.extras, oven: 55 } })
        : null
    );
    const items = await resolveLineItems(["oven"], []);
    expect(items).toEqual([{ kind: "addon", id: "oven", name: "Inside oven", amount: 55 }]);
  });

  it("buildStripeLineItems always sums to the amount, by construction", () => {
    const items = [
      { kind: "custom" as const, name: "A", amount: 30 },
      { kind: "custom" as const, name: "B", amount: 45 },
    ];
    const lines = buildStripeLineItems({
      amount: 275,
      items,
      serviceName: "Residential Cleaning",
      locale: "en",
      description: "x",
    });
    expect(lines.reduce((sum, l) => sum + (l.price_data!.unit_amount ?? 0), 0)).toBe(27500);
  });
});
