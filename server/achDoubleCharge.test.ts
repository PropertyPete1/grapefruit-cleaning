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
import { sendDueBalanceReminders } from "./balance";
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
    expect(alert.content).toContain("REFUND THIS: pi_B");
    expect(alert.content).toContain("pi_A");
    expect(alert.content).toContain("STILL PROCESSING");

    // Then the first. It settles the invoice; the duplicate stays a duplicate.
    bankSettles("pi_A", "succeeded");
    await deliver(sessionEvent("checkout.session.async_payment_succeeded", s1));
    expect(invoice()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_A", refundNeeded: true, amountCents: 18000 });
    expect(kit.payments.filter(p => !p.duplicate)).toHaveLength(1);
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
