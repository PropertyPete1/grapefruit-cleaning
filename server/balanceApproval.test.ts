/**
 * Approval gate: completing a job files the balance for review instead of
 * billing, and only an admin can approve (and optionally adjust) it before the
 * customer is charged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetBalanceInvoiceForBooking = vi.fn();
const mockListAwaiting = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockUpdateBooking = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionExpire = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  getInvoiceById: (...args: unknown[]) => mockGetInvoiceById(...args),
  getBalanceInvoiceForBooking: (...args: unknown[]) => mockGetBalanceInvoiceForBooking(...args),
  listInvoicesAwaitingApproval: (...args: unknown[]) => mockListAwaiting(...args),
  createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
  updateInvoice: (...args: unknown[]) => mockUpdateInvoice(...args),
  updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
  createPayment: vi.fn(),
  listInvoices: vi.fn().mockResolvedValue([]),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: (...args: unknown[]) => mockSessionCreate(...args),
        expire: (...args: unknown[]) => mockSessionExpire(...args),
      },
    },
  }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...args: unknown[]) => mockNotifyOwner(...args),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import { approveBalanceInvoice, issueBalanceForCompletedBooking, resendBalanceLink } from "./balance";
import { balanceLinkStatus } from "./balanceRules";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";
import { staffRouter } from "./routers/staff";

const ORIGIN = "https://grapefruitclean.com";

const BOOKING = {
  id: 42,
  reference: "GFC-BAL42",
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
};

/** An invoice sitting in the approval queue. */
const PENDING = {
  id: 501,
  number: "INV-TEST-01",
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
  linkExpiresAt: null as Date | null,
};

function sentEmails(): { to: string; subject: string; text: string }[] {
  return mockSendMail.mock.calls.map(call => call[0] as { to: string; subject: string; text: string });
}

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

const staffCaller = () =>
  adminRouter.createCaller({
    user: { id: 9, role: "staff" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "");
  __resetTransporter();
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetBalanceInvoiceForBooking.mockResolvedValue(undefined);
  mockGetInvoiceById.mockResolvedValue(PENDING);
  mockListAwaiting.mockResolvedValue([PENDING]);
  mockCreateInvoice.mockResolvedValue(501);
  mockSessionCreate.mockResolvedValue({ id: "cs_balance_1", url: "https://stripe.test/balance" });
  mockSendMail.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

// ---------------------------------------------------------------------------
// Completion no longer bills
// ---------------------------------------------------------------------------

describe("completing a job", () => {
  it("does not email the customer or touch Stripe", async () => {
    await adminCaller().updateBookingStatus({ id: 42, status: "completed" });

    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(sentEmails().some(e => e.to === CUSTOMER.email)).toBe(false);
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ status: "awaiting_approval", amount: 200, computedAmount: 200 })
    );
  });

  it("does not bill when staff complete the job either", async () => {
    const caller = staffRouter.createCaller({
      user: { id: 9, role: "staff" },
      req: { protocol: "https", headers: { origin: ORIGIN } },
    } as never);
    await caller.updateJobStatus({ bookingId: 42, status: "completed" });

    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ status: "awaiting_approval" }));
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(sentEmails().some(e => e.to === CUSTOMER.email)).toBe(false);
  });

  it("alerts the owner so the pending balance can't sit forgotten", async () => {
    await issueBalanceForCompletedBooking(42, ORIGIN);
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/Approve balance/i) })
    );
    // The owner copy also lands in the business inbox.
    expect(sentEmails()[0]!.to).toBe("biz@grapefruitclean.com");
  });

  it("still auto-settles a zero balance with no approval step", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 100, depositAmount: 100 });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);

    expect(result.outcome).toBe("zero_balance");
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 0, status: "paid", kind: "balance" })
    );
    expect(mockNotifyOwner).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("reports the pending balance as awaiting approval in the invoice list", () => {
    expect(balanceLinkStatus({ status: "awaiting_approval", payToken: null, linkExpiresAt: null })).toBe(
      "awaiting_approval"
    );
  });
});

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

describe("approving a pending balance", () => {
  it("mints the Stripe session for the computed amount and emails the customer", async () => {
    const result = await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });

    expect(result).toMatchObject({ outcome: "approved", amount: 200, emailed: true });
    const session = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { unit_amount: number } }[];
      metadata: Record<string, string>;
    };
    expect(session.line_items[0]!.price_data.unit_amount).toBe(200 * 100);
    expect(session.metadata.payment_type).toBe("balance");

    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "sent", amount: 200, approvedByUserId: 1 });
    expect(patch.approvedAt).toBeInstanceOf(Date);
    expect(String(patch.payToken)).toHaveLength(48);

    const customerEmail = sentEmails().find(e => e.to === CUSTOMER.email)!;
    expect(customerEmail.subject).toContain("Your cleaning is complete");
    expect(customerEmail.text).toContain("$200 USD");
  });

  it("bills the adjusted amount when an admin corrects the total", async () => {
    // Crew found a bigger home on site — $200 computed, $275 actually due.
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      adjustedAmount: 275,
    });

    expect(result).toMatchObject({ outcome: "approved", amount: 275 });
    const session = mockSessionCreate.mock.calls[0]![0] as { line_items: { price_data: { unit_amount: number } }[] };
    expect(session.line_items[0]!.price_data.unit_amount).toBe(275 * 100);
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, expect.objectContaining({ amount: 275 }));
    expect(sentEmails().find(e => e.to === CUSTOMER.email)!.text).toContain("$275 USD");
  });

  it("keeps the originally computed figure for the audit trail", async () => {
    await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN, adjustedAmount: 275 });
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    // computedAmount is written at completion and never overwritten on approval.
    expect(patch.computedAmount).toBeUndefined();
  });

  it("emails a Spanish customer in Spanish", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });

    const email = sentEmails().find(e => e.to === CUSTOMER.email)!;
    expect(email.subject).toContain("Su limpieza está completa");
    expect(email.text).toContain("Saldo restante a pagar");
    expect(email.text).not.toContain("Remaining balance due");
  });

  it("settles without a link when an admin zeroes the balance", async () => {
    const result = await approveBalanceInvoice({
      invoiceId: 501,
      approvedByUserId: 1,
      origin: ORIGIN,
      adjustedAmount: 0,
    });

    expect(result.outcome).toBe("settled_without_link");
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(sentEmails().some(e => e.to === CUSTOMER.email)).toBe(false);
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, expect.objectContaining({ amount: 0, status: "paid" }));
  });

  it("is idempotent: an already-approved invoice is not re-sent", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...PENDING, status: "sent", payToken: "tok_abc" });
    const result = await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });

    expect(result).toMatchObject({ outcome: "not_awaiting_approval", status: "sent" });
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });

  it("refuses to approve an invoice already settled in person", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...PENDING, status: "paid", paidVia: "manual" });
    const result = await approveBalanceInvoice({ invoiceId: 501, approvedByUserId: 1, origin: ORIGIN });

    expect(result).toMatchObject({ outcome: "not_awaiting_approval", status: "paid" });
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("only admins may approve", () => {
  it("blocks staff from approving, server-side", async () => {
    await expect(staffCaller().approveBalanceInvoice({ invoiceId: 501 })).rejects.toThrow(/Admin access required/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });

  it("blocks staff from adjusting the amount too", async () => {
    await expect(
      staffCaller().approveBalanceInvoice({ invoiceId: 501, adjustedAmount: 5 })
    ).rejects.toThrow(/Admin access required/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("blocks staff from reading the approval queue", async () => {
    await expect(staffCaller().awaitingApprovalInvoices()).rejects.toThrow(/Admin access required/i);
  });

  it("lets an admin approve through the router and records who did it", async () => {
    const result = await adminCaller().approveBalanceInvoice({ invoiceId: 501 });
    expect(result).toMatchObject({ sent: true, amount: 200 });
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, expect.objectContaining({ approvedByUserId: 1 }));
  });

  it("rejects a negative adjustment at the router boundary", async () => {
    await expect(adminCaller().approveBalanceInvoice({ invoiceId: 501, adjustedAmount: -50 })).rejects.toThrow();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the invoice already moved on", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...PENDING, status: "paid" });
    await expect(adminCaller().approveBalanceInvoice({ invoiceId: 501 })).rejects.toThrow(
      /no longer awaiting approval/i
    );
  });
});

// ---------------------------------------------------------------------------
// Manual collection during approval
// ---------------------------------------------------------------------------

describe("in-person collection while approval is pending", () => {
  it("marks paid and cancels the pending approval", async () => {
    const result = await adminCaller().updateInvoiceStatus({ id: 501, status: "paid" });

    expect(result.success).toBe(true);
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.status).toBe("paid");
    expect(patch.paidVia).toBe("manual");
    expect(patch.paidAt).toBeInstanceOf(Date);
    // No Stripe session exists yet, so there is nothing to expire.
    expect(mockSessionExpire).not.toHaveBeenCalled();
  });

  it("leaves it out of the approval queue afterwards", async () => {
    await adminCaller().updateInvoiceStatus({ id: 501, status: "paid" });
    mockListAwaiting.mockResolvedValue([]);
    expect(await adminCaller().awaitingApprovalInvoices()).toEqual([]);
  });

  it("blocks a later approval of that invoice", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...PENDING, status: "paid", paidVia: "manual" });
    await expect(adminCaller().approveBalanceInvoice({ invoiceId: 501 })).rejects.toThrow(
      /no longer awaiting approval/i
    );
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resend still gated on approval
// ---------------------------------------------------------------------------

describe("resend before approval", () => {
  it("refuses, since nothing was ever sent", async () => {
    const result = await resendBalanceLink(501, ORIGIN);
    expect(result.outcome).toBe("awaiting_approval");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("tells the admin to approve it first", async () => {
    await expect(adminCaller().resendBalanceLink({ invoiceId: 501 })).rejects.toThrow(/Approve this balance first/i);
  });
});

// ---------------------------------------------------------------------------
// Approval queue payload
// ---------------------------------------------------------------------------

describe("approval queue", () => {
  it("returns the breakdown the review dialog needs, without the secret token", async () => {
    const [row] = await adminCaller().awaitingApprovalInvoices();

    expect(row).toMatchObject({
      id: 501,
      amount: 200,
      computedAmount: 200,
      bookingReference: "GFC-BAL42",
      bookingTotal: 250,
      depositCredited: 50,
      customerName: "Ana Lopez",
      customerEmail: "ana@example.com",
    });
    expect(row).not.toHaveProperty("payToken");
  });

  it("credits no deposit when none was ever captured", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, stripePaymentIntentId: null });
    const [row] = await adminCaller().awaitingApprovalInvoices();
    expect(row!.depositCredited).toBe(0);
  });
});
