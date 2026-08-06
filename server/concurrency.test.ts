/**
 * Simultaneous settlement.
 *
 * A deposit has two independent paths to confirmation — the Stripe webhook and
 * the return-page fallback — and they routinely land at the same time. Balance
 * payments have one path that Stripe redelivers. Both used to read the status,
 * decide, and then write, so two callers could both pass the check and each go
 * on to record a payment, redeem the coupon, and email the customer.
 *
 * The guard is a conditional UPDATE whose WHERE carries the expected status, so
 * only the caller that actually changed the row proceeds. The db mocks below
 * stand in for that the way MySQL behaves: the first matching caller wins and
 * every later one affects zero rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreatePayment = vi.fn();
const mockIncrementCoupon = vi.fn();
const mockSendBookingEmails = vi.fn();
const mockNotifyOwner = vi.fn();
const mockGetBookedSlots = vi.fn();

/** Server-side row state the conditional UPDATEs act on. */
const row = {
  bookingStatus: "pending_deposit" as string,
  invoiceStatus: "sent" as string,
  invoiceRefundNeeded: false,
};

const BOOKING = {
  id: 42,
  customerId: 7,
  reference: "GFC-RACE42",
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: "2026-07-20",
  scheduledTime: "10:00",
  depositAmount: 33,
  totalAmount: 200,
  couponCode: "SPARKLE10",
  extras: "[]",
  locale: "en",
  addressLine: "1 Main St",
  city: "San Antonio",
  zip: "78201",
  createdAt: new Date(),
};

const INVOICE = {
  id: 501,
  number: "INV-RACE",
  bookingId: 42,
  customerId: 7,
  amount: 200,
  kind: "balance",
  payToken: "tok",
  paidVia: null as string | null,
  stripePaymentIntentId: null as string | null,
  refundNeeded: false,
  linkExpiresAt: new Date("2099-01-01T00:00:00Z"),
};

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  // Both racers read the row before either has written — that IS the race.
  getBookingById: vi.fn(async () => ({ ...BOOKING, status: row.bookingStatus })),
  getCustomerById: vi.fn().mockResolvedValue({
    id: 7,
    firstName: "Ana",
    lastName: "Lopez",
    email: "ana@example.com",
    phone: null,
  }),
  getInvoiceById: vi.fn(async () => ({
    ...INVOICE,
    status: row.invoiceStatus,
    refundNeeded: row.invoiceRefundNeeded,
    paidVia: row.invoiceStatus === "paid" ? "stripe" : null,
    stripePaymentIntentId: row.invoiceStatus === "paid" ? "pi_race" : null,
  })),
  getBookedSlots: (...args: unknown[]) => mockGetBookedSlots(...args),
  getCouponByCode: vi.fn().mockResolvedValue({ id: 9, code: "SPARKLE10" }),
  incrementCouponRedemptions: (...args: unknown[]) => mockIncrementCoupon(...args),
  createPayment: (...args: unknown[]) => mockCreatePayment(...args),
  updateBooking: vi.fn(),
  updateInvoice: vi.fn(),

  // UPDATE bookings SET status='confirmed' WHERE id=? AND status IN (...)
  confirmUnpaidBooking: vi.fn(async () => {
    if (row.bookingStatus !== "pending_deposit" && row.bookingStatus !== "expired") return false;
    row.bookingStatus = "confirmed";
    return true;
  }),
  // UPDATE invoices SET status='paid' WHERE id=? AND status NOT IN ('paid','void')
  settleUnpaidInvoice: vi.fn(async () => {
    if (row.invoiceStatus === "paid" || row.invoiceStatus === "void") return false;
    row.invoiceStatus = "paid";
    return true;
  }),
  // UPDATE invoices SET refundNeeded=1 WHERE id=? AND refundNeeded=0
  flagInvoiceRefundNeeded: vi.fn(async () => {
    if (row.invoiceRefundNeeded) return false;
    row.invoiceRefundNeeded = true;
    return true;
  }),
}));

vi.mock("./emails", () => ({
  sendBookingEmails: (...args: unknown[]) => mockSendBookingEmails(...args),
  sendBalancePaidNotification: (...args: unknown[]) => mockNotifyOwner(...args),
  sendRefundNeededAlert: (...args: unknown[]) => mockNotifyOwner(...args),
  sendBalanceApprovalNeededAlert: vi.fn(),
  sendBalanceDueEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn(), expire: vi.fn() } } }),
}));

import { applyBalancePayment } from "./balance";
import { finalizeBooking } from "./routers/booking";

beforeEach(() => {
  row.bookingStatus = "pending_deposit";
  row.invoiceStatus = "sent";
  row.invoiceRefundNeeded = false;
  mockCreatePayment.mockReset();
  mockIncrementCoupon.mockReset();
  mockSendBookingEmails.mockReset();
  mockNotifyOwner.mockReset();
  mockGetBookedSlots.mockReset().mockResolvedValue([]);
});

describe("concurrent deposit confirmation (webhook + return page)", () => {
  it("records exactly one payment, one coupon redemption, and one email set", async () => {
    await Promise.all([finalizeBooking(42, "pi_race"), finalizeBooking(42, "pi_race")]);

    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockIncrementCoupon).toHaveBeenCalledTimes(1);
    expect(mockSendBookingEmails).toHaveBeenCalledTimes(1);
    expect(row.bookingStatus).toBe("confirmed");
  });

  it("holds under a burst of redeliveries, not just two", async () => {
    await Promise.all(Array.from({ length: 8 }, () => finalizeBooking(42, "pi_race")));

    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockIncrementCoupon).toHaveBeenCalledTimes(1);
    expect(mockSendBookingEmails).toHaveBeenCalledTimes(1);
  });

  it("still confirms normally when only one caller arrives", async () => {
    await finalizeBooking(42, "pi_solo");

    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, kind: "deposit", amount: 33, status: "succeeded" })
    );
    expect(mockSendBookingEmails).toHaveBeenCalledTimes(1);
  });

  it("a later redelivery after the row settled is still a no-op", async () => {
    await finalizeBooking(42, "pi_first");
    mockCreatePayment.mockClear();
    mockSendBookingEmails.mockClear();

    await finalizeBooking(42, "pi_second");

    expect(mockCreatePayment).not.toHaveBeenCalled();
    expect(mockSendBookingEmails).not.toHaveBeenCalled();
  });
});

describe("concurrent balance payment (redelivered webhook)", () => {
  it("records exactly one payment and one owner notification", async () => {
    const results = await Promise.all([applyBalancePayment(501, "pi_race"), applyBalancePayment(501, "pi_race")]);

    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.outcome === "paid")).toHaveLength(1);
    // The racer that lost re-reads and sees its own payment already on file.
    expect(results.filter(r => r.outcome === "duplicate")).toHaveLength(1);
  });

  it("does not raise a second refund alert when a duplicate is redelivered", async () => {
    row.invoiceStatus = "paid";
    row.invoiceRefundNeeded = false;

    // Two deliveries of a genuinely different second payment.
    const results = await Promise.all([
      applyBalancePayment(501, "pi_different"),
      applyBalancePayment(501, "pi_different"),
    ]);

    expect(results.filter(r => r.outcome === "refund_needed")).toHaveLength(1);
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
  });

  it("still settles normally when only one caller arrives", async () => {
    const result = await applyBalancePayment(501, "pi_solo");

    expect(result.outcome).toBe("paid");
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });
});
