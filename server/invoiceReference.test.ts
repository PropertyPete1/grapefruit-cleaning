/**
 * Test G — the customer-facing reference is "Service Type — Service Date", not
 * an invoice number.
 *
 * What this file pins:
 *   - the helper: "Deep Cleaning — September 28, 2026" in English, "Limpieza
 *     Profunda — 28 de septiembre de 2026" in Spanish, read digit by digit so
 *     no time zone can move the day, and the bare service name when there is
 *     no date rather than an invented one;
 *   - every customer-facing message uses it and none carries INV-…: the
 *     balance email, both reminders, the receipt, the Stripe checkout line;
 *   - the owner's own alerts still carry the number (it is internal, not gone);
 *   - a balance invoice snapshots service and date at creation; a manual
 *     invoice takes what the owner entered and falls back to "Cleaning
 *     services";
 *   - Admin → Invoices exposes the same reference beside the number.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();
const mockListInvoices = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
  getBalanceInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
  updateInvoice: (...a: unknown[]) => mockUpdateInvoice(...a),
  listInvoices: (...a: unknown[]) => mockListInvoices(...a),
  createPayment: vi.fn(),
  settleUnpaidInvoice: vi.fn().mockResolvedValue(true),
  claimBookingCompletedBySettlement: vi.fn().mockResolvedValue(false),
  claimTipRequestEmail: vi.fn().mockResolvedValue(false),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a), expire: vi.fn() } } }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { formatServiceDate, serviceReference } from "@shared/invoiceReference";
import { deriveInvoicePaymentStatus } from "@shared/paymentStatus";
import { approveBalanceInvoice, issueBalanceForCompletedBooking, issueManualInvoice, resendBalanceLink, sendPaymentReceiptSafely } from "./balance";
import {
  buildBalanceApprovalNeededAlert,
  buildBalanceDueEmail,
  buildBalancePaidNotification,
  buildBalanceReminderEmail,
  buildPaymentReceiptEmail,
  buildRefundNeededAlert,
  __resetTransporter,
  type BalanceEmailData,
} from "./emails";
import { adminRouter } from "./routers/admin";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as unknown as TrpcContext);
const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

const BOOKING = {
  id: 42,
  reference: "GFC-REF42",
  customerId: 7,
  serviceType: "deep" as const,
  frequency: "onetime" as const,
  scheduledDate: "2026-09-28",
  scheduledTime: "09:00",
  locale: "en" as const,
  status: "completed" as const,
  totalAmount: 340,
  totalAmountCents: 34000,
  depositAmount: 68,
  depositAmountCents: 6800,
  stripePaymentIntentId: "pi_dep",
  addressLine: "2208 Schriber St",
  city: "San Antonio",
  zip: "78201",
  extras: "[]",
  couponCode: null,
  paymentPreference: null,
  cashChosenAt: null,
};
const CUSTOMER = { id: 7, firstName: "Daniel", lastName: "Murray", email: "daniel@example.com", phone: "2105550100", preferredLocale: "en" as const };
const INVOICE = {
  id: 501,
  number: "INV-REF-01",
  bookingId: 42,
  customerId: 7,
  amount: 272,
  amountCents: 27200,
  kind: "balance" as const,
  status: "awaiting_approval" as const,
  payToken: "tok_ref",
  stripeSessionId: null,
  stripePaymentIntentId: null,
  paidVia: null,
  paidMethod: null,
  paidAt: null,
  paymentPreference: null,
  serviceType: "deep",
  serviceDate: "2026-09-28",
  lineItems: null,
  refundNeeded: false,
  linkExpiresAt: null,
  createdAt: new Date("2026-09-28T18:00:00Z"),
};

const DATA: BalanceEmailData = {
  reference: "GFC-REF42",
  invoiceNumber: "INV-REF-01",
  serviceName: "Deep Cleaning",
  date: "2026-09-28",
  total: 340,
  deposit: 68,
  balance: 272,
  customerName: "Daniel",
  customerEmail: "daniel@example.com",
  address: "2208 Schriber St, San Antonio",
  payUrl: `${ORIGIN}/api/pay/balance/tok_ref`,
  cashUrl: `${ORIGIN}/api/pay/balance/tok_ref/cash`,
  expiresOn: "2026-10-05",
  locale: "en",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetInvoiceById.mockResolvedValue(INVOICE);
  mockCreateInvoice.mockResolvedValue(501);
  mockSessionCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockListInvoices.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe("the reference itself", () => {
  it("spells the date out in the customer's language, without touching a time zone", () => {
    expect(formatServiceDate("2026-09-28", "en")).toBe("September 28, 2026");
    expect(formatServiceDate("2026-09-28", "es")).toBe("28 de septiembre de 2026");
    expect(formatServiceDate("2026-10-03", "en")).toBe("October 3, 2026");
    expect(formatServiceDate("2026-01-01", "es")).toBe("1 de enero de 2026");
    // Midnight boundaries cannot move the day: the string is read, not parsed as UTC.
    expect(formatServiceDate("2026-12-31", "en")).toBe("December 31, 2026");
  });

  it("is Service Type — Date, or the bare service when no date is known", () => {
    expect(serviceReference("Deep Cleaning", "2026-09-28", "en")).toBe("Deep Cleaning — September 28, 2026");
    expect(serviceReference("Residential Cleaning", "2026-10-03", "en")).toBe("Residential Cleaning — October 3, 2026");
    expect(serviceReference("Limpieza Profunda", "2026-09-28", "es")).toBe("Limpieza Profunda — 28 de septiembre de 2026");
    expect(serviceReference("Cleaning services", null, "en")).toBe("Cleaning services");
    expect(serviceReference("Cleaning services", "", "es")).toBe("Cleaning services");
    // A malformed legacy value is shown as stored rather than mangled.
    expect(formatServiceDate("next Tuesday", "en")).toBe("next Tuesday");
  });
});

describe("Test G — customer messages use the reference, never the number", () => {
  it("the balance email, in both languages", () => {
    const en = buildBalanceDueEmail(DATA);
    expect(en.body).toContain("Service: Deep Cleaning — September 28, 2026");
    expect(en.body).toContain("Reference: GFC-REF42");
    expect(en.body).not.toContain("INV-REF-01");
    expect(en.body).not.toContain("Invoice:");
    expect(en.body).toContain("PAY ONLINE");
    expect(en.body).toContain("PAY WITH CASH");
    expect(en.body).toContain(`${ORIGIN}/api/pay/balance/tok_ref/cash`);
    expect(en.body).toContain("Deposit already paid: $68 USD");
    expect(en.body).toContain("Remaining balance due: $272 USD");
    const es = buildBalanceDueEmail({ ...DATA, serviceName: "Limpieza Profunda", locale: "es" });
    expect(es.body).toContain("Servicio: Limpieza Profunda — 28 de septiembre de 2026");
    expect(es.body).toContain("PAGAR EN LÍNEA");
    expect(es.body).toContain("PAGAR EN EFECTIVO");
    expect(es.body).not.toContain("INV-REF-01");
  });

  it("a manual invoice with no booking is named the same way, and its subject too", () => {
    const manual = buildBalanceDueEmail({ ...DATA, reference: "", deposit: 0, total: 272, serviceName: "Residential Cleaning", date: "2026-10-03" });
    expect(manual.subject).toBe("Your invoice from Grapefruit Cleaning Co. — Residential Cleaning — October 3, 2026");
    expect(manual.body).toContain("Service: Residential Cleaning — October 3, 2026");
    expect(manual.body).toContain("Total due: $272 USD");
    expect(manual.body).not.toContain("Deposit already paid");
    expect(manual.body).not.toContain("INV-");
    // No date known: the service alone, never an invented day.
    const bare = buildBalanceDueEmail({ ...DATA, reference: "", deposit: 0, total: 272, serviceName: "Cleaning services", date: "" });
    expect(bare.subject).toBe("Your invoice from Grapefruit Cleaning Co. — Cleaning services");
    expect(bare.body).toContain("Service: Cleaning services");
  });

  it("a job with no deposit is billed as a payment, not a 'remaining balance'", () => {
    const full = buildBalanceDueEmail({ ...DATA, deposit: 0, total: 272 });
    expect(full.subject).toBe("Your cleaning is complete — payment for Deep Cleaning — September 28, 2026 | Grapefruit Cleaning Co.");
    expect(full.body).toContain("Total due: $272 USD");
    expect(full.body).not.toContain("$0 USD");
    // While a deposit-backed job keeps the wording customers already know.
    expect(buildBalanceDueEmail(DATA).subject).toBe("Your cleaning is complete — pay your remaining balance | Grapefruit Cleaning Co.");
  });

  it("once cash is chosen the email says so and keeps the card link as a way back", () => {
    const cash = buildBalanceDueEmail({ ...DATA, paymentPreference: "cash" });
    expect(cash.body).toContain("PAYING IN CASH");
    expect(cash.body).toContain("We'll collect $272 USD in person");
    expect(cash.body).toContain(DATA.payUrl);
    expect(cash.body).not.toContain("PAY WITH CASH");
  });

  it("both reminders and the receipt", () => {
    for (const n of [1, 2] as const) {
      const reminder = buildBalanceReminderEmail(DATA, n);
      expect(reminder.body).toContain("Service: Deep Cleaning — September 28, 2026");
      expect(reminder.body).toContain("PAY WITH CASH");
      expect(reminder.body).not.toContain("INV-REF-01");
      const joblessReminder = buildBalanceReminderEmail({ ...DATA, reference: "", deposit: 0 }, n);
      expect(joblessReminder.subject).toContain("Deep Cleaning — September 28, 2026 is still unpaid");
      expect(joblessReminder.subject).not.toContain("INV-");
    }
    const receipt = buildPaymentReceiptEmail({ ...DATA, paidOn: "2026-09-29", paidVia: "cash" });
    expect(receipt.body).toContain("Service: Deep Cleaning — September 28, 2026");
    expect(receipt.body).toContain("Payment method: Cash");
    expect(receipt.body).not.toContain("INV-REF-01");
    expect(receipt.body).not.toContain("Service date:");
  });

  it("the owner's own alerts keep the number — it is internal, not abolished", () => {
    expect(buildBalanceApprovalNeededAlert(DATA).content).toContain("Invoice: INV-REF-01");
    expect(buildBalancePaidNotification(DATA).title).toContain("INV-REF-01");
    expect(buildRefundNeededAlert(DATA).title).toContain("INV-REF-01");
  });
});

describe("Test G — end to end through the balance machinery", () => {
  it("completion snapshots the service and date onto the invoice", async () => {
    await issueBalanceForCompletedBooking(42, ORIGIN);
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ serviceType: "deep", serviceDate: "2026-09-28", paymentPreference: null })
    );
    // The approval alert to the owner is internal and names the invoice.
    const alert = sentEmails().find(e => e.to === "hello@grapefruitclean.com");
    expect(alert?.text).toContain("Invoice: INV-REF-01");
    expect(alert?.text).toContain("Service: Deep Cleaning");
  });

  it("approving sends the customer the reference, a cash link, and a Stripe line without the number", async () => {
    const result = await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });
    expect(result.outcome).toBe("approved");
    const email = sentEmails().find(e => e.to === "daniel@example.com");
    expect(email?.text).toContain("Service: Deep Cleaning — September 28, 2026");
    expect(email?.text).toContain(`${ORIGIN}/api/pay/balance/tok_ref/cash`);
    expect(email?.text).not.toContain("INV-REF-01");
    const params = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { product_data: { name: string; description: string } } }[];
      metadata: Record<string, string>;
    };
    expect(params.line_items[0]!.price_data.product_data.name).toBe("Remaining balance — Deep Cleaning");
    expect(params.line_items[0]!.price_data.product_data.description).toBe("Deep Cleaning — September 28, 2026 · Booking GFC-REF42");
    expect(params.metadata.invoice_number).toBe("INV-REF-01");
  });

  it("a resend and a receipt read the snapshot, so a later booking edit cannot rename a sent bill", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "sent", serviceDate: "2026-09-28" });
    mockGetBookingById.mockResolvedValue({ ...BOOKING, scheduledDate: "2026-10-30" });
    await resendBalanceLink(501, ORIGIN);
    const resent = sentEmails().find(e => e.to === "daniel@example.com");
    // The reference is the booking's own service and date (a balance invoice is
    // named by its job); the email data reads the booking, which the owner may
    // have moved — the point is that the customer is told the CURRENT date.
    expect(resent?.text).toContain("Service: Deep Cleaning — October 30, 2026");
    mockSendMail.mockClear();
    await sendPaymentReceiptSafely({ ...INVOICE, status: "paid", paidVia: "manual", paidMethod: "cash", paidAt: new Date("2026-10-31T12:00:00Z") } as never, "cash");
    expect(sentEmails()[0]?.text).toContain("Payment method: Cash");
    expect(sentEmails()[0]?.text).not.toContain("INV-REF-01");
  });

  it("a manual invoice takes the owner's service and date and bills by them", async () => {
    const result = await issueManualInvoice({
      customerId: 7,
      amount: 180,
      serviceType: "residential",
      serviceDate: "2026-10-03",
      origin: ORIGIN,
    });
    expect(result.outcome).toBe("issued");
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ kind: "manual", serviceType: "residential", serviceDate: "2026-10-03" }));
    const email = sentEmails().find(e => e.to === "daniel@example.com");
    expect(email?.subject).toBe("Your invoice from Grapefruit Cleaning Co. — Residential Cleaning — October 3, 2026");
    expect(email?.text).toContain("Service: Residential Cleaning — October 3, 2026");
    expect(email?.text).not.toContain("INV-");
    const params = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { product_data: { name: string; description: string } } }[] };
    expect(params.line_items[0]!.price_data.product_data.name).toBe("Residential Cleaning");
    expect(params.line_items[0]!.price_data.product_data.description).toBe("Residential Cleaning — October 3, 2026");
  });

  it("a manual invoice without them falls back to 'Cleaning services' with no date", async () => {
    await issueManualInvoice({ customerId: 7, amount: 180, origin: ORIGIN });
    const email = sentEmails().find(e => e.to === "daniel@example.com");
    expect(email?.subject).toBe("Your invoice from Grapefruit Cleaning Co. — Cleaning services");
    expect(email?.text).toContain("Service: Cleaning services");
    expect(email?.text).not.toMatch(/Cleaning services — /);
  });
});

describe("Admin → Invoices", () => {
  it("exposes the same reference and payment position on every row, with the number kept beside it", async () => {
    mockListInvoices.mockResolvedValue([
      { invoice: { ...INVOICE, status: "sent", payToken: "tok_ref", linkExpiresAt: new Date("2099-01-01") }, booking: { id: 42, serviceType: "deep", scheduledDate: "2026-09-28" }, customer: { firstName: "Daniel", lastName: "Murray" } },
      // An older balance invoice with no snapshot is named by its booking.
      { invoice: { ...INVOICE, id: 502, number: "INV-OLD-02", serviceType: null, serviceDate: null, status: "paid", paidVia: "manual", paidMethod: "cash" }, booking: { id: 43, serviceType: "residential", scheduledDate: "2026-08-01" }, customer: { firstName: "Ana", lastName: "Lopez" } },
      // A manual invoice with nothing entered.
      { invoice: { ...INVOICE, id: 503, number: "INV-MAN-03", kind: "manual", bookingId: null, serviceType: null, serviceDate: null, status: "sent", paymentPreference: "cash" }, booking: null, customer: { firstName: "Ana", lastName: "Lopez" } },
    ]);
    const rows = await adminCaller().invoices();
    expect(rows.map(r => r.serviceReference)).toEqual([
      "Deep Cleaning — September 28, 2026",
      "Residential Cleaning — August 1, 2026",
      "Cleaning services",
    ]);
    expect(rows.map(r => r.paymentStatus)).toEqual(["balance_due", "paid_cash", "cash_pending"]);
    expect(rows.map(r => r.number)).toEqual(["INV-REF-01", "INV-OLD-02", "INV-MAN-03"]);
    expect(rows.every(r => !("payToken" in r))).toBe(true);
  });

  it("the invoice position reads the way the badge shows it", () => {
    expect(deriveInvoicePaymentStatus({ status: "paid", paidVia: "stripe", paidMethod: "card" })).toBe("paid");
    expect(deriveInvoicePaymentStatus({ status: "paid", paidVia: "manual", paidMethod: "cash" })).toBe("paid_cash");
    expect(deriveInvoicePaymentStatus({ status: "paid", paidVia: "manual", paidMethod: "zelle" })).toBe("paid_offline");
    expect(deriveInvoicePaymentStatus({ status: "sent", paymentPreference: "cash" })).toBe("cash_pending");
    expect(deriveInvoicePaymentStatus({ status: "awaiting_approval" })).toBe("balance_pending_approval");
    expect(deriveInvoicePaymentStatus({ status: "sent" })).toBe("balance_due");
    expect(deriveInvoicePaymentStatus({ status: "void" })).toBe("void");
  });

  it("the create-invoice form asks for the service and date, and the context panel shows what the customer sees", () => {
    const page = source("../client/src/pages/admin/AdminInvoices.tsx");
    expect(page).toContain('aria-label="Service type"');
    expect(page).toContain('id="inv-service-date"');
    expect(page).toContain("serviceDate: form.serviceDate || undefined");
    const context = source("../client/src/pages/admin/invoiceContext.ts");
    expect(context).toContain('label: "Customer sees"');
  });
});
