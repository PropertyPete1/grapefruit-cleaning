/**
 * The one-live-session state machine (invoiceCheckout.ts), case by case: what
 * Stripe's record of the invoice's current session makes it do, and the edges
 * the end-to-end replay (achDoubleCharge.test.ts) does not reach.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", async () => (await import("./paymentTestKit")).fakeDb);
vi.mock("./stripe", async () => {
  const { fakeStripe } = await import("./paymentTestKit");
  return { getStripe: () => fakeStripe };
});

import {
  CHECKOUT_REUSE_MARGIN_MS,
  checkoutIdempotencyKey,
  classifySession,
  openInvoiceCheckout,
  paymentIntentState,
  type CheckoutHooks,
} from "./invoiceCheckout";
import { customerPays, fakeStripe, kit, resetKit, seedInvoice, stripeKit } from "./paymentTestKit";

const INVOICE_ID = 77;
const invoice = () => kit.invoices.get(INVOICE_ID)!;

const onPaymentSucceeded = vi.fn();
const onPaymentFailed = vi.fn();

/** Mints through the fake Stripe exactly as balance.ts would: the attempt's expiry and key go through. */
function hooks(amountCents = 12000): CheckoutHooks {
  return {
    mint: ({ invoice: row, expiresAt, idempotencyKey }) =>
      fakeStripe.checkout.sessions.create(
        {
          mode: "payment",
          expires_at: Math.floor(expiresAt.getTime() / 1000),
          line_items: [{ price_data: { unit_amount: amountCents }, quantity: 1 }],
          metadata: { payment_type: "balance", invoice_id: String(row.id) },
        },
        { idempotencyKey }
      ) as never,
    onPaymentSucceeded,
    onPaymentFailed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The real hook settles the invoice; the stand-in does just that, so the
  // machine's "believe the invoice" re-read sees it.
  onPaymentSucceeded.mockImplementation(async (id: number, intentId: string | null) => {
    Object.assign(kit.invoices.get(id)!, { status: "paid", stripePaymentIntentId: intentId, paymentProcessingAt: null, paymentProcessingIntentId: null });
  });
  resetKit();
  seedInvoice({ id: INVOICE_ID, number: "INV-SM-1", customerId: 1, amount: 120, amountCents: 12000, payToken: "tok" });
});

describe("classifying a session", () => {
  const base = { url: null, expires_at: 2_000_000_000, amount_total: 12000 };
  it("open is open, with its url and expiry", () => {
    expect(classifySession({ ...base, status: "open", payment_status: "unpaid", payment_intent: null, url: "u" })).toEqual({
      kind: "open",
      url: "u",
      expiresAtMs: 2_000_000_000_000,
      amountTotal: 12000,
    });
  });
  it("complete + paid is paid", () => {
    expect(classifySession({ ...base, status: "complete", payment_status: "paid", payment_intent: "pi_1" })).toEqual({
      kind: "paid",
      paymentIntentId: "pi_1",
    });
  });
  it("complete + unpaid is processing — including microdeposit verification (requires_action)", () => {
    for (const status of ["processing", "requires_action"]) {
      const view = classifySession({
        ...base,
        status: "complete",
        payment_status: "unpaid",
        payment_intent: { id: "pi_1", status } as never,
      });
      expect(view).toMatchObject({ kind: "processing", paymentIntentId: "pi_1" });
    }
    const verifying = classifySession({
      ...base,
      status: "complete",
      payment_status: "unpaid",
      payment_intent: { id: "pi_1", status: "requires_action", next_action: { type: "verify_with_microdeposits" } } as never,
    });
    expect(verifying).toEqual({ kind: "processing", paymentIntentId: "pi_1", awaitingVerification: true });
  });
  it("complete + unpaid with an unreadable intent errs on the side of processing", () => {
    expect(classifySession({ ...base, status: "complete", payment_status: "unpaid", payment_intent: "pi_1" }).kind).toBe("processing");
  });
  it("complete + unpaid with a failed intent is failed (a retry is allowed)", () => {
    const view = classifySession({
      ...base,
      status: "complete",
      payment_status: "unpaid",
      payment_intent: { id: "pi_1", status: "requires_payment_method" } as never,
    });
    expect(view).toEqual({ kind: "failed", paymentIntentId: "pi_1" });
  });
  it("maps every intent status the app cares about", () => {
    expect(paymentIntentState("succeeded")).toBe("succeeded");
    expect(paymentIntentState("canceled")).toBe("failed");
    expect(paymentIntentState("requires_action")).toBe("processing");
    expect(paymentIntentState(undefined)).toBe("unknown");
  });
});

describe("the idempotency key", () => {
  it("is derived from the invoice id, its unique number and the attempt — and holds no customer data", () => {
    expect(checkoutIdempotencyKey({ id: 77, number: "INV-SM-1" }, 3)).toBe("gf-invoice-77-INV-SM-1-checkout-3");
  });
  it("is what Stripe sees, with an expiry fixed by the claim, so a replay of the same attempt returns the same session", async () => {
    const opened = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(opened.kind).toBe("redirect");
    const { params, options } = stripeKit.createCalls[0]!;
    expect(options?.idempotencyKey).toBe("gf-invoice-77-INV-SM-1-checkout-1");
    // Replaying the identical request returns the same session rather than a second one.
    const replay = await fakeStripe.checkout.sessions.create(params, options);
    expect(replay.id).toBe(invoice().stripeSessionId);
    expect(stripeKit.sessions.size).toBe(1);
  });
});

describe("openInvoiceCheckout", () => {
  it("mints once, stores the session and its expiry, and logs it", async () => {
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toMatchObject({ kind: "redirect", reused: false });
    expect(invoice().checkoutAttempt).toBe(1);
    expect(invoice().stripeSessionId).toBe("cs_test_1");
    expect(invoice().stripeSessionExpiresAt).toBeInstanceOf(Date);
    expect(kit.sessionLog).toHaveLength(1);
  });

  it("reopens an open session with time to spare", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    const again = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(again).toMatchObject({ kind: "redirect", reused: true, sessionId: "cs_test_1" });
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("closes a session about to lapse BEFORE minting its replacement", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    stripeKit.sessions.get("cs_test_1")!.expires_at = Math.floor((Date.now() + CHECKOUT_REUSE_MARGIN_MS / 2) / 1000);

    const result = await openInvoiceCheckout(INVOICE_ID, hooks());

    expect(result).toMatchObject({ kind: "redirect", reused: false, sessionId: "cs_test_2" });
    expect(stripeKit.expireCalls).toEqual(["cs_test_1"]);
    expect(stripeKit.sessions.get("cs_test_1")!.status).toBe("expired");
    const first = kit.sessionLog.find(r => r.stripeSessionId === "cs_test_1")!;
    const second = kit.sessionLog.find(r => r.stripeSessionId === "cs_test_2")!;
    expect(first.endReason).toBe("closed");
    expect(first.endedAt!.getTime()).toBeLessThanOrEqual(second.createdAt.getTime());
  });

  it("does not mint over a session that completed while it was being closed", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    stripeKit.sessions.get("cs_test_1")!.expires_at = Math.floor((Date.now() + 60_000) / 1000);
    // The customer pays by bank in the instant before the close lands.
    const realExpire = fakeStripe.checkout.sessions.expire;
    const spy = vi.spyOn(fakeStripe.checkout.sessions, "expire").mockImplementationOnce(async id => {
      customerPays(id, "ach", "pi_race");
      return realExpire(id);
    });

    const result = await openInvoiceCheckout(INVOICE_ID, hooks());

    spy.mockRestore();
    expect(result).toMatchObject({ kind: "processing", paymentIntentId: "pi_race" });
    expect(stripeKit.createCalls).toHaveLength(1);
    expect(invoice().paymentProcessingIntentId).toBe("pi_race");
  });

  it("replaces, never reopens, a live session that charges a different amount", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks(12000));
    const result = await openInvoiceCheckout(INVOICE_ID, hooks(15000), { expectedAmountCents: 15000 });
    expect(result).toMatchObject({ kind: "redirect", reused: false, sessionId: "cs_test_2" });
    expect(stripeKit.sessions.get("cs_test_1")!.status).toBe("expired");
  });

  it("reports paid (and settles) when the stored session was paid", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    customerPays("cs_test_1", "card", "pi_card");
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toEqual({ kind: "paid" });
    expect(onPaymentSucceeded).toHaveBeenCalledWith(INVOICE_ID, "pi_card");
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("never reports paid when settlement refused the payment — the session is treated as gone", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    customerPays("cs_test_1", "card", "pi_refunded");
    onPaymentSucceeded.mockImplementationOnce(async () => undefined); // refused: refunded, or already in the ledger
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toMatchObject({ kind: "redirect", reused: false, sessionId: "cs_test_2" });
    expect(kit.sessionLog.find(r => r.stripeSessionId === "cs_test_1")!.endReason).toBe("refunded");
  });

  it("asks Stripe about a processing payment and settles it once the bank has cleared it", async () => {
    seedInvoice({ ...invoice(), paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    stripeKit.intents.set("pi_ach", { id: "pi_ach", object: "payment_intent", status: "succeeded", metadata: {} });
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toEqual({ kind: "paid" });
    expect(onPaymentSucceeded).toHaveBeenCalledWith(INVOICE_ID, "pi_ach");
  });

  it("keeps refusing while Stripe cannot be reached about a processing payment", async () => {
    seedInvoice({ ...invoice(), paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_unknown" });
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toMatchObject({ kind: "processing", paymentIntentId: "pi_unknown" });
    expect(stripeKit.createCalls).toHaveLength(0);
  });

  it("replaces a session Stripe has never heard of", async () => {
    seedInvoice({ ...invoice(), stripeSessionId: "cs_from_another_mode" });
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toMatchObject({ kind: "redirect", reused: false });
  });

  it("never mints blind when Stripe cannot say what the stored session is", async () => {
    await openInvoiceCheckout(INVOICE_ID, hooks());
    const spy = vi.spyOn(fakeStripe.checkout.sessions, "retrieve").mockRejectedValueOnce(new Error("Stripe timeout"));
    await expect(openInvoiceCheckout(INVOICE_ID, hooks())).rejects.toThrow("Stripe timeout");
    spy.mockRestore();
    expect(stripeKit.createCalls).toHaveLength(1);
  });

  it("look-only mode never creates anything", async () => {
    expect(await openInvoiceCheckout(INVOICE_ID, hooks(), { mint: false })).toEqual({ kind: "none" });
    expect(stripeKit.createCalls).toHaveLength(0);
    expect(invoice().checkoutAttempt).toBe(0);
  });

  it("refuses paid and void invoices outright", async () => {
    seedInvoice({ ...invoice(), status: "paid" });
    expect(await openInvoiceCheckout(INVOICE_ID, hooks())).toEqual({ kind: "paid" });
    seedInvoice({ ...invoice(), status: "void" });
    expect(await openInvoiceCheckout(INVOICE_ID, hooks())).toEqual({ kind: "closed" });
    expect(stripeKit.createCalls).toHaveLength(0);
  });

  it("waits out a fresh claim held by another visit rather than minting a second session", async () => {
    // Another request claimed attempt 1 a moment ago and is still talking to Stripe.
    seedInvoice({ ...invoice(), checkoutAttempt: 1, checkoutClaimedAt: new Date() });
    const sleep = vi.fn(async () => undefined);
    const result = await openInvoiceCheckout(INVOICE_ID, hooks(), { sleep });
    expect(result).toEqual({ kind: "busy" });
    expect(sleep).toHaveBeenCalled();
    expect(stripeKit.createCalls).toHaveLength(0);
  });

  it("claims anew once an abandoned claim's lease has run out", async () => {
    seedInvoice({ ...invoice(), checkoutAttempt: 1, checkoutClaimedAt: new Date(Date.now() - 5 * 60_000) });
    const result = await openInvoiceCheckout(INVOICE_ID, hooks());
    expect(result).toMatchObject({ kind: "redirect" });
    expect(stripeKit.createCalls[0]!.options?.idempotencyKey).toBe("gf-invoice-77-INV-SM-1-checkout-2");
  });

  it("closes its own session and sends no one to it when the invoice was paid while Stripe was answering", async () => {
    const paidMeanwhile: CheckoutHooks = {
      ...hooks(),
      mint: async args => {
        const session = await hooks().mint(args);
        Object.assign(kit.invoices.get(INVOICE_ID)!, { status: "paid", paidVia: "manual", paidMethod: "cash" });
        return session;
      },
    };
    const result = await openInvoiceCheckout(INVOICE_ID, paidMeanwhile);
    expect(result).toEqual({ kind: "paid" });
    expect(stripeKit.sessions.get("cs_test_1")!.status).toBe("expired");
    expect(invoice().stripeSessionId).toBeNull();
  });

  it("closes its own session when a newer attempt took over while Stripe was answering", async () => {
    const takeover: CheckoutHooks = {
      ...hooks(),
      mint: async args => {
        const session = await hooks().mint(args);
        if (args.attempt === 1) {
          // Meanwhile another request (after the lease) claimed attempt 2 and stored its own session.
          const theirs = await hooks().mint({ ...args, attempt: 2, idempotencyKey: "theirs" });
          Object.assign(kit.invoices.get(INVOICE_ID)!, { checkoutAttempt: 2, stripeSessionId: theirs.id });
        }
        return session;
      },
    };
    const result = await openInvoiceCheckout(INVOICE_ID, takeover, { sleep: async () => undefined });
    expect(stripeKit.sessions.get("cs_test_1")!.status).toBe("expired");
    expect(kit.sessionLog.find(r => r.stripeSessionId === "cs_test_1")!.endReason).toBe("superseded");
    // The newer attempt's session stands, and this visit is sent to it.
    expect(result).toMatchObject({ kind: "redirect", reused: true, sessionId: "cs_test_2" });
  });
});
