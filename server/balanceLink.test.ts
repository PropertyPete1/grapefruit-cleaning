/**
 * Webhook routing between deposit and balance checkouts, and the customer-facing
 * payment link route (/api/pay/balance/:token) that keeps a link alive for the
 * full 7-day window despite Stripe's 24-hour session cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";

const mockApplyBalancePayment = vi.fn();
const mockOpenCheckout = vi.fn();
const mockMarkProcessing = vi.fn();
const mockClearProcessing = vi.fn();
const mockFinalizeBooking = vi.fn();
const mockConstructEvent = vi.fn();
const mockGetInvoiceByPayToken = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockUpdateInvoice = vi.fn();

vi.mock("./balance", () => ({
  BALANCE_PAYMENT_TYPE: "balance",
  applyBalancePayment: (...args: unknown[]) => mockApplyBalancePayment(...args),
  openBalanceCheckout: (...args: unknown[]) => mockOpenCheckout(...args),
  markBalancePaymentProcessing: (...args: unknown[]) => mockMarkProcessing(...args),
  clearBalancePaymentProcessing: (...args: unknown[]) => mockClearProcessing(...args),
  balancePayUrl: (origin: string, token: string) => `${origin}/api/pay/balance/${token}`,
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
  mockOpenCheckout.mockResolvedValue({ kind: "redirect", url: "https://stripe.test/checkout", sessionId: "cs_new", reused: false });
  mockMarkProcessing.mockResolvedValue({ outcome: "processing" });
  mockClearProcessing.mockResolvedValue({ outcome: "cleared" });
});

// ---------------------------------------------------------------------------
// Webhook routing
// ---------------------------------------------------------------------------

describe("checkout.session.completed routing", () => {
  const webhookRequest = () =>
    ({ headers: { "stripe-signature": "sig" }, body: Buffer.from("{}") }) as unknown as Request;

  function fireEvent(session: Record<string, unknown>, id = "evt_1", type = "checkout.session.completed") {
    mockConstructEvent.mockReturnValue({ id, type, data: { object: session } });
    const handler = captureHandler(registerStripeWebhook);
    return handler(webhookRequest(), fakeRes() as unknown as Response);
  }

  it("routes a balance session to the balance handler, not the deposit one", async () => {
    await fireEvent({
      metadata: { payment_type: "balance", invoice_id: "501", booking_id: "42" },
      payment_status: "paid",
      payment_intent: "pi_balance_1",
    });

    expect(mockApplyBalancePayment).toHaveBeenCalledWith(501, "pi_balance_1", { method: "card" });
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

  it("never settles a balance session that completed unpaid", async () => {
    await fireEvent({
      metadata: { payment_type: "balance", invoice_id: "501" },
      payment_status: "unpaid",
      payment_intent: null,
    });
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
    expect(mockMarkProcessing).not.toHaveBeenCalled();
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });

  it("marks the invoice processing when a bank payment completes checkout unpaid", async () => {
    await fireEvent({
      metadata: { payment_type: "balance", invoice_id: "501" },
      payment_status: "unpaid",
      payment_intent: "pi_ach_1",
    });
    expect(mockMarkProcessing).toHaveBeenCalledWith(501, "pi_ach_1");
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
  });

  it("settles on checkout.session.async_payment_succeeded, as a bank payment", async () => {
    await fireEvent(
      { metadata: { payment_type: "balance", invoice_id: "501" }, payment_status: "paid", payment_intent: "pi_ach_1" },
      "evt_async_ok",
      "checkout.session.async_payment_succeeded"
    );
    expect(mockApplyBalancePayment).toHaveBeenCalledWith(501, "pi_ach_1", { method: "bank" });
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });

  it("clears the processing state on checkout.session.async_payment_failed", async () => {
    await fireEvent(
      { metadata: { payment_type: "balance", invoice_id: "501" }, payment_status: "unpaid", payment_intent: "pi_ach_1" },
      "evt_async_fail",
      "checkout.session.async_payment_failed"
    );
    expect(mockClearProcessing).toHaveBeenCalledWith(501, "pi_ach_1");
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
  });

  it("routes balance payment_intent events by the metadata copied onto the intent", async () => {
    const intent = { id: "pi_ach_2", metadata: { payment_type: "balance", invoice_id: "501" } };
    await fireEvent(intent, "evt_pi_1", "payment_intent.processing");
    await fireEvent(intent, "evt_pi_2", "payment_intent.payment_failed");
    await fireEvent(intent, "evt_pi_3", "payment_intent.succeeded");
    expect(mockMarkProcessing).toHaveBeenCalledWith(501, "pi_ach_2");
    expect(mockClearProcessing).toHaveBeenCalledWith(501, "pi_ach_2");
    expect(mockApplyBalancePayment).toHaveBeenCalledWith(501, "pi_ach_2");
  });

  it("ignores payment_intent events that carry no invoice metadata (deposits, tips, old sessions)", async () => {
    await fireEvent({ id: "pi_deposit", metadata: {} }, "evt_pi_4", "payment_intent.succeeded");
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
  });

  it("does not touch deposits or tips on async events (not handled for them yet)", async () => {
    await fireEvent(
      { metadata: { booking_id: "42" }, payment_status: "paid", payment_intent: "pi_dep" },
      "evt_async_dep",
      "checkout.session.async_payment_succeeded"
    );
    expect(mockFinalizeBooking).not.toHaveBeenCalled();
    expect(mockApplyBalancePayment).not.toHaveBeenCalled();
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

  it("opens the invoice's one live session and redirects while the window is open", async () => {
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockOpenCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 501, customerEmail: "ana@example.com", locale: "en" })
    );
    // Never the look-only mode: this visit may mint if nothing is live.
    expect(mockOpenCheckout.mock.calls[0]![0]).not.toHaveProperty("mint", false);
    expect(res.statusCode).toBe(303);
    expect(res.redirectUrl).toBe("https://stripe.test/checkout");
    // The route no longer writes the session itself — the open stores it under its claim.
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });

  it("refuses a second checkout while the customer's bank payment is processing", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "processing", paymentIntentId: "pi_ach_1" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.redirectUrl).toBeUndefined();
    expect(String(res.body)).toContain("Your bank payment is processing");
  });

  it("says processing in Spanish for a Spanish booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    mockOpenCheckout.mockResolvedValue({ kind: "processing", paymentIntentId: "pi_ach_1" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);
    expect(String(res.body)).toContain("Su pago bancario está en proceso");
  });

  it("shows the paid notice when Stripe reports the live session paid", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "paid" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);
    expect(res.redirectUrl).toBeUndefined();
    expect(String(res.body)).toContain("Payment received");
  });

  it("answers 'try again' rather than minting when another visit holds the claim", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "busy" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);
    expect(res.statusCode).toBe(503);
    expect(res.redirectUrl).toBeUndefined();
  });

  it("on return from Stripe asks Stripe (look only) and thanks a paid customer", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "paid" });
    const res = fakeRes();
    await handler()(request("tok_abc", { paid: "1" }), res as unknown as Response);

    expect(mockOpenCheckout).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 501, mint: false }));
    expect(res.redirectUrl).toBeUndefined();
    expect(String(res.body)).toContain("Payment received");
  });

  it("on return from a bank payment says processing — never 'paid in full'", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "processing", paymentIntentId: "pi_ach_1" });
    const res = fakeRes();
    await handler()(request("tok_abc", { paid: "1" }), res as unknown as Response);

    expect(String(res.body)).toContain("Your bank payment is processing");
    expect(String(res.body)).not.toContain("paid in full");
  });

  it("on return with nothing settled yet says it is confirming, and still never reopens checkout", async () => {
    mockOpenCheckout.mockResolvedValue({ kind: "redirect", url: "https://stripe.test/live", sessionId: "cs_live", reused: true });
    const res = fakeRes();
    await handler()(request("tok_abc", { paid: "1" }), res as unknown as Response);
    expect(res.redirectUrl).toBeUndefined();
    expect(String(res.body)).toContain("confirming your payment");
  });

  it("on return falls back to 'confirming' when Stripe cannot be read", async () => {
    mockOpenCheckout.mockRejectedValue(new Error("Stripe is down"));
    const res = fakeRes();
    await handler()(request("tok_abc", { paid: "1" }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("confirming your payment");
  });

  it("lands Stripe's Back/cancel on a page with a button, never a redirect into the live session", async () => {
    const res = fakeRes();
    await handler()(request("tok_abc", { cancelled: "1" }), res as unknown as Response);

    expect(mockOpenCheckout).not.toHaveBeenCalled();
    expect(res.redirectUrl).toBeUndefined();
    const body = String(res.body);
    expect(body).toContain("Your payment wasn't completed");
    expect(body).toContain('href="https://grapefruitclean.com/api/pay/balance/tok_abc"');
  });

  it("refuses to open checkout for a voided invoice whose window is still open", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, status: "void" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockOpenCheckout).not.toHaveBeenCalled();
    expect(String(res.body)).toContain("expired");
  });

  it("still asks Stripe for a processing invoice whose window has lapsed (the bank may have failed since)", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({
      ...INVOICE,
      paymentProcessingAt: new Date(),
      linkExpiresAt: new Date(Date.now() - 86_400_000),
    });
    mockOpenCheckout.mockResolvedValue({ kind: "processing", paymentIntentId: "pi_ach_1" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);
    expect(mockOpenCheckout).toHaveBeenCalledTimes(1);
    expect(String(res.body)).toContain("Your bank payment is processing");
  });

  it("shows an expired notice once the 7-day window closes", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, linkExpiresAt: new Date(Date.now() - 86_400_000) });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockOpenCheckout).not.toHaveBeenCalled();
    expect(String(res.body)).toContain("expired");
  });

  it("never reopens checkout for an already-paid invoice", async () => {
    mockGetInvoiceByPayToken.mockResolvedValue({ ...INVOICE, status: "paid" });
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(mockOpenCheckout).not.toHaveBeenCalled();
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
    expect(mockOpenCheckout).not.toHaveBeenCalled();
  });

  it("rate-limits repeated hits so the link cannot be used to mint sessions in bulk", async () => {
    const run = () => handler()(request("tok_abc"), fakeRes() as unknown as Response);
    for (let i = 0; i < 10; i++) await run();
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(res.statusCode).toBe(429);
    expect(mockOpenCheckout).toHaveBeenCalledTimes(10);
  });

  it("degrades to an error notice when Stripe fails, without crashing the route", async () => {
    mockOpenCheckout.mockRejectedValue(new Error("Stripe is down"));
    const res = fakeRes();
    await handler()(request("tok_abc"), res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain("Something went wrong");
  });
});
