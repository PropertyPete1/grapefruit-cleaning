/**
 * The ACH double charge, replayed end to end.
 *
 * A customer paid her balance by bank (ACH), had trouble with the link, and
 * retried a minute later. ACH completes Checkout "unpaid" and stays that way
 * for days, the invoice still read unpaid, the pay link minted a second
 * session, and both debits settled.
 *
 * Everything here runs the REAL pay route, webhook, settlement, checkout
 * state machine and reminder sweep. Only the database rows and the Stripe
 * objects are stand-ins (paymentTestKit.ts), stateful so a session the
 * customer pays stays paid and an invoice marked processing stays processing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";

const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", async () => (await import("./paymentTestKit")).fakeDb);
vi.mock("./stripe", async () => {
  const { fakeStripe } = await import("./paymentTestKit");
  return { getStripe: () => fakeStripe };
});
vi.mock("./_core/notification", () => ({ notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a) }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { _resetRateLimits } from "./antiSpam";
import { applyBalancePayment, resendBalanceLink, sendDueBalanceReminders, syncInvoiceWithStripe } from "./balance";
import { registerBalanceRoutes } from "./balanceRoutes";
import { __resetTransporter } from "./emails";
import { findOverlappingSessions, inspectPaymentIntegrity } from "./paymentHealth";
import {
  bankSettles,
  customerPays,
  fakeStripe,
  intentEvent,
  kit,
  resetKit,
  seedInvoice,
  sessionEvent,
  stripeKit,
} from "./paymentTestKit";
import { registerStripeWebhook } from "./stripeWebhook";

type Handler = (req: Request, res: Response) => Promise<unknown>;

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

const DAY = 86_400_000;
const TOKEN = "tok_live_balance";
const INVOICE_ID = 501;
const NUMBER = "INV-ACH-TEST-01";

/** One visit to the emailed pay link. */
async function visit(query: Record<string, string> = {}) {
  const res = fakeRes();
  const req = {
    params: { token: TOKEN },
    query,
    protocol: "https",
    headers: { host: "grapefruitclean.com" },
    socket: { remoteAddress: "203.0.113.9" },
  } as unknown as Request;
  await captureHandler(registerBalanceRoutes)(req, res as unknown as Response);
  return res;
}

/** One Stripe webhook delivery. */
async function deliver(eventJson: string) {
  const res = fakeRes();
  const req = { headers: { "stripe-signature": "sig" }, body: Buffer.from(eventJson) } as unknown as Request;
  await captureHandler(registerStripeWebhook)(req, res as unknown as Response);
  expect(res.statusCode).toBe(200);
  return res;
}

const invoice = () => kit.invoices.get(INVOICE_ID)!;
const ownerAlerts = () => mockNotifyOwner.mock.calls.map(c => c[0] as { title: string; content: string });
const customerEmails = () =>
  mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string }).filter(m => m.to === "alex@example.com");

/** A session minted outside the pay route — what the pre-fix code left lying around on every visit. */
async function legacySession(): Promise<string> {
  const session = await fakeStripe.checkout.sessions.create({
    mode: "payment",
    expires_at: Math.floor((Date.now() + DAY) / 1000),
    line_items: [{ price_data: { unit_amount: 18000 }, quantity: 1 }],
    metadata: { payment_type: "balance", invoice_id: String(INVOICE_ID), invoice_number: NUMBER },
    client_reference_id: String(INVOICE_ID),
    customer_email: "alex@example.com",
  });
  return session.id;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetKit();
  _resetRateLimits();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "");
  __resetTransporter();
  mockSendMail.mockResolvedValue({});
  kit.customers.set(7, { id: 7, firstName: "Alex", lastName: "Rivera", email: "alex@example.com", phone: null, preferredLocale: "en" });
  kit.bookings.set(42, {
    id: 42,
    reference: "GFC-ACH42",
    customerId: 7,
    locale: "en",
    serviceType: "deep",
    scheduledDate: "2026-09-27",
    totalAmount: 240,
    totalAmountCents: 24000,
    depositAmount: 60,
    depositAmountCents: 6000,
    stripePaymentIntentId: "pi_deposit",
    addressLine: "1 Main St",
    city: "San Antonio",
    zip: "78201",
  });
  seedInvoice({
    id: INVOICE_ID,
    number: NUMBER,
    customerId: 7,
    bookingId: 42,
    kind: "balance",
    status: "sent",
    amount: 180,
    amountCents: 18000,
    payToken: TOKEN,
    serviceType: "deep",
    serviceDate: "2026-09-27",
    linkSentAt: new Date(Date.now() - 4 * DAY),
    linkExpiresAt: new Date(Date.now() + 3 * DAY),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

describe("ACH pending, then the customer retries", () => {
  it("reopens the first session on a revisit instead of minting a second", async () => {
    const first = await visit();
    const second = await visit();

    expect(first.statusCode).toBe(303);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("refuses a second checkout once the bank payment is processing — even before the webhook lands", async () => {
    const first = await visit();
    const sessionId = invoice().stripeSessionId!;
    expect(first.redirectUrl).toBe(`https://checkout.stripe.test/${sessionId}`);

    // She authorizes the debit. Stripe sends her back; the webhook is a minute away.
    customerPays(sessionId, "ach", "pi_ach_1");
    const retry = await visit();

    expect(retry.redirectUrl).toBeUndefined();
    expect(String(retry.body)).toContain("Your bank payment is processing");
    expect(stripeKit.createCalls).toHaveLength(1);
    // Recorded from Stripe's own word, so reminders stop without waiting on the webhook.
    expect(invoice().paymentProcessingIntentId).toBe("pi_ach_1");

    // The return page tells the truth too.
    const back = await visit({ paid: "1" });
    expect(String(back.body)).toContain("Your bank payment is processing");
    expect(String(back.body)).not.toContain("paid in full");

    // The webhook landing afterwards changes nothing.
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    expect(invoice().paymentProcessingIntentId).toBe("pi_ach_1");
    expect(invoice().status).toBe("sent");
    expect(kit.payments).toHaveLength(0);
  });

  it("stops the reminders while the payment processes, then settles it as a bank payment", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    expect(invoice().paymentProcessingAt).not.toBeNull();

    // Day 4 since the link went out: a reminder would be due, if she owed anything.
    const sweep = await sendDueBalanceReminders("https://grapefruitclean.com");
    expect(sweep.reminded).toBe(0);
    expect(invoice().reminderCount).toBe(0);
    expect(customerEmails()).toHaveLength(0);

    // The bank clears it.
    bankSettles("pi_ach_1", "succeeded");
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", sessionId));

    expect(invoice().status).toBe("paid");
    expect(invoice().paidMethod).toBe("bank");
    expect(invoice().stripePaymentIntentId).toBe("pi_ach_1");
    expect(invoice().paymentProcessingAt).toBeNull();
    expect(invoice().refundNeeded).toBe(false);
    expect(kit.payments).toHaveLength(1);
    expect(kit.payments[0]).toMatchObject({ method: "bank", stripePaymentIntentId: "pi_ach_1", amountCents: 18000, duplicate: false });
    const receipt = customerEmails().find(m => m.text.includes("Bank payment (online)"));
    expect(receipt).toBeDefined();
    expect(String((await visit()).body)).toContain("Payment received");
  });

  it("labels the settlement a bank payment when only payment_intent.succeeded reports it", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(intentEvent("payment_intent.processing", "pi_ach_1"));
    expect(invoice().paymentProcessingIntentId).toBe("pi_ach_1");

    bankSettles("pi_ach_1", "succeeded");
    await deliver(intentEvent("payment_intent.succeeded", "pi_ach_1"));

    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank", stripePaymentIntentId: "pi_ach_1" });
    expect(kit.payments[0]).toMatchObject({ method: "bank" });
    // The session family arriving afterwards is a redelivery.
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", sessionId));
    expect(kit.payments).toHaveLength(1);
  });

  it("lands Stripe's Back button on a page whose button reopens the same session", async () => {
    const first = await visit();
    const back = await visit({ cancelled: "1" });
    expect(back.redirectUrl).toBeUndefined();
    expect(String(back.body)).toContain("Your payment wasn't completed");

    const again = await visit();
    expect(again.redirectUrl).toBe(first.redirectUrl);
    expect(stripeKit.createCalls).toHaveLength(1);
  });
});

describe("ACH pending, then failed, then retry", () => {
  it("clears the state on async failure and lets the customer pay again with a fresh session", async () => {
    await visit();
    const firstSession = invoice().stripeSessionId!;
    customerPays(firstSession, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", firstSession));
    const lapsedWindow = invoice().linkExpiresAt!;

    bankSettles("pi_ach_1", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", firstSession));

    expect(invoice().paymentProcessingAt).toBeNull();
    expect(invoice().status).toBe("sent");
    // The window reopens for a full week: the failure arrives days after the payment.
    expect(invoice().linkExpiresAt!.getTime()).toBeGreaterThan(lapsedWindow.getTime());
    expect(ownerAlerts().some(a => a.title.includes("Bank payment failed") && a.content.includes("pi_ach_1"))).toBe(true);

    const retry = await visit();
    expect(retry.statusCode).toBe(303);
    const secondSession = invoice().stripeSessionId!;
    expect(secondSession).not.toBe(firstSession);
    expect(retry.redirectUrl).toBe(`https://checkout.stripe.test/${secondSession}`);
    expect(stripeKit.createCalls.map(c => c.options?.idempotencyKey)).toEqual([
      `gf-invoice-${INVOICE_ID}-${NUMBER}-checkout-1`,
      `gf-invoice-${INVOICE_ID}-${NUMBER}-checkout-2`,
    ]);
    // The failed session was marked ended BEFORE its replacement existed.
    expect(findOverlappingSessions(kit.sessionLog)).toEqual([]);
  });

  it("self-heals when the failure webhook never arrives: the next visit asks Stripe and reopens", async () => {
    await visit();
    const firstSession = invoice().stripeSessionId!;
    customerPays(firstSession, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", firstSession));
    bankSettles("pi_ach_1", "failed");

    const retry = await visit();
    expect(retry.statusCode).toBe(303);
    expect(invoice().paymentProcessingAt).toBeNull();
    expect(stripeKit.createCalls).toHaveLength(2);
  });

  it("a failure after the owner recorded the invoice paid by hand reopens nothing, and says so", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    // The owner records cash while the bank payment is still in flight.
    Object.assign(invoice(), { status: "paid", paidVia: "manual", paidMethod: "cash" });
    const window = invoice().linkExpiresAt;

    bankSettles("pi_ach_1", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", sessionId));

    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "cash", paymentProcessingAt: null });
    expect(invoice().linkExpiresAt).toEqual(window);
    const alert = ownerAlerts().at(-1)!;
    expect(alert.title).toContain("Bank payment failed on a settled invoice");
    expect(alert.content).toContain("recorded as paid by hand (cash)");
    expect(alert.content).not.toContain("open again");
    expect(String((await visit()).body)).toContain("Payment received");
  });

  it("a failure of some OTHER payment never reopens an invoice whose real payment is processing", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    stripeKit.intents.set("pi_declined", {
      id: "pi_declined",
      object: "payment_intent",
      status: "requires_payment_method",
      metadata: { payment_type: "balance", invoice_id: String(INVOICE_ID) },
    });

    await deliver(intentEvent("payment_intent.payment_failed", "pi_declined"));

    expect(invoice().paymentProcessingIntentId).toBe("pi_ach_1");
    expect(String((await visit()).body)).toContain("Your bank payment is processing");
  });
});

// ---------------------------------------------------------------------------
// Two payments on one invoice
// ---------------------------------------------------------------------------

describe("two completed sessions on one invoice", () => {
  it("records the second as a duplicate, never applies it, and names both payments to the owner", async () => {
    const s1 = await legacySession();
    const s2 = await legacySession();
    customerPays(s1, "card", "pi_A");
    customerPays(s2, "card", "pi_B");

    await deliver(sessionEvent("checkout.session.completed", s1));
    await deliver(sessionEvent("checkout.session.completed", s2));

    // The invoice is exactly what the first payment made it.
    expect(invoice()).toMatchObject({
      status: "paid",
      amount: 180,
      amountCents: 18000,
      stripePaymentIntentId: "pi_A",
      refundNeeded: true,
      lastDuplicateIntentId: "pi_B",
    });
    expect(kit.payments).toHaveLength(2);
    expect(kit.payments[0]).toMatchObject({ stripePaymentIntentId: "pi_A", duplicate: false });
    expect(kit.payments[1]).toMatchObject({ stripePaymentIntentId: "pi_B", duplicate: true, amountCents: 18000, status: "succeeded" });

    const alert = ownerAlerts().find(a => a.title.includes("REFUND NEEDED"));
    expect(alert?.title).toContain(NUMBER);
    expect(alert?.content).toContain("REFUND THIS: pi_B");
    expect(alert?.content).toContain("pi_A");

    // Redeliveries — of the session event and of the intent event — change nothing.
    const alertsBefore = ownerAlerts().length;
    await deliver(sessionEvent("checkout.session.completed", s2, "evt_redelivered"));
    await deliver(intentEvent("payment_intent.succeeded", "pi_B"));
    await deliver(intentEvent("payment_intent.succeeded", "pi_A"));
    expect(kit.payments).toHaveLength(2);
    expect(ownerAlerts()).toHaveLength(alertsBefore);

    // A THIRD payment is recorded and alerted too, not swallowed.
    const s3 = await legacySession();
    customerPays(s3, "card", "pi_C");
    await deliver(sessionEvent("checkout.session.completed", s3));
    expect(kit.payments).toHaveLength(3);
    expect(kit.payments[2]).toMatchObject({ stripePaymentIntentId: "pi_C", duplicate: true });
    expect(ownerAlerts().at(-1)?.content).toContain("REFUND THIS: pi_C");
    expect(invoice().stripePaymentIntentId).toBe("pi_A");
  });

  it("two ACH payments: the second to land while the first processes is the duplicate", async () => {
    const s1 = await legacySession();
    const s2 = await legacySession();
    customerPays(s1, "ach", "pi_A");
    customerPays(s2, "ach", "pi_B");
    await deliver(sessionEvent("checkout.session.completed", s1));
    await deliver(sessionEvent("checkout.session.completed", s2));
    expect(invoice().paymentProcessingIntentId).toBe("pi_A");

    // The second clears first.
    bankSettles("pi_B", "succeeded");
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", s2));
    expect(invoice().status).toBe("sent");
    expect(invoice().paymentProcessingIntentId).toBe("pi_A");
    expect(kit.payments).toHaveLength(1);
    expect(kit.payments[0]).toMatchObject({ stripePaymentIntentId: "pi_B", duplicate: true, method: "bank" });
    const alert = ownerAlerts().find(a => a.title.includes("REFUND NEEDED"))!;
    // While the original processes, the owner is told to WAIT, not to refund.
    expect(alert.content).toContain("REFUND ONCE THE ORIGINAL CLEARS: pi_B");
    expect(alert.content).toContain("Do NOT refund yet");
    expect(alert.content).toContain("pi_A");
    expect(alert.content).toContain("STILL PROCESSING");
    expect(alert.content).not.toContain("REFUND THIS:");

    // Then the first. It settles the invoice; the duplicate stays a duplicate,
    // and now the owner is told to refund it.
    bankSettles("pi_A", "succeeded");
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", s1));
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_A", refundNeeded: true, amountCents: 18000 });
    expect(kit.payments.filter(p => !p.duplicate)).toHaveLength(1);
    const now = ownerAlerts().at(-1)!;
    expect(now.title).toContain("REFUND NEEDED");
    expect(now.content).toContain("REFUND THIS: pi_B");
    expect(now.content).toContain("Original payment (keep): pi_A");
  });

  it("if the processing payment then fails, the duplicate that already succeeded pays the invoice", async () => {
    const s1 = await legacySession();
    const s2 = await legacySession();
    customerPays(s1, "ach", "pi_A");
    await deliver(sessionEvent("checkout.session.completed", s1));
    customerPays(s2, "card", "pi_B");
    await deliver(sessionEvent("checkout.session.completed", s2));
    expect(invoice().lastDuplicateIntentId).toBe("pi_B");

    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));

    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_B", refundNeeded: false, lastDuplicateIntentId: null });
    expect(kit.payments.find(p => p.stripePaymentIntentId === "pi_B")?.duplicate).toBe(false);
    expect(ownerAlerts().some(a => a.title.includes("DO NOT refund pi_B"))).toBe(true);
    // And no retry is offered — she has paid.
    expect(String((await visit()).body)).toContain("Payment received");
  });

  it("a card payment landing while an ACH payment processes is refused the invoice", async () => {
    await visit();
    const live = invoice().stripeSessionId!;
    customerPays(live, "ach", "pi_A");
    await deliver(sessionEvent("checkout.session.completed", live));
    const stale = await legacySession();
    customerPays(stale, "card", "pi_B");

    await deliver(sessionEvent("checkout.session.completed", stale));

    expect(invoice().status).toBe("sent");
    expect(invoice().paymentProcessingIntentId).toBe("pi_A");
    expect(kit.payments[0]).toMatchObject({ stripePaymentIntentId: "pi_B", duplicate: true, method: "card" });
  });
});

// ---------------------------------------------------------------------------
// The card path
// ---------------------------------------------------------------------------

describe("the card path is unchanged", () => {
  it("settles at once with the same receipt, owner notice and one payment row", async () => {
    const opened = await visit();
    expect(opened.statusCode).toBe(303);
    const sessionId = invoice().stripeSessionId!;
    const { params, options } = stripeKit.createCalls[0]!;
    expect(params.success_url).toBe(`https://grapefruitclean.com/api/pay/balance/${TOKEN}?paid=1`);
    expect(params.cancel_url).toBe(`https://grapefruitclean.com/api/pay/balance/${TOKEN}?cancelled=1`);
    expect(params.payment_intent_data).toEqual({
      metadata: { payment_type: "balance", invoice_id: String(INVOICE_ID), invoice_number: NUMBER },
    });
    expect(options?.idempotencyKey).toBe(`gf-invoice-${INVOICE_ID}-${NUMBER}-checkout-1`);
    expect(Number(params.expires_at) * 1000 - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(invoice().stripeSessionExpiresAt?.getTime()).toBe(Number(params.expires_at) * 1000);

    customerPays(sessionId, "card", "pi_card");
    await deliver(sessionEvent("checkout.session.completed", sessionId));

    expect(invoice()).toMatchObject({ status: "paid", paidVia: "stripe", paidMethod: "card", stripePaymentIntentId: "pi_card" });
    expect(kit.payments).toHaveLength(1);
    expect(kit.payments[0]).toMatchObject({ method: "card", kind: "balance", amountCents: 18000, duplicate: false });
    expect(ownerAlerts().filter(a => a.title.startsWith("Balance paid"))).toHaveLength(1);
    expect(customerEmails().some(m => m.text.includes("Card (online)"))).toBe(true);

    // The intent's own success event, and the return page, are no-ops.
    await deliver(intentEvent("payment_intent.succeeded", "pi_card"));
    expect(kit.payments).toHaveLength(1);
    expect(String((await visit({ paid: "1" })).body)).toContain("Payment received");
    expect(String((await visit()).body)).toContain("Payment received");
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("the return page settles a card payment the webhook has not delivered yet — exactly once", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "card", "pi_card");

    const back = await visit({ paid: "1" });
    expect(String(back.body)).toContain("Payment received");
    expect(invoice().status).toBe("paid");

    await deliver(sessionEvent("checkout.session.completed", sessionId));
    expect(kit.payments).toHaveLength(1);
    expect(ownerAlerts().filter(a => a.title.startsWith("Balance paid"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Races and outages
// ---------------------------------------------------------------------------

describe("racing visits", () => {
  it("two simultaneous first visits mint exactly one session and both reach it", async () => {
    const [a, b] = await Promise.all([visit(), visit()]);
    expect(a.statusCode).toBe(303);
    expect(b.statusCode).toBe(303);
    expect(a.redirectUrl).toBe(b.redirectUrl);
    expect(stripeKit.createCalls).toHaveLength(1);
    expect(findOverlappingSessions(kit.sessionLog)).toEqual([]);
  });

  it("a Stripe outage while minting gives the attempt back, so the next visit can mint", async () => {
    stripeKit.failCreates = 1;
    const failed = await visit();
    expect(failed.statusCode).toBe(500);
    expect(invoice().checkoutClaimedAt).toBeNull();

    const retry = await visit();
    expect(retry.statusCode).toBe(303);
    expect(stripeKit.createCalls.map(c => c.options?.idempotencyKey)).toEqual([
      `gf-invoice-${INVOICE_ID}-${NUMBER}-checkout-1`,
      `gf-invoice-${INVOICE_ID}-${NUMBER}-checkout-2`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round two: what the adversarial review found
// ---------------------------------------------------------------------------

describe("stale and out-of-order events: Stripe's live status decides", () => {
  it("a late 'failed' for a card declined earlier in the same checkout never reopens the live bank payment", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    // Card declined, then ACH — one PaymentIntent for both, as Checkout does it.
    customerPays(sessionId, "ach", "pi_shared");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    const alertsBefore = ownerAlerts().length;

    await deliver(intentEvent("payment_intent.payment_failed", "pi_shared", "evt_late_decline"));

    expect(invoice().paymentProcessingIntentId).toBe("pi_shared");
    expect(ownerAlerts()).toHaveLength(alertsBefore);
    expect(customerEmails()).toHaveLength(0);
  });

  it("a late 'completed unpaid' for a payment that has since failed marks nothing", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_dead");
    bankSettles("pi_dead", "failed");

    await deliver(sessionEvent("checkout.session.completed", sessionId));

    expect(invoice().paymentProcessingAt).toBeNull();
    expect((await visit()).statusCode).toBe(303);
  });

  it("a late 'processing' for a payment that has since cleared settles it, as a bank payment", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_fast");
    bankSettles("pi_fast", "succeeded");

    await deliver(intentEvent("payment_intent.processing", "pi_fast"));

    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank", stripePaymentIntentId: "pi_fast" });
  });

  it("still calls it a bank payment when Stripe cannot be read at settlement, because it went through processing", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    bankSettles("pi_ach_1", "succeeded");
    const spy = vi.spyOn(fakeStripe.paymentIntents, "retrieve").mockRejectedValue(new Error("Stripe timeout"));

    await deliver(intentEvent("payment_intent.succeeded", "pi_ach_1"));

    spy.mockRestore();
    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank" });
  });

  it("names the method from Stripe's charge when the pay link is the first to see an ACH payment land", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_quiet");
    bankSettles("pi_quiet", "succeeded"); // no webhook ever arrived

    expect(String((await visit()).body)).toContain("Payment received");
    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank" });
    expect(customerEmails().some(m => m.text.includes("Bank payment (online)"))).toBe(true);
  });
});

describe("a failed bank payment after a duplicate", () => {
  it("never promotes a duplicate the owner already refunded — the invoice reopens and the owner is told why", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    const s1 = await legacySession();
    const s2 = await legacySession();
    customerPays(s1, "ach", "pi_A");
    await deliver(sessionEvent("checkout.session.completed", s1));
    customerPays(s2, "card", "pi_B");
    await deliver(sessionEvent("checkout.session.completed", s2));
    stripeKit.intents.get("pi_B")!.refunded = true; // the owner refunded it in Stripe

    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));

    expect(invoice()).toMatchObject({ status: "sent", paymentProcessingAt: null, refundNeeded: false, lastDuplicateIntentId: null });
    expect(kit.payments.find(p => p.stripePaymentIntentId === "pi_B")).toMatchObject({ status: "refunded", duplicate: true });
    const alert = ownerAlerts().at(-1)!;
    expect(alert.title).toContain("Bank payment failed");
    expect(alert.content).toContain("pi_B had already been refunded");
    expect(ownerAlerts().some(a => a.title.includes("DO NOT refund"))).toBe(false);
    expect(customerEmails().some(m => m.subject.includes("didn't go through"))).toBe(true);
  });
});

describe("a failed bank payment reaches the customer", () => {
  it("restarts the reminder sequence and emails the customer their link, even after both reminders were used", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    Object.assign(invoice(), { reminderCount: 2, lastReminderAt: new Date(), reminderExhaustedAlertAt: new Date() });
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));

    bankSettles("pi_ach_1", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", sessionId));

    expect(invoice()).toMatchObject({ reminderCount: 0, lastReminderAt: null, reminderExhaustedAlertAt: null });
    expect(Date.now() - invoice().linkSentAt!.getTime()).toBeLessThan(60_000);
    const email = customerEmails().find(m => m.subject.includes("didn't go through"))!;
    expect(email.text).toContain(`https://grapefruitclean.com/api/pay/balance/${TOKEN}`);
    expect(email.text).toContain("nothing was taken");
    expect(email.text).not.toContain(NUMBER);
    expect(ownerAlerts().at(-1)!.content).toContain("The customer has been emailed");
  });
});

describe("microdeposit verification", () => {
  it("tells a customer who must confirm microdeposits what to do — never 'nothing else to do'", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach_microdeposits", "pi_micro");

    for (const query of [{}, { paid: "1" }]) {
      const body = String((await visit(query)).body);
      expect(body).toContain("Almost done — verify your bank account");
      expect(body).not.toContain("There&#39;s nothing else to do".replace("&#39;", "'"));
    }
    expect(invoice().paymentProcessingIntentId).toBe("pi_micro");
    expect(stripeKit.createCalls).toHaveLength(1);
  });
});

describe("invoices last touched by the old per-visit code", () => {
  /** The pre-deploy shape: several sessions on Stripe, the invoice pointing at the newest only. */
  async function legacyInvoice(): Promise<{ older: string; stored: string }> {
    const older = await legacySession();
    const stored = await legacySession();
    Object.assign(invoice(), { stripeSessionId: stored, checkoutAttempt: 0 });
    return { older, stored };
  }

  it("finds a bank payment in flight on a session the invoice no longer points at — and refuses a new checkout", async () => {
    const { older, stored } = await legacyInvoice();
    customerPays(older, "ach", "pi_legacy");

    const res = await visit();

    expect(String(res.body)).toContain("Your bank payment is processing");
    expect(invoice().paymentProcessingIntentId).toBe("pi_legacy");
    expect(stripeKit.createCalls.filter(c => c.options?.idempotencyKey)).toHaveLength(0);
    // The stray open session is closed, so it cannot take a second payment either.
    expect(stripeKit.sessions.get(stored)!.status).toBe("expired");
  });

  it("records a payment that landed on an older session, then treats any later one as a duplicate", async () => {
    const { older, stored } = await legacyInvoice();
    customerPays(older, "ach", "pi_first");
    bankSettles("pi_first", "succeeded");
    customerPays(stored, "card", "pi_second");

    expect(String((await visit()).body)).toContain("Payment received");
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_first", refundNeeded: true, lastDuplicateIntentId: "pi_second" });
  });

  it("closes the old code's stray sessions but reopens the stored one a customer may be paying in", async () => {
    const { older, stored } = await legacyInvoice();

    const res = await visit();

    expect(res.statusCode).toBe(303);
    expect(stripeKit.sessions.get(older)!.status).toBe("expired");
    expect(stripeKit.sessions.get(stored)!.status).toBe("open");
    expect(res.redirectUrl).toBe(`https://checkout.stripe.test/${stored}`);
    expect(stripeKit.createCalls).toHaveLength(2); // only the two legacy sessions this test made
  });

  it("mints the first tracked session once the stored one has lapsed", async () => {
    const { older, stored } = await legacyInvoice();
    stripeKit.sessions.get(stored)!.status = "expired";

    const res = await visit();

    expect(res.statusCode).toBe(303);
    expect(stripeKit.sessions.get(older)!.status).toBe("expired");
    expect(invoice().checkoutAttempt).toBe(1);
    expect(stripeKit.createCalls.at(-1)!.params.metadata).toMatchObject({ checkout_attempt: "1" });
  });

  it("finds the old payment even when a resend moved linkSentAt past it (scan from the invoice's creation)", async () => {
    const { older } = await legacyInvoice();
    customerPays(older, "ach", "pi_before_resend");
    bankSettles("pi_before_resend", "succeeded");
    stripeKit.sessions.get(older)!.created -= 6 * 24 * 3600; // six days before…
    Object.assign(invoice(), { linkSentAt: new Date(), createdAt: new Date(Date.now() - 8 * DAY) }); // …the resend

    expect(String((await visit()).body)).toContain("Payment received");
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_before_resend" });
    // Narrowed to this customer's completed sessions, not the whole account.
    expect(stripeKit.listCalls[0]).toMatchObject({ status: "complete", customer_details: { email: "alex@example.com" } });
  });

  it("never settles with a payment the owner already refunded — the next unrefunded one settles", async () => {
    const { older, stored } = await legacyInvoice();
    customerPays(older, "ach", "pi_refunded");
    bankSettles("pi_refunded", "succeeded");
    stripeKit.intents.get("pi_refunded")!.refunded = true;
    customerPays(stored, "ach", "pi_kept");
    bankSettles("pi_kept", "succeeded");

    expect(String((await visit()).body)).toContain("Payment received");
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_kept", refundNeeded: false });
    expect(kit.payments.map(p => p.stripePaymentIntentId)).toEqual(["pi_kept"]);
  });

  it("tells the owner when more than one bank payment is in flight, and waits on the first", async () => {
    const { older, stored } = await legacyInvoice();
    customerPays(older, "ach", "pi_one");
    customerPays(stored, "ach", "pi_two");

    expect(String((await visit()).body)).toContain("Your bank payment is processing");
    expect(invoice().paymentProcessingIntentId).toBe("pi_one");
    const alert = ownerAlerts().find(a => a.title.includes("More than one bank payment in flight"))!;
    expect(alert.content).toContain("pi_one");
    expect(alert.content).toContain("pi_two");
  });

  it("when the first in-flight payment fails, the second takes over — the customer is not told to pay again", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    const { older, stored } = await legacyInvoice();
    customerPays(older, "ach", "pi_one");
    customerPays(stored, "ach", "pi_two");
    await visit();
    mockSendMail.mockClear();

    bankSettles("pi_one", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", older));

    expect(invoice().paymentProcessingIntentId).toBe("pi_two");
    expect(customerEmails().some(m => m.subject.includes("didn't go through"))).toBe(false);
    expect(ownerAlerts().at(-1)!.title).toContain("another payment covers it");
  });
});

describe("round three: refunded money never settles, every held duplicate counts", () => {
  /** ACH A in flight on one stray session; card duplicates on others — the legacy shape, set up through real events. */
  async function processingWithDuplicates(cards: string[]): Promise<string> {
    const s1 = await legacySession();
    customerPays(s1, "ach", "pi_A");
    await deliver(sessionEvent("checkout.session.completed", s1));
    for (const id of cards) {
      const s = await legacySession();
      customerPays(s, "card", id);
      await deliver(sessionEvent("checkout.session.completed", s));
    }
    return s1;
  }

  it("a duplicate the owner refunded never settles the reopened invoice — not by the link, not by a late event", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    const s1 = await processingWithDuplicates(["pi_X"]);
    Object.assign(invoice(), { stripeSessionId: s1, checkoutAttempt: 0 }); // pointer on a legacy session
    stripeKit.intents.get("pi_X")!.refunded = true;
    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));
    expect(invoice().status).toBe("sent");

    await visit(); // the legacy scan sees pi_X's session still reading "paid"
    await deliver(intentEvent("payment_intent.succeeded", "pi_X", "evt_late_redelivery"));
    expect(await applyBalancePayment(INVOICE_ID, "pi_X")).toEqual({ outcome: "refunded" });

    expect(invoice().status).toBe("sent");
    expect(invoice().stripePaymentIntentId).toBeNull();
    expect(kit.payments.filter(p => p.stripePaymentIntentId === "pi_X")).toHaveLength(1);
  });

  it("a recorded duplicate never settles the invoice by the back door, even when Stripe cannot be read", async () => {
    await processingWithDuplicates(["pi_X"]);
    Object.assign(invoice(), { paymentProcessingAt: null, paymentProcessingIntentId: null }); // reopened by hand
    const spy = vi.spyOn(fakeStripe.paymentIntents, "retrieve").mockRejectedValue(new Error("Stripe down"));
    const result = await applyBalancePayment(INVOICE_ID, "pi_X");
    spy.mockRestore();
    expect(result).toEqual({ outcome: "duplicate" });
    expect(invoice().status).toBe("sent");
  });

  it("promotion looks at every held duplicate: the owner refunded the newest, the older one pays", async () => {
    const s1 = await processingWithDuplicates(["pi_X1", "pi_X2"]);
    stripeKit.intents.get("pi_X2")!.refunded = true;
    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_X1" });
    expect(kit.payments.find(p => p.stripePaymentIntentId === "pi_X2")).toMatchObject({ status: "refunded" });
  });

  it("after the original clears, the owner is told to refund EVERY held duplicate", async () => {
    const s1 = await processingWithDuplicates(["pi_X1", "pi_X2"]);
    const before = ownerAlerts().length;
    bankSettles("pi_A", "succeeded");
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", s1));
    const refundNow = ownerAlerts().slice(before).filter(a => a.content.includes("REFUND THIS:"));
    expect(refundNow.map(a => a.content.match(/REFUND THIS: (\S+)/)![1]).sort()).toEqual(["pi_X1", "pi_X2"]);
  });

  it("a part-refunded or disputed duplicate is left to the owner — no promotion, and the customer is not told to pay again", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    const s1 = await processingWithDuplicates(["pi_X"]);
    stripeKit.intents.get("pi_X")!.disputed = true;
    mockSendMail.mockClear();
    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));

    expect(invoice()).toMatchObject({ status: "sent", paymentProcessingAt: null });
    expect(customerEmails().some(m => m.subject.includes("didn't go through"))).toBe(false);
    expect(ownerAlerts().at(-1)!.title).toContain("check the duplicate by hand");
  });

  it("a void invoice whose bank payment fails tells the owner to refund the duplicate it still holds", async () => {
    const s1 = await processingWithDuplicates(["pi_X"]);
    Object.assign(invoice(), { status: "void" });
    bankSettles("pi_A", "failed");
    await deliver(sessionEvent("checkout.session.async_payment_failed", s1));
    expect(ownerAlerts().at(-1)!.content).toContain("Refund now (held duplicates on this invoice): pi_X");
  });

  it("closes the old code's open sessions while a pre-deploy invoice's payment is processing", async () => {
    const stray = await legacySession();
    const paying = await legacySession();
    customerPays(paying, "ach", "pi_A");
    Object.assign(invoice(), { stripeSessionId: paying, checkoutAttempt: 0, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_A" });

    expect(String((await visit()).body)).toContain("Your bank payment is processing");
    expect(stripeKit.sessions.get(stray)!.status).toBe("expired");
  });
});

describe("Check with Stripe — the owner's sync", () => {
  it("records a bank payment the webhook never reported, with no email to the customer", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    bankSettles("pi_ach_1", "succeeded");
    mockSendMail.mockClear();

    expect(await syncInvoiceWithStripe(INVOICE_ID, "https://grapefruitclean.com")).toEqual({ outcome: "checked", state: "paid" });
    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank" });
    expect(customerEmails().some(m => m.subject.includes("Your cleaning is complete"))).toBe(false);
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("never mints a checkout — an untouched invoice reads 'none'", async () => {
    expect(await syncInvoiceWithStripe(INVOICE_ID, "https://grapefruitclean.com")).toEqual({ outcome: "checked", state: "none" });
    expect(stripeKit.createCalls).toHaveLength(0);
  });
});

describe("Resend is the owner's sync", () => {
  it("records a bank payment the webhook never reported, and sends nothing", async () => {
    await visit();
    const sessionId = invoice().stripeSessionId!;
    customerPays(sessionId, "ach", "pi_ach_1");
    await deliver(sessionEvent("checkout.session.completed", sessionId));
    bankSettles("pi_ach_1", "succeeded"); // async_payment_succeeded never delivered
    mockSendMail.mockClear();

    const result = await resendBalanceLink(INVOICE_ID, "https://grapefruitclean.com");

    expect(result.outcome).toBe("already_paid");
    expect(invoice()).toMatchObject({ status: "paid", paidMethod: "bank" });
    expect(customerEmails().some(m => m.subject.includes("Your cleaning is complete"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The daily check, on the incident's own shape
// ---------------------------------------------------------------------------

describe("the daily payments check on a double charge", () => {
  it("flags both payments from Stripe's record even when the app recorded neither — and stops once refunded", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    // The pre-fix shape: two sessions, two ACH debits, no webhook ever recorded either.
    const s1 = await legacySession();
    const s2 = await legacySession();
    customerPays(s1, "ach", "pi_A");
    customerPays(s2, "ach", "pi_B");
    bankSettles("pi_A", "succeeded");
    bankSettles("pi_B", "succeeded");
    for (const s of [s1, s2]) stripeKit.sessions.get(s)!.created -= 2 * 60 * 60; // past the webhook grace

    const findings = await inspectPaymentIntegrity(new Date());
    expect(findings.paymentInspectionError).toBeNull();
    expect(findings.duplicatePayments).toEqual([
      {
        invoiceId: INVOICE_ID,
        invoiceNumber: NUMBER,
        payments: expect.arrayContaining([
          { intentId: "pi_A", state: "succeeded" },
          { intentId: "pi_B", state: "succeeded" },
        ]),
      },
    ]);
    // The invoice still reads unpaid while Stripe holds the money: both are unrecorded.
    expect(findings.unrecordedStripePayments.map(u => u.intentId).sort()).toEqual(["pi_A", "pi_B"]);

    // The owner refunds the duplicate in Stripe: it stops being reported.
    stripeKit.intents.get("pi_B")!.refunded = true;
    const after = await inspectPaymentIntegrity(new Date());
    expect(after.duplicatePayments).toEqual([]);
  });
});
