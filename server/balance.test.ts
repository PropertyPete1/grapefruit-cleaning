/**
 * Automated remaining-balance collection: balance maths (including coupons and
 * the zero-balance cases), Checkout Session creation, the webhook paths
 * (balance paid, deposits unaffected, duplicate delivery, the manual-paid
 * race), resending links, and the untouched manual-paid behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetInvoiceById = vi.fn();
const mockGetBalanceInvoiceForBooking = vi.fn();
const mockCreateInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();
const mockCreatePayment = vi.fn();
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
  createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
  updateInvoice: (...args: unknown[]) => mockUpdateInvoice(...args),
  createPayment: (...args: unknown[]) => mockCreatePayment(...args),
  updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
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

// Emails go through the real builders and deliverEmail; only SMTP is faked.
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import {
  applyBalancePayment,
  approveBalanceInvoice,
  balanceDueForBooking,
  balancePayUrl,
  createBalanceCheckoutSession,
  issueBalanceForCompletedBooking,
  originFromRequest,
  resendBalanceLink,
} from "./balance";
import { BALANCE_LINK_DAYS, balanceLinkStatus, computeBalanceDue, STRIPE_SESSION_MAX_SECONDS } from "./balanceRules";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";
import { staffRouter } from "./routers/staff";

/** Emails actually handed to SMTP, oldest first. */
function sentEmails(): { to: string; subject: string; text: string }[] {
  return mockSendMail.mock.calls.map(call => call[0] as { to: string; subject: string; text: string });
}

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
  // Deposit actually captured through Stripe.
  stripePaymentIntentId: "pi_deposit_1",
};

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  preferredLocale: "en" as const,
};

const INVOICE = {
  id: 501,
  number: "INV-TEST-01",
  bookingId: 42,
  customerId: 7,
  amount: 200,
  kind: "balance" as const,
  status: "sent" as const,
  payToken: "tok_abc",
  stripeSessionId: "cs_balance_1",
  stripePaymentIntentId: null as string | null,
  paidVia: null as "stripe" | "manual" | null,
  refundNeeded: false,
  linkExpiresAt: new Date("2099-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "");
  __resetTransporter();
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetBalanceInvoiceForBooking.mockResolvedValue(undefined);
  mockCreateInvoice.mockResolvedValue(501);
  mockSessionCreate.mockResolvedValue({ id: "cs_balance_1", url: "https://stripe.test/balance" });
  mockSendMail.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

// ---------------------------------------------------------------------------
// Balance computation
// ---------------------------------------------------------------------------

describe("computeBalanceDue", () => {
  it("subtracts the deposit from the stored total", () => {
    expect(computeBalanceDue({ totalAmount: 250, depositAmount: 50 })).toBe(200);
  });

  it("returns zero when the deposit covers the whole total", () => {
    expect(computeBalanceDue({ totalAmount: 100, depositAmount: 100 })).toBe(0);
  });

  it("never returns a negative balance when the deposit overshoots the total", () => {
    expect(computeBalanceDue({ totalAmount: 100, depositAmount: 130 })).toBe(0);
  });

  it("works off the discounted total, so a coupon lowers the balance", () => {
    // $250 booking with a 20% coupon stores totalAmount 200, deposit 40.
    expect(computeBalanceDue({ totalAmount: 200, depositAmount: 40 })).toBe(160);
  });

  it("lands on zero for a 100% coupon (booking clamps total and deposit to $1)", () => {
    expect(computeBalanceDue({ totalAmount: 1, depositAmount: 1 })).toBe(0);
  });

  it("rounds fractional stored amounts to whole dollars", () => {
    expect(computeBalanceDue({ totalAmount: 164.99, depositAmount: 33 })).toBe(132);
  });
});

describe("balanceDueForBooking", () => {
  it("credits the deposit when it was captured through Stripe", () => {
    expect(balanceDueForBooking(BOOKING)).toBe(200);
  });

  it("bills the full total when no deposit was ever collected", () => {
    // e.g. a phone booking moved straight from pending_deposit to completed.
    expect(balanceDueForBooking({ ...BOOKING, stripePaymentIntentId: null })).toBe(250);
  });
});

describe("balanceLinkStatus", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("reports 'sent' while the window is open", () => {
    expect(balanceLinkStatus({ status: "sent", payToken: "t", linkExpiresAt: "2026-08-10T00:00:00Z" }, now)).toBe("sent");
  });

  it("reports 'expired' once the window closes with the balance outstanding", () => {
    expect(balanceLinkStatus({ status: "sent", payToken: "t", linkExpiresAt: "2026-08-01T00:00:00Z" }, now)).toBe("expired");
  });

  it("reports 'paid' even after the window closed", () => {
    expect(balanceLinkStatus({ status: "paid", payToken: "t", linkExpiresAt: "2026-08-01T00:00:00Z" }, now)).toBe("paid");
  });

  it("reports 'none' for invoices that never had a link", () => {
    expect(balanceLinkStatus({ status: "sent", payToken: null, linkExpiresAt: null }, now)).toBe("none");
  });

  it("reports 'none' for a zero-balance invoice auto-marked paid without a link", () => {
    expect(balanceLinkStatus({ status: "paid", payToken: null, linkExpiresAt: null }, now)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Checkout session creation
// ---------------------------------------------------------------------------

describe("createBalanceCheckoutSession", () => {
  it("charges the exact balance, tags balance metadata, and caps the session at Stripe's 24h limit", async () => {
    const now = new Date("2026-08-05T12:00:00Z");
    await createBalanceCheckoutSession({
      invoice: { id: 501, number: "INV-TEST-01", amount: 200, payToken: "tok_abc" },
      booking: BOOKING,
      customerEmail: CUSTOMER.email,
      origin: ORIGIN,
      now,
    });

    const args = mockSessionCreate.mock.calls[0]![0] as {
      mode: string;
      expires_at: number;
      line_items: { price_data: { unit_amount: number; currency: string } }[];
      metadata: Record<string, string>;
      success_url: string;
      allow_promotion_codes: boolean;
    };
    expect(args.mode).toBe("payment");
    expect(args.allow_promotion_codes).toBe(false);
    expect(args.line_items[0]!.price_data.unit_amount).toBe(200 * 100);
    expect(args.line_items[0]!.price_data.currency).toBe("usd");
    expect(args.expires_at).toBe(Math.floor(now.getTime() / 1000) + STRIPE_SESSION_MAX_SECONDS);
    expect(args.metadata.payment_type).toBe("balance");
    expect(args.metadata.invoice_id).toBe("501");
    expect(args.metadata.booking_id).toBe("42");
    expect(args.metadata.booking_reference).toBe("GFC-BAL42");
    // Returning customers land on the "thank you" notice, never back in checkout.
    expect(args.success_url).toBe(`${ORIGIN}/api/pay/balance/tok_abc?paid=1`);
  });

  it("describes the charge in Spanish for a Spanish booking", async () => {
    await createBalanceCheckoutSession({
      invoice: { id: 501, number: "INV-TEST-01", amount: 200, payToken: "tok_abc" },
      booking: { ...BOOKING, locale: "es" as const },
      customerEmail: CUSTOMER.email,
      origin: ORIGIN,
    });
    const args = mockSessionCreate.mock.calls[0]![0] as {
      line_items: { price_data: { product_data: { name: string } } }[];
      metadata: Record<string, string>;
    };
    expect(args.line_items[0]!.price_data.product_data.name).toContain("Saldo restante");
    expect(args.metadata.locale).toBe("es");
  });
});

// ---------------------------------------------------------------------------
// Issuing the balance on completion
// ---------------------------------------------------------------------------

describe("issueBalanceForCompletedBooking", () => {
  it("files the balance for approval without billing the customer", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "awaiting_approval" });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);

    expect(result).toMatchObject({ outcome: "awaiting_approval", invoiceId: 501, amount: 200 });
    const invoiceArgs = mockCreateInvoice.mock.calls[0]![0] as Record<string, unknown>;
    expect(invoiceArgs).toMatchObject({
      bookingId: 42,
      customerId: 7,
      amount: 200,
      computedAmount: 200,
      kind: "balance",
      status: "awaiting_approval",
    });
    // Nothing customer-facing exists yet.
    expect(invoiceArgs.payToken).toBeUndefined();
    expect(invoiceArgs.linkExpiresAt).toBeUndefined();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("sends the customer nothing on completion, only the owner an approval alert", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "awaiting_approval" });
    await issueBalanceForCompletedBooking(42, ORIGIN);

    // The only mail is the owner's — the customer is not contacted.
    expect(sentEmails().every(e => e.to !== "ana@example.com")).toBe(true);
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Approve balance") })
    );
    const alert = mockNotifyOwner.mock.calls[0]![0] as { content: string };
    expect(alert.content).toContain("nothing has been sent to the customer yet");
    expect(alert.content).toContain("$200 USD");
  });

  it("skips the link and marks the invoice paid when nothing is owed", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 100, depositAmount: 100 });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);

    expect(result).toMatchObject({ outcome: "zero_balance" });
    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 0, status: "paid", kind: "balance" })
    );
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("skips the link for a 100% coupon booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 1, depositAmount: 1, couponCode: "FREECLEAN" });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);
    expect(result.outcome).toBe("zero_balance");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("is idempotent: a booking that already has a balance invoice is left alone", async () => {
    mockGetBalanceInvoiceForBooking.mockResolvedValue(INVOICE);
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);

    expect(result).toMatchObject({ outcome: "already_issued", invoiceId: 501 });
    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("does nothing for a booking that is not completed", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "confirmed" });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);
    expect(result.outcome).toBe("not_completed");
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });

  it("queues the full total when the deposit was never captured", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, stripePaymentIntentId: null });
    const result = await issueBalanceForCompletedBooking(42, ORIGIN);
    expect(result).toMatchObject({ outcome: "awaiting_approval", amount: 250 });
  });
});

// ---------------------------------------------------------------------------
// Webhook paths
// ---------------------------------------------------------------------------

describe("applyBalancePayment (webhook)", () => {
  it("marks the invoice paid, records the payment, and notifies the owner", async () => {
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    const result = await applyBalancePayment(501, "pi_balance_1");

    expect(result.outcome).toBe("paid");
    expect(mockUpdateInvoice).toHaveBeenCalledWith(
      501,
      expect.objectContaining({ status: "paid", paidVia: "stripe", stripePaymentIntentId: "pi_balance_1" })
    );
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 501,
        bookingId: 42,
        customerId: 7,
        amount: 200,
        kind: "balance",
        method: "card",
        status: "succeeded",
        stripePaymentIntentId: "pi_balance_1",
      })
    );
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Balance paid") })
    );
  });

  it("is a no-op when Stripe redelivers the same event", async () => {
    mockGetInvoiceById.mockResolvedValue({
      ...INVOICE,
      status: "paid",
      paidVia: "stripe",
      stripePaymentIntentId: "pi_balance_1",
    });
    const result = await applyBalancePayment(501, "pi_balance_1");

    expect(result.outcome).toBe("duplicate");
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("flags a refund instead of double-paying when the balance was collected in person", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "paid", paidVia: "manual", paidAt: new Date() });
    const result = await applyBalancePayment(501, "pi_late_card");

    expect(result.outcome).toBe("refund_needed");
    // Manual payment wins: status and paidAt are left exactly as they were.
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toEqual({ refundNeeded: true, stripePaymentIntentId: "pi_late_card" });
    expect(patch.status).toBeUndefined();
    expect(patch.paidAt).toBeUndefined();
    // The money did arrive, so it is still recorded — against the refund.
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 501, amount: 200, kind: "balance", status: "succeeded" })
    );
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("REFUND NEEDED") })
    );
  });

  it("does not re-flag or re-alert when the refund-needed event is redelivered", async () => {
    mockGetInvoiceById.mockResolvedValue({
      ...INVOICE,
      status: "paid",
      paidVia: "manual",
      refundNeeded: true,
      stripePaymentIntentId: "pi_late_card",
    });
    const result = await applyBalancePayment(501, "pi_late_card");

    expect(result.outcome).toBe("duplicate");
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("flags a refund when a second, different card payment lands on a paid invoice", async () => {
    mockGetInvoiceById.mockResolvedValue({
      ...INVOICE,
      status: "paid",
      paidVia: "stripe",
      stripePaymentIntentId: "pi_first",
    });
    const result = await applyBalancePayment(501, "pi_second");
    expect(result.outcome).toBe("refund_needed");
  });

  it("flags a refund when payment lands on a voided invoice", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "void" });
    const result = await applyBalancePayment(501, "pi_after_void");
    expect(result.outcome).toBe("refund_needed");
  });

  it("ignores payments for an unknown invoice", async () => {
    mockGetInvoiceById.mockResolvedValue(undefined);
    const result = await applyBalancePayment(999, "pi_orphan");
    expect(result.outcome).toBe("not_found");
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

describe("resendBalanceLink", () => {
  it("reopens the 7-day window, mints a new session, and re-emails the link", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, linkExpiresAt: new Date("2020-01-01T00:00:00Z") });
    const result = await resendBalanceLink(501, ORIGIN);

    expect(result.outcome).toBe("resent");
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const patch = mockUpdateInvoice.mock.calls[0]![1] as { status: string; linkExpiresAt: Date; payToken: string };
    expect(patch.status).toBe("sent");
    expect(patch.payToken).toBe("tok_abc"); // same token: older emails keep working
    expect(patch.linkExpiresAt.getTime()).toBeGreaterThan(Date.now());
    const email = sentEmails()[0]!;
    expect(email.to).toBe("ana@example.com");
    expect(email.subject).toContain("Your cleaning is complete");
  });

  it("refuses to resend a paid invoice", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "paid" });
    const result = await resendBalanceLink(501, ORIGIN);
    expect(result.outcome).toBe("already_paid");
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("refuses to resend a manual invoice that has no payment link", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, kind: "manual" });
    const result = await resendBalanceLink(501, ORIGIN);
    expect(result.outcome).toBe("not_a_balance_invoice");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("surfaces resend as an admin mutation", async () => {
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    const result = await caller.resendBalanceLink({ invoiceId: 501 });
    expect(result.emailed).toBe(true);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects resending a paid invoice through the admin router", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "paid" });
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    await expect(caller.resendBalanceLink({ invoiceId: 501 })).rejects.toThrow(/already paid/i);
  });
});

// ---------------------------------------------------------------------------
// Manual payment (unchanged behavior) + completion triggers
// ---------------------------------------------------------------------------

describe("admin.updateInvoiceStatus (manual collection)", () => {
  const caller = () => adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);

  it("marks an invoice paid with a paid-at stamp, exactly as before", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, kind: "manual", stripeSessionId: null });
    const result = await caller().updateInvoiceStatus({ id: 501, status: "paid" });

    expect(result.success).toBe(true);
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.status).toBe("paid");
    expect(patch.paidAt).toBeInstanceOf(Date);
    expect(patch.paidVia).toBe("manual");
    expect(mockSessionExpire).not.toHaveBeenCalled();
  });

  it("leaves paidAt alone for non-paid statuses", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, kind: "manual" });
    await caller().updateInvoiceStatus({ id: 501, status: "void" });
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.status).toBe("void");
    expect(patch.paidAt).toBeUndefined();
    expect(patch.paidVia).toBeUndefined();
  });

  it("closes the outstanding checkout when a balance is collected in person", async () => {
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    await caller().updateInvoiceStatus({ id: 501, status: "paid" });

    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, expect.objectContaining({ status: "paid", paidVia: "manual" }));
    expect(mockSessionExpire).toHaveBeenCalledWith("cs_balance_1");
  });

  it("still marks paid when Stripe refuses to expire the session", async () => {
    mockGetInvoiceById.mockResolvedValue(INVOICE);
    mockSessionExpire.mockRejectedValue(new Error("already expired"));
    const result = await caller().updateInvoiceStatus({ id: 501, status: "paid" });
    expect(result.success).toBe(true);
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, expect.objectContaining({ status: "paid" }));
  });

  it("does not overwrite a Stripe settlement with 'manual'", async () => {
    mockGetInvoiceById.mockResolvedValue({ ...INVOICE, status: "paid", paidVia: "stripe" });
    await caller().updateInvoiceStatus({ id: 501, status: "paid" });
    const patch = mockUpdateInvoice.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.paidVia).toBeUndefined();
  });
});

describe("marking a booking completed triggers balance collection", () => {
  it("issues the balance link from the admin dashboard", async () => {
    const caller = adminRouter.createCaller({
      user: { id: 1, role: "admin" },
      req: { protocol: "https", headers: { origin: ORIGIN } },
    } as never);
    await caller.updateBookingStatus({ id: 42, status: "completed" });

    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "completed" });
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ kind: "balance", amount: 200 }));
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("issues the balance link from the staff dashboard", async () => {
    const caller = staffRouter.createCaller({
      user: { id: 2, role: "staff" },
      req: { protocol: "https", headers: { origin: ORIGIN } },
    } as never);
    await caller.updateJobStatus({ bookingId: 42, status: "completed" });

    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "completed" });
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ kind: "balance", amount: 200 }));
  });

  it("does not issue anything for other status changes", async () => {
    const caller = staffRouter.createCaller({
      user: { id: 2, role: "staff" },
      req: { protocol: "https", headers: { origin: ORIGIN } },
    } as never);
    await caller.updateJobStatus({ bookingId: 42, status: "in_progress" });

    expect(mockCreateInvoice).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("still completes the booking when balance collection fails", async () => {
    mockSessionCreate.mockRejectedValue(new Error("Stripe is down"));
    const caller = adminRouter.createCaller({
      user: { id: 1, role: "admin" },
      req: { protocol: "https", headers: { origin: ORIGIN } },
    } as never);
    const result = await caller.updateBookingStatus({ id: 42, status: "completed" });

    expect(result.success).toBe(true);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "completed" });
  });
});

describe("link helpers", () => {
  it("builds pay URLs without doubling the slash", () => {
    expect(balancePayUrl("https://x.com/", "abc")).toBe("https://x.com/api/pay/balance/abc");
  });

  it("prefers the request origin, falling back to the host header", () => {
    expect(originFromRequest({ headers: { origin: ORIGIN } })).toBe(ORIGIN);
    expect(originFromRequest({ protocol: "https", headers: { host: "grapefruitclean.com" } })).toBe(ORIGIN);
    expect(originFromRequest(undefined)).toBe("");
  });
});
