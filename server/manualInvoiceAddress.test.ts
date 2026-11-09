/**
 * Manual invoice — optional service address.
 *
 * A manual invoice has no booking, so until now it had no address anywhere:
 * the opened row said "No property linked", the customer's email had no
 * Address line and the pay page named only the service. The owner can now
 * enter where the work was done when raising one. This file pins:
 *   - the address is three nullable columns on the invoice, added by an
 *     additive migration, written by issueManualInvoice and accepted by the
 *     admin router (city or ZIP alone is refused — the street identifies the
 *     property);
 *   - it shows on the row's property panel, in the customer's email, on the
 *     Stripe line and on the cash-choice page — and a resend reads it back
 *     from the stored row;
 *   - it is optional: without one, every surface reads exactly as before;
 *   - a balance invoice never reads these columns — its address is its
 *     booking's, whatever the invoice row happens to hold;
 *   - the dialog prefills the address from the picked customer's record and
 *     sends it trimmed, or not at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockGetSetting = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getBookingById: vi.fn().mockResolvedValue(undefined),
  getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
  createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
  updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
  recordEmailAttemptReturningId: vi.fn().mockResolvedValue(1),
  listInvoices: vi.fn().mockResolvedValue([]),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a), expire: vi.fn() } },
  }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: vi.fn().mockResolvedValue(true) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { serviceReference } from "@shared/invoiceReference";
import type { Booking } from "../drizzle/schema";
import {
  createBalanceCheckoutSession,
  invoiceFacts,
  issueManualInvoice,
  manualServiceAddress,
  resendBalanceLink,
  toInvoiceEmailData,
} from "./balance";
import { renderCashChoicePage } from "./balanceRoutes";
import { __resetTransporter } from "./emails";
import { SERVICE_NAMES } from "./names";
import { adminRouter } from "./routers/admin";
import { describeInvoiceContext } from "../client/src/pages/admin/invoiceContext";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const SENT_AT = new Date("2026-09-28T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PAY_URL = `${ORIGIN}/api/pay/balance/tok_manual`;

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  preferredLocale: "en" as const,
  address: "15 Oak St",
  city: "San Antonio",
  zip: "78209",
};

/** The job happened somewhere other than Ana's own address — a rental she manages. */
const WORK_SITE = { serviceAddress: "2208 Schriber Rd", serviceCity: "San Antonio", serviceZip: "78204" };
const WORK_SITE_LINE = "2208 Schriber Rd, San Antonio, 78204";

/** A manual invoice as it exists once issued: token, snapshot, no booking. */
const manualRow = (overrides: Record<string, unknown> = {}) => ({
  id: 900,
  number: "INV-MANUAL01",
  bookingId: null,
  customerId: 7,
  amount: 145,
  amountCents: 14500,
  kind: "manual" as const,
  status: "sent" as const,
  payToken: "tok_manual",
  stripeSessionId: "cs_manual",
  stripePaymentIntentId: null as string | null,
  paidVia: null as "stripe" | "manual" | null,
  paymentPreference: null,
  refundNeeded: false,
  lineItems: null,
  serviceType: "deep",
  serviceDate: "2026-09-28",
  serviceAddress: null as string | null,
  serviceCity: null as string | null,
  serviceZip: null as string | null,
  linkSentAt: SENT_AT,
  linkExpiresAt: new Date(SENT_AT.getTime() + 7 * DAY),
  dueDate: "2026-10-05",
  reminderCount: 0,
  lastReminderAt: null,
  reminderExhaustedAlertAt: null,
  createdAt: SENT_AT,
  ...overrides,
});

/** The completed booking behind a balance invoice, at ITS address. */
const BOOKING = {
  id: 41,
  reference: "GFC-WH33YS",
  customerId: 7,
  status: "completed",
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: "2026-09-02",
  scheduledTime: "09:00",
  locale: "en",
  addressLine: "800 Congress Ave",
  unitNumber: null,
  city: "Austin",
  zip: "78701",
  totalAmount: 113,
  totalAmountCents: 11299,
  depositAmount: 23,
  depositAmountCents: 2300,
  stripePaymentIntentId: "pi_1",
  paymentPreference: null,
  notes: null,
  extras: "[]",
} as unknown as Booking;

const DEEP_REF = serviceReference(SERVICE_NAMES.deep.en, "2026-09-28", "en");

const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });
const stripeDescription = () =>
  (mockSessionCreate.mock.calls.at(-1)![0] as { line_items: { price_data: { product_data: { description: string } } }[] })
    .line_items[0]!.price_data.product_data.description;

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetSetting.mockResolvedValue(null);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetInvoiceById.mockResolvedValue(manualRow());
  mockCreateInvoice.mockResolvedValue(900);
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockSessionCreate.mockResolvedValue({ id: "cs_manual", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issuing a manual invoice with a service address", () => {
  it("stores the three columns, emails the Address line, and names the place on the Stripe line", async () => {
    const result = await issueManualInvoice({
      customerId: 7,
      amount: 145,
      serviceType: "deep",
      serviceDate: "2026-09-28",
      ...WORK_SITE,
      origin: ORIGIN,
      now: SENT_AT,
    });
    expect(result.outcome).toBe("issued");
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ kind: "manual", ...WORK_SITE }));

    const [email] = sentEmails();
    expect(email.to).toBe("ana@example.com");
    expect(email.text).toContain(`Address: ${WORK_SITE_LINE}`);
    // The customer's own address is NOT the service address, and does not appear.
    expect(email.text).not.toContain("15 Oak St");

    expect(stripeDescription()).toBe(`${DEEP_REF} · ${WORK_SITE_LINE}`);
  });

  it("without one, nothing changes: null columns, no Address line, the reference alone on the Stripe line", async () => {
    await issueManualInvoice({
      customerId: 7,
      amount: 145,
      serviceType: "deep",
      serviceDate: "2026-09-28",
      origin: ORIGIN,
      now: SENT_AT,
    });
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAddress: null, serviceCity: null, serviceZip: null })
    );
    expect(sentEmails()[0].text).not.toMatch(/^Address:/m);
    expect(stripeDescription()).toBe(DEEP_REF);
  });

  it("a resend reads the address back off the stored row", async () => {
    mockGetInvoiceById.mockResolvedValue(manualRow(WORK_SITE));
    const result = await resendBalanceLink(900, ORIGIN);
    expect(result.outcome).toBe("resent");
    expect(sentEmails()[0].text).toContain(`Address: ${WORK_SITE_LINE}`);
    expect(stripeDescription()).toBe(`${DEEP_REF} · ${WORK_SITE_LINE}`);
  });

  it("composes the one-line address from whatever parts were entered", () => {
    expect(manualServiceAddress(WORK_SITE)).toBe(WORK_SITE_LINE);
    expect(manualServiceAddress({ serviceAddress: "2208 Schriber Rd" })).toBe("2208 Schriber Rd");
    expect(manualServiceAddress({ serviceAddress: "2208 Schriber Rd", serviceZip: "78204" })).toBe("2208 Schriber Rd, 78204");
    expect(manualServiceAddress({})).toBeNull();
    expect(manualServiceAddress({ serviceAddress: "  ", serviceCity: null })).toBeNull();
  });
});

describe("the pay page", () => {
  it("the cash-choice page shows the address under the bill's name, from the same facts the email uses", () => {
    const data = toInvoiceEmailData(undefined, CUSTOMER as never, invoiceFacts(manualRow(WORK_SITE)), PAY_URL, new Date(SENT_AT.getTime() + 7 * DAY));
    expect(data.address).toBe(WORK_SITE_LINE);
    const html = renderCashChoicePage("en", data, "ask", `${PAY_URL}/cash`);
    expect(html).toContain(DEEP_REF);
    expect(html).toContain(WORK_SITE_LINE);
    expect(html).toContain("Pay with cash?");
  });

  it("and shows nothing extra when none was entered", () => {
    const data = toInvoiceEmailData(undefined, CUSTOMER as never, invoiceFacts(manualRow()), PAY_URL, new Date());
    expect(data.address).toBeUndefined();
    const html = renderCashChoicePage("en", data, "ask", `${PAY_URL}/cash`);
    expect(html).toContain(DEEP_REF);
    expect(html).not.toContain("Schriber");
    expect(html).not.toContain("Oak St");
  });
});

describe("a balance invoice keeps reading its booking", () => {
  const balanceRow = manualRow({
    id: 7,
    number: "INV-BAL01",
    bookingId: 41,
    kind: "balance",
    serviceType: "residential",
    serviceDate: "2026-09-02",
    amount: 90,
    amountCents: 8999,
    // Garbage in the manual-only columns, to prove nothing reads them here.
    serviceAddress: "999 Wrong St",
    serviceCity: "Nowhere",
    serviceZip: "00000",
  });

  it("the email and the cash page carry the booking's address, never the invoice columns", () => {
    const data = toInvoiceEmailData(BOOKING, CUSTOMER as never, invoiceFacts(balanceRow), PAY_URL, new Date());
    expect(data.address).toBe("800 Congress Ave, Austin, 78701");
    expect(renderCashChoicePage("en", data, "ask", `${PAY_URL}/cash`)).not.toContain("Wrong St");
  });

  it("the Stripe line keeps naming the booking", async () => {
    await createBalanceCheckoutSession({
      invoice: { ...invoiceFacts(balanceRow), id: 7, payToken: "tok_bal" },
      booking: BOOKING,
      customerEmail: "ana@example.com",
      origin: ORIGIN,
    });
    const residentialRef = serviceReference(SERVICE_NAMES.residential.en, "2026-09-02", "en");
    expect(stripeDescription()).toBe(`${residentialRef} · Booking GFC-WH33YS`);
  });

  it("the opened row for a balance invoice whose booking is gone shows no property, whatever the columns hold", () => {
    const view = describeInvoiceContext({
      kind: "balance",
      booking: null,
      customer: CUSTOMER,
      serviceAddress: "999 Wrong St",
      serviceCity: "Nowhere",
      serviceZip: "00000",
    });
    expect(view.kind).toBe("no_booking");
    if (view.kind !== "no_booking") return;
    expect(view.heading).toBe("Booking no longer available");
    expect(view.tone).toBe("warning");
    expect(view.property).toBeUndefined();
  });
});

describe("the opened row", () => {
  it("shows the service address as the property of a manual invoice", () => {
    const view = describeInvoiceContext({ kind: "manual", booking: null, customer: CUSTOMER, ...WORK_SITE });
    expect(view.kind).toBe("no_booking");
    if (view.kind !== "no_booking") return;
    expect(view.heading).toBe("Manual invoice");
    expect(view.tone).toBe("note");
    expect(view.property).toEqual([{ label: "Service address", value: WORK_SITE_LINE }]);
    // The customer on file keeps their own address — the two can differ.
    expect(view.customer.find(row => row.label === "Address")?.value).toBe("15 Oak St, San Antonio, 78209");
  });

  it("still says no property is linked when none was entered", () => {
    const view = describeInvoiceContext({ kind: "manual", booking: null, customer: CUSTOMER });
    if (view.kind !== "no_booking") throw new Error("expected the no-booking view");
    expect(view.heading).toBe("No property linked to this invoice");
    expect(view.tone).toBe("warning");
    expect(view.property).toBeUndefined();
    expect(view.explanation).toContain("no service address was entered");
  });

  it("the panel lays the property section out when the view carries one", () => {
    const panel = read("../client/src/pages/admin/InvoiceContextPanel.tsx");
    expect(panel).toContain('{view.property && <Section title="Property" rows={view.property} />}');
    expect(panel).toContain('view.tone === "warning"');
  });
});

describe("admin.createInvoice", () => {
  it("accepts the address, trimmed, and hands it to the invoice", async () => {
    const result = await adminCaller().createInvoice({
      customerId: 7,
      amount: 145,
      serviceType: "deep",
      serviceDate: "2026-09-28",
      serviceAddress: "  2208 Schriber Rd ",
      serviceCity: " San Antonio",
      serviceZip: "78204 ",
    });
    expect(result.emailed).toBe(true);
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining(WORK_SITE));
  });

  it("refuses a city or ZIP without a street — the street is what identifies the property", async () => {
    await expect(adminCaller().createInvoice({ customerId: 7, amount: 145, serviceCity: "San Antonio" })).rejects.toThrow(
      /street/i
    );
    await expect(adminCaller().createInvoice({ customerId: 7, amount: 145, serviceZip: "78204" })).rejects.toThrow(/street/i);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it("still issues a bare invoice with no address at all", async () => {
    const result = await adminCaller().createInvoice({ customerId: 7, amount: 145 });
    expect(result.emailed).toBe(true);
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ serviceAddress: null, serviceCity: null, serviceZip: null })
    );
  });
});

describe("the storage", () => {
  it("adds nullable columns in an additive migration — nothing dropped, nothing changed", () => {
    const migration = read("../drizzle/0036_invoice_address_custom_price.sql");
    for (const column of ["serviceAddress", "serviceCity", "serviceZip"]) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE \`invoices\` ADD \`${column}\` varchar\\(\\d+\\);`));
    }
    for (const column of ["customPriceCents", "customPriceReason", "customPriceByUserId", "customPriceAt"]) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE \`bookings\` ADD \`${column}\` `));
    }
    expect(migration).not.toMatch(/DROP|MODIFY|CHANGE|NOT NULL|DELETE|UPDATE/);
    const journal = read("../drizzle/meta/_journal.json");
    expect(journal).toContain("0036_invoice_address_custom_price");
  });

  it("the schema declares the invoice columns nullable", () => {
    const schema = read("../drizzle/schema.ts");
    expect(schema).toMatch(/serviceAddress: varchar\("serviceAddress", \{ length: 255 \}\),/);
    expect(schema).toMatch(/serviceCity: varchar\("serviceCity", \{ length: 100 \}\),/);
    expect(schema).toMatch(/serviceZip: varchar\("serviceZip", \{ length: 20 \}\),/);
  });
});

describe("the Create invoice dialog", () => {
  const source = read("../client/src/pages/admin/AdminInvoices.tsx");

  it("has the three fields, prefilled from the picked customer's record", () => {
    expect(source).toContain('id="inv-service-address"');
    expect(source).toContain('id="inv-service-city"');
    expect(source).toContain('id="inv-service-zip"');
    expect(source).toContain('serviceAddress: picked?.address ?? ""');
    expect(source).toContain('serviceCity: picked?.city ?? ""');
    expect(source).toContain('serviceZip: picked?.zip ?? ""');
  });

  it("sends each part trimmed, or not at all", () => {
    expect(source).toContain("serviceAddress: form.serviceAddress.trim() || undefined");
    expect(source).toContain("serviceCity: form.serviceCity.trim() || undefined");
    expect(source).toContain("serviceZip: form.serviceZip.trim() || undefined");
  });

  it("holds the send button while a city or ZIP has no street, and says why", () => {
    expect(source).toContain("!serviceAddressValid || create.isPending");
    expect(source).toContain("Enter the street too, or clear the city and ZIP.");
  });
});
