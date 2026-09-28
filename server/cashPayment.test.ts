/**
 * Test F — cash payment: complete the cleaning → Paid in Cash → the invoice is
 * paid and the method is cash.
 *
 * What this file pins:
 *   - the one tap settles the completed job's balance invoice through the
 *     existing offline settlement (one system, two doors): method cash, the
 *     invoice's exact amount, the recording admin, today's business date;
 *   - a completed job with no invoice yet gets one issued quietly and settled
 *     in the same tap — the owner never learns an invoice was missing;
 *   - guards: not completed, already paid, voided, nothing due, a tip already
 *     on file;
 *   - after the money: the open Checkout is closed, the receipt says Cash, the
 *     tip ask goes out, and the position reads Paid in Cash;
 *   - the admin procedure maps every outcome to a plain message;
 *   - the customer's PAY WITH CASH tap on the balance email: the choice page,
 *     the recorded preference, one owner alert, the "already paid" notice;
 *   - the admin UI has the button where the spec puts it (source pins).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetBalanceInvoice = vi.fn();
const mockCreateInvoice = vi.fn();
const mockRecordOffline = vi.fn();
const mockSessionExpire = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();
const mockClaimTip = vi.fn();
const mockGetInvoiceByPayToken = vi.fn();
const mockClaimCashPreference = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getInvoiceById: (...a: unknown[]) => mockGetInvoiceById(...a),
  getBalanceInvoiceForBooking: (...a: unknown[]) => mockGetBalanceInvoice(...a),
  createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
  updateInvoice: vi.fn().mockResolvedValue(undefined),
  recordOfflineInvoicePayment: (...a: unknown[]) => mockRecordOffline(...a),
  claimBookingCompletedBySettlement: vi.fn().mockResolvedValue(false),
  claimTipRequestEmail: (...a: unknown[]) => mockClaimTip(...a),
  getConnectedPropertyById: vi.fn().mockResolvedValue(undefined),
  getInvoiceByPayToken: (...a: unknown[]) => mockGetInvoiceByPayToken(...a),
  claimInvoiceCashPreference: (...a: unknown[]) => mockClaimCashPreference(...a),
  listBookings: vi.fn().mockResolvedValue([]),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "cs_x", url: "https://stripe.test/x" }),
        expire: (...a: unknown[]) => mockSessionExpire(...a),
      },
    },
  }),
}));

vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a) }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { canMarkPaidInCash, derivePaymentStatus } from "@shared/paymentStatus";
import { _resetRateLimits } from "./antiSpam";
import { registerBalanceRoutes } from "./balanceRoutes";
import { payBookingInCash } from "./cashPayment";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 9, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as unknown as TrpcContext);

const sentEmails = () => mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

const BOOKING = {
  id: 42,
  reference: "GFC-CASH42",
  customerId: 7,
  kind: "self_serve",
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
  stripePaymentIntentId: "pi_deposit_1",
  addressLine: "2208 Schriber St",
  city: "San Antonio",
  zip: "78201",
  extras: "[]",
  couponCode: null,
  tipToken: null,
  tipEmailSentAt: null,
  paymentPreference: null,
  cashChosenAt: null,
};

const CUSTOMER = { id: 7, firstName: "Daniel", lastName: "Murray", email: "daniel@example.com", phone: "2105550100", preferredLocale: "en" as const };

const INVOICE = {
  id: 501,
  number: "INV-CASH-01",
  bookingId: 42,
  customerId: 7,
  amount: 272,
  amountCents: 27200,
  kind: "balance" as const,
  status: "sent" as const,
  payToken: "tok_cash",
  stripeSessionId: "cs_open_1",
  stripePaymentIntentId: null,
  paidVia: null,
  paidMethod: null,
  paidAt: null,
  paymentPreference: null,
  serviceType: "deep",
  serviceDate: "2026-09-28",
  lineItems: null,
  refundNeeded: false,
  linkExpiresAt: new Date("2099-01-01T00:00:00Z"),
};

const recorded = (invoice: typeof INVOICE, tipPaymentId: number | null = null) => ({
  outcome: "recorded" as const,
  invoice: { ...invoice, status: "paid" as const, paidVia: "manual" as const, paidMethod: "cash" },
  paymentId: 71,
  tipPaymentId,
  bookingCompleted: false,
  paidAt: new Date("2026-09-28T12:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetInvoiceById.mockResolvedValue(INVOICE);
  mockGetBalanceInvoice.mockResolvedValue(INVOICE);
  mockCreateInvoice.mockResolvedValue(777);
  mockRecordOffline.mockResolvedValue(recorded(INVOICE));
  mockSessionExpire.mockResolvedValue({});
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockClaimTip.mockResolvedValue(true);
  mockNotifyOwner.mockResolvedValue(undefined);
  mockGetInvoiceByPayToken.mockResolvedValue(INVOICE);
  mockClaimCashPreference.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// Test F — the one tap.
// ---------------------------------------------------------------------------

describe("Test F — Paid in Cash on a completed booking", () => {
  it("settles the balance invoice through the offline path: cash, the exact amount, today, the admin", async () => {
    const result = await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(result).toMatchObject({ outcome: "paid", invoiceId: 501, invoiceNumber: "INV-CASH-01", amount: 272, amountCents: 27200, tipAmount: 0, paymentId: 71, receiptSent: true });
    expect(mockRecordOffline).toHaveBeenCalledTimes(1);
    expect(mockRecordOffline).toHaveBeenCalledWith({
      invoiceId: 501,
      amountCents: 27200,
      method: "cash",
      tipAmountCents: 0,
      note: undefined,
      receivedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      recordedByUserId: 9,
      // A captured deposit came first, so this money is the balance of it.
      paymentKind: "balance",
    });
    // Nothing else was created or issued: the invoice already existed.
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it("closes the open Checkout, emails a receipt that says Cash, and sends the tip ask", async () => {
    await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(mockSessionExpire).toHaveBeenCalledWith("cs_open_1");
    const receipt = sentEmails().find(e => e.subject.includes("Payment received"));
    expect(receipt).toBeDefined();
    expect(receipt!.to).toBe("daniel@example.com");
    expect(receipt!.text).toContain("Payment method: Cash");
    expect(receipt!.text).toContain("Amount paid: $272 USD");
    expect(receipt!.text).toContain("Deep Cleaning — September 28, 2026");
    expect(receipt!.text).not.toContain("INV-CASH-01");
    expect(mockClaimTip).toHaveBeenCalledWith(42, expect.any(String));
  });

  it("a tip received with the cash rides along, and the tip ask is then not sent", async () => {
    mockRecordOffline.mockResolvedValue(recorded(INVOICE, 72));
    const result = await payBookingInCash({ bookingId: 42, tipAmount: 20, receivedOn: "2026-09-27", note: "Left on the counter", emailReceipt: false, recordedByUserId: 9, origin: ORIGIN });
    expect(result).toMatchObject({ outcome: "paid", tipAmount: 20, receiptSent: false });
    expect(mockRecordOffline).toHaveBeenCalledWith(
      expect.objectContaining({ tipAmountCents: 2000, receivedOn: "2026-09-27", note: "Left on the counter" })
    );
    expect(sentEmails()).toEqual([]);
    expect(mockClaimTip).not.toHaveBeenCalled();
  });

  it("a finished job that was never invoiced gets its balance issued quietly and settled in the same tap", async () => {
    mockGetBalanceInvoice.mockResolvedValue(undefined);
    const issued = { ...INVOICE, id: 777, number: "INV-NEW-77", status: "awaiting_approval" as const, stripeSessionId: null };
    mockGetInvoiceById.mockResolvedValue(issued);
    mockRecordOffline.mockResolvedValue(recorded(issued));
    const result = await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(result).toMatchObject({ outcome: "paid", invoiceId: 777, amount: 272 });
    // Issued at the computed balance (340 − 68 captured deposit), snapshotting the service name and date.
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, amount: 272, amountCents: 27200, status: "awaiting_approval", serviceType: "deep", serviceDate: "2026-09-28" })
    );
    // Quietly: the owner is the one tapping, so no "approve this balance" alert.
    expect(mockNotifyOwner).not.toHaveBeenCalled();
    expect(sentEmails().some(e => e.subject.includes("Approve balance"))).toBe(false);
    expect(mockRecordOffline).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 777, amountCents: 27200, method: "cash" }));
  });

  it("an Airbnb or cash booking with no deposit captured is booked as one full payment", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, serviceType: "airbnb", depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null, totalAmount: 272, totalAmountCents: 27200 });
    await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(mockRecordOffline).toHaveBeenCalledWith(expect.objectContaining({ paymentKind: "full" }));
  });

  it("refuses a job that is not completed, before touching any money", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "confirmed" });
    const result = await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(result).toEqual({ outcome: "not_completed", status: "confirmed" });
    expect(mockRecordOffline).not.toHaveBeenCalled();
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it("never double-settles: a paid or voided invoice is reported, not recorded again", async () => {
    mockGetBalanceInvoice.mockResolvedValue({ ...INVOICE, status: "paid", paidVia: "manual", paidMethod: "cash" });
    expect(await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN })).toEqual({ outcome: "already_settled", invoiceId: 501, status: "paid", paidMethod: "cash" });
    mockGetBalanceInvoice.mockResolvedValue({ ...INVOICE, status: "void" });
    expect(await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN })).toMatchObject({ outcome: "already_settled", status: "void" });
    // Losing the claim inside the transaction reports the same way.
    mockGetBalanceInvoice.mockResolvedValue(INVOICE);
    mockRecordOffline.mockResolvedValue({ outcome: "already_settled", status: "paid" });
    expect(await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN })).toMatchObject({ outcome: "already_settled" });
    expect(mockSessionExpire).not.toHaveBeenCalled();
    expect(sentEmails()).toEqual([]);
  });

  it("a job the deposit already covered has nothing to collect", async () => {
    mockGetBalanceInvoice.mockResolvedValue(undefined);
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 68, totalAmountCents: 6800 });
    const result = await payBookingInCash({ bookingId: 42, recordedByUserId: 9, origin: ORIGIN });
    expect(result).toEqual({ outcome: "nothing_due", invoiceId: 777 });
    expect(mockRecordOffline).not.toHaveBeenCalled();
  });

  it("a tip already on file is refused rather than recorded twice", async () => {
    mockRecordOffline.mockResolvedValue({ outcome: "tip_already_recorded" });
    expect(await payBookingInCash({ bookingId: 42, tipAmount: 10, recordedByUserId: 9, origin: ORIGIN })).toEqual({ outcome: "tip_already_recorded", invoiceId: 501 });
  });

  it("afterwards the booking reads Paid in Cash, and the button is only offered where it applies", () => {
    expect(derivePaymentStatus({ status: "completed", depositAmount: 68, depositAmountCents: 6800, stripePaymentIntentId: "pi_1", invoice: { status: "paid", paidVia: "manual", paidMethod: "cash" } })).toBe("paid_cash");
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "unpaid" })).toBe(true);
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "balance_due" })).toBe(true);
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "balance_pending_approval" })).toBe(true);
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "cash_pending" })).toBe(true);
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "paid_cash" })).toBe(false);
    expect(canMarkPaidInCash({ status: "completed", paymentStatus: "paid" })).toBe(false);
    expect(canMarkPaidInCash({ status: "in_progress", paymentStatus: "unpaid" })).toBe(false);
    expect(canMarkPaidInCash({ status: "cancelled", paymentStatus: "released" })).toBe(false);
  });
});

describe("admin.markPaidInCash", () => {
  it("records and reports the amount", async () => {
    const result = await adminCaller().markPaidInCash({ bookingId: 42 });
    expect(result).toMatchObject({ success: true, nothingDue: false, amount: 272, tipAmount: 0, invoiceNumber: "INV-CASH-01", receiptSent: true });
    expect(mockRecordOffline).toHaveBeenCalledWith(expect.objectContaining({ recordedByUserId: 9, method: "cash", amountCents: 27200 }));
  });

  it("explains each refusal in plain words", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "in_progress" });
    await expect(adminCaller().markPaidInCash({ bookingId: 42 })).rejects.toThrow(/Mark the cleaning completed first/);
    mockGetBookingById.mockResolvedValue(BOOKING);
    mockGetBalanceInvoice.mockResolvedValue({ ...INVOICE, status: "paid", paidVia: "manual", paidMethod: "cash" });
    await expect(adminCaller().markPaidInCash({ bookingId: 42 })).rejects.toThrow(/already paid in cash/);
    mockGetBookingById.mockResolvedValue(undefined);
    await expect(adminCaller().markPaidInCash({ bookingId: 42 })).rejects.toThrow(/Booking not found/);
  });

  it("a covered job succeeds with nothing due instead of erroring", async () => {
    mockGetBalanceInvoice.mockResolvedValue(undefined);
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 68, totalAmountCents: 6800 });
    expect(await adminCaller().markPaidInCash({ bookingId: 42 })).toMatchObject({ success: true, nothingDue: true, amount: 0 });
  });

  it("Record offline payment on the invoice page shares the same after-steps and books the kind the same way", async () => {
    const result = await adminCaller().recordOfflinePayment({ invoiceId: 501, amount: 272, method: "cash", tipAmount: 0, receivedOn: "2026-09-28", emailReceipt: true });
    expect(result).toMatchObject({ success: true, paymentId: 71 });
    expect(mockRecordOffline).toHaveBeenCalledWith(expect.objectContaining({ paymentKind: "balance", method: "cash" }));
    expect(mockSessionExpire).toHaveBeenCalledWith("cs_open_1");
    expect(sentEmails().some(e => e.subject.includes("Payment received"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The customer's PAY WITH CASH tap on the balance email.
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => Promise<unknown>;

function captureRoutes(): Record<string, Handler> {
  const routes: Record<string, Handler> = {};
  const capture = (method: string) => (path: string, ...rest: unknown[]) => {
    routes[`${method} ${path}`] = rest[rest.length - 1] as Handler;
  };
  registerBalanceRoutes({ get: capture("GET"), post: capture("POST") } as never);
  return routes;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: "" as string,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(payload: string) {
      res.body = payload;
      return res;
    },
    redirect() {
      return res;
    },
  };
  return res;
}

const request = (method: "GET" | "POST", token = "tok_cash") =>
  ({ method, params: { token }, query: {}, headers: { host: "grapeclean.example", "x-forwarded-proto": "https" }, protocol: "https", socket: { remoteAddress: "1.1.1.1" } }) as unknown as Request;

describe("PAY WITH CASH on the balance email", () => {
  it("the cash link sits under the card link in the balance email, and the routes exist", () => {
    const routes = captureRoutes();
    expect(Object.keys(routes)).toEqual([
      "GET /api/pay/balance/:token/cash",
      "POST /api/pay/balance/:token/cash",
      "GET /api/pay/balance/:token",
    ]);
  });

  it("GET shows the bill by its service reference and asks — nothing is recorded by a visit", async () => {
    const res = fakeRes();
    await captureRoutes()["GET /api/pay/balance/:token/cash"]!(request("GET"), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Pay with cash?");
    expect(res.body).toContain("Deep Cleaning — September 28, 2026");
    expect(res.body).toContain("$272 USD");
    expect(res.body).toContain('method="post"');
    expect(res.body).toContain("Yes, I&#39;ll pay in cash".replace("&#39;", "'"));
    expect(res.body).toContain("Pay online instead");
    expect(res.body).not.toContain("INV-CASH-01");
    expect(mockClaimCashPreference).not.toHaveBeenCalled();
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("POST records the choice once and tells the owner once", async () => {
    const routes = captureRoutes();
    const res = fakeRes();
    await routes["POST /api/pay/balance/:token/cash"]!(request("POST"), res as unknown as Response);
    expect(mockClaimCashPreference).toHaveBeenCalledWith(501);
    expect(res.body).toContain("Got it — cash it is");
    expect(res.body).toContain("Pay by card instead");
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Cash payment chosen — $272 USD for Deep Cleaning — September 28, 2026 (booking GFC-CASH42)") })
    );
    const alert = sentEmails().find(e => e.to === "hello@grapefruitclean.com");
    expect(alert?.text).toContain("Automatic card reminders are paused");
    expect(alert?.text).toContain("Invoice: INV-CASH-01");
    // A second tap (or a reload of the confirmation) loses the claim: same page, no second alert.
    mockClaimCashPreference.mockResolvedValue(false);
    const again = fakeRes();
    await routes["POST /api/pay/balance/:token/cash"]!(request("POST"), again as unknown as Response);
    expect(again.body).toContain("Got it — cash it is");
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a customer who already chose cash sees they are set, in their language", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, paymentPreference: "cash" });
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    const res = fakeRes();
    await captureRoutes()["GET /api/pay/balance/:token/cash"]!(request("GET"), res as unknown as Response);
    expect(res.body).toContain("Pagará en efectivo");
    expect(res.body).toContain("Limpieza Profunda — 28 de septiembre de 2026");
    expect(res.body).not.toContain('method="post"');
  });

  it("a paid invoice shows the paid notice and an unknown token 404s — no preference is written", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, status: "paid", paidVia: "stripe" });
    const paid = fakeRes();
    await captureRoutes()["POST /api/pay/balance/:token/cash"]!(request("POST"), paid as unknown as Response);
    expect(paid.body).toContain("Payment received");
    mockGetInvoiceByPayToken.mockResolvedValue(undefined);
    const missing = fakeRes();
    await captureRoutes()["GET /api/pay/balance/:token/cash"]!(request("GET", "nope"), missing as unknown as Response);
    expect(missing.statusCode).toBe(404);
    expect(mockClaimCashPreference).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Where the button lives.
// ---------------------------------------------------------------------------

describe("the admin UI puts Paid in Cash on the completed booking", () => {
  it("BookingDetails and Appointments open the one dialog, which calls the one mutation", () => {
    const details = source("../client/src/pages/admin/BookingDetails.tsx");
    expect(details).toContain("canMarkPaidInCash(row)");
    expect(details).toContain('data-testid="paid-in-cash-button"');
    expect(details).toContain("<PaidInCashDialog");
    const appointments = source("../client/src/pages/admin/AdminAppointments.tsx");
    expect(appointments).toContain("canMarkPaidInCash(b)");
    expect(appointments).toContain("<PaidInCashDialog");
    const dialog = source("../client/src/pages/admin/PaidInCashDialog.tsx");
    expect(dialog).toContain("trpc.admin.markPaidInCash.useMutation");
    expect(dialog).toContain("Email receipt to customer");
    // The amount is never typed: the server settles the invoice's own figure.
    expect(dialog).not.toContain('id="cash-amount"');
  });

  it("the invoices page names each bill the way the customer sees it and shows Paid in Cash / Cash pending", () => {
    const invoices = source("../client/src/pages/admin/AdminInvoices.tsx");
    expect(invoices).toContain("inv.serviceReference");
    expect(invoices).toContain("<InvoicePaymentBadge status={inv.paymentStatus} />");
    expect(invoices).toContain('id="inv-service-date"');
  });
});
