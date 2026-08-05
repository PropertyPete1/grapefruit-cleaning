/**
 * Webhook routing between deposit and balance checkouts, and the customer-facing
 * payment link route (/api/pay/balance/:token) that keeps a link alive for the
 * full 7-day window despite Stripe's 24-hour session cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";

const mockApplyBalancePayment = vi.fn();
const mockCreateBalanceSession = vi.fn();
const mockFinalizeBooking = vi.fn();
const mockConstructEvent = vi.fn();
const mockGetInvoiceByPayToken = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockUpdateInvoice = vi.fn();

vi.mock("./balance", () => ({
  BALANCE_PAYMENT_TYPE: "balance",
  applyBalancePayment: (...args: unknown[]) => mockApplyBalancePayment(...args),
  createBalanceCheckoutSession: (...args: unknown[]) => mockCreateBalanceSession(...args),
}));

vi.mock("./routers/booking", () => ({
  finalizeBooking: (...args: unknown[]) => mockFinalizeBooking(...args),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ webhooks: { constructEvent: (...args: unknown[]) => mockConstructEvent(...args) } }),
}));

vi.mock("./db", () => ({
  getInvoiceByPayToken: (...args: unknown[]) => mockGetInvoiceByPayToken(...args),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  updateInvoice: (...args: unknown[]) => mockUpdateInvoice(...args),
}));

import { _resetRateLimits } from "./antiSpam";
import { registerBalanceRoutes } from "./balanceRoutes";
import { registerStripeWebhook } from "./stripeWebhook";

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Registers routes against a stub Express app and returns the final handler. */
function captureHandler(register: (app: Express) => void): Handler {
  let handler: Handler | undefined;
  const capture = (_path: string, ...rest: unknown[]) => {
    handler = rest[rest.length - 1] as Handler;
  };
  register({ get: capture, post: capture } as unknown as Express);
  if (!handler) throw new Error("no route registered");
  return handler;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    redirectUrl: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    type() {
      return res;
    },
    send(payload: unknown) {
      res.body = payload;
      return res;
    },
    redirect(code: number, url: string) {
      res.statusCode = code;
      res.redirectUrl = url;
      return res;
    },
  };
  return res;
}

const INVOICE = {
  id: 501,
  number: "INV-TEST-01",
  bookingId: 42,
  customerId: 7,
  amount: 200,
  kind: "balance" as const,
  status: "sent" as const,
  payToken: "tok_abc",
  linkExpiresAt: new Date(Date.now() + 3 * 86_400_000),
};

const BOOKING = { id: 42, reference: "GFC-BAL42", locale: "en", serviceType: "residential", scheduledDate: "2026-08-01" };
const CUSTOMER = { id: 7, firstName: "Ana", email: "ana@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  mockApplyBalancePayment.mockResolvedValue({ outcome: "paid" });
  mockGetInvoiceByPayToken.mockResolvedValue(INVOICE);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockCreateBalanceSession.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/checkout" });
});

// ---------------------------------------------------------------------------
// Webhook routing
// ---------------------------------------------------------------------------

describe("checkout.session.completed routing", () => {
  const webhookRequest = () =>
    ({ headers: { "stripe-signature": "sig" }, body: Buffer.from("{}") }) as unknown as Request;

  function fireEvent(session: Record<string, unknown>, id = "evt_1") {
    mockConstructEvent.mockReturnValue({ id, type: "checkout.session.completed", data: { object: session } });
    const handler = captureHandler(registerStripeWebhook);
    return handler(webhookRequest(), fakeRes() as unknown as Response);
  }

  it("routes a balance session to the balance handler, not the deposit one", async () => {
    await fireEvent({
      metadata: { payment_type: "balance", invoice_id: "501", booking_id: "42" },
      payment_status: "paid",
      payment_intent: "pi_balance_1",
    });

    expect(mockApplyBalancePayment).toHaveBeenCalledWith(501, "pi_balance_1");
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });

  it("leaves deposit sessions on the original path, untouched", async () => {
    await fireEvent({
      metadata: { booking_id: "42", booking_reference: "GFC-BAL42" },
      payment_status: "paid",
      payment_intent: "pi_deposit_1",
    });

    expect(mockFinalizeBooking).toHaveBeenCalledWith(42, "pi_deposit_1");
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
  });

  it("still finalizes deposits that carry only client_reference_id", async () => {
    await fireEvent({ metadata: {}, client_reference_id: "42", payment_status: "paid", payment_intent: "pi_x" });
    expect(mockFinalizeBooking).toHaveBeenCalledWith(42, "pi_x");
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
  });

  it("ignores balance sessions that were not actually paid", async () => {
    await fireEvent({
      metadata: { payment_type: "balance", invoice_id: "501" },
      payment_status: "unpaid",
      payment_intent: null,
    });
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });

  it("returns the verification response for Stripe test events without touching payments", async () => {
    const res = fakeRes();
    mockConstructEvent.mockReturnValue({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: { metadata: { payment_type: "balance", invoice_id: "501" }, payment_status: "paid" } },
    });
    const handler = captureHandler(registerStripeWebhook);
    await handler(webhookRequest(), res as unknown as Response);

    expect(res.body).toEqual({ verified: true });
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable signature before doing any work", async () => {
    const res = fakeRes();
    mockConstructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const handler = captureHandler(registerStripeWebhook);
    await handler(webhookRequest(), res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Customer payment link
// ---------------------------------------------------------------------------

describe("GET /api/pay/balance/:token", () => {
  const handler = () => captureHandler(registerBalanceRoutes);
  const request = (token: string, query: Record<string, string> = {}) =>
    ({
      params: { token },
      query,
      protocol: "https",
      headers: { host: "grapefruitclean.com" },
      socket: { remoteAddress: "203.0.113.9" },
    }) as unknown as Request;

  it("mints a fresh session and redirects while the window is open", async () => {
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockCreateBalanceSession).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: INVOICE, customerEmail: "ana@example.com" })
    );
    expect(res.statusCode).toBe(303);
    expect(res.redirectUrl).toBe("https://stripe.test/checkout");
    expect(mockUpdateInvoice).toHaveBeenCalledWith(501, { stripeSessionId: "cs_new" });
  });

  it("shows the thank-you notice on return from Stripe without reopening checkout", async () => {
    const res = fakeRes();
    await handler()(request("tok_abc", { paid: "1" }), res as unknown as Response);

    expect(mockCreateBalanceSession).not.toHaveBeenCalled();
    expect(String(res.body)).toContain("Payment received");
  });

  it("shows an expired notice once the 7-day window closes", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, linkExpiresAt: new Date(Date.now() - 86_400_000) });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockCreateBalanceSession).not.toHaveBeenCalled();
    expect(String(res.body)).toContain("expired");
  });

  it("never reopens checkout for an already-paid invoice", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, status: "paid" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockCreateBalanceSession).not.toHaveBeenCalled();
    expect(String(res.body)).toContain("Payment received");
  });

  it("renders the notice in the language stored on the booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, status: "paid" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(String(res.body)).toContain("Pago recibido");
  });

  it("404s an unknown token", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue(undefined);
    const res = fakeRes();
    await handler()(request("nope"), res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect(mockCreateBalanceSession).not.toHaveBeenCalled();
  });

  it("rate-limits repeated hits so the link cannot be used to mint sessions in bulk", async () => {
    const run = () => handler()(request("tok_abc"), fakeRes() as unknown as Response);
    for (let i = 0; i < 10; i++) await run();
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(res.statusCode).toBe(429);
    expect(mockCreateBalanceSession).toHaveBeenCalledTimes(10);
  });

  it("degrades to an error notice when Stripe fails, without crashing the route", async () => {
    mockCreateBalanceSession.mockRejectedValue(new Error("Stripe is down"));
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("Something went wrong");
  });
});
