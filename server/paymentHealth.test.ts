/**
 * The daily payments check (paymentHealth.ts) on its own: overlap detection
 * from the app's session history, Stripe's record held up against the app's,
 * and the guards against crying wolf (refunded duplicates, fresh payments
 * ahead of their webhook, invoices someone already reconciled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", async () => (await import("./paymentTestKit")).fakeDb);
vi.mock("./stripe", async () => {
  const { fakeStripe } = await import("./paymentTestKit");
  return { getStripe: () => fakeStripe };
});

import {
  findOverlappingSessions,
  formatPaymentFindings,
  inspectPaymentIntegrity,
  paymentProblemCount,
  sessionPaymentState,
} from "./paymentHealth";
import { bankSettles, customerPays, fakeStripe, kit, resetKit, seedInvoice, stripeKit } from "./paymentTestKit";

const HOUR = 3_600_000;
const t = (h: number) => new Date(Date.UTC(2026, 9, 1) + h * HOUR);

async function stripeSession(invoiceId: number, ageHours = 3): Promise<string> {
  const session = await fakeStripe.checkout.sessions.create({
    expires_at: Math.floor((Date.now() + 20 * HOUR) / 1000),
    line_items: [{ price_data: { unit_amount: 9000 }, quantity: 1 }],
    metadata: { payment_type: "balance", invoice_id: String(invoiceId), invoice_number: `INV-${invoiceId}` },
  });
  stripeKit.sessions.get(session.id)!.created -= ageHours * 3600;
  return session.id;
}

beforeEach(() => {
  resetKit();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  seedInvoice({ id: 9, number: "INV-9", customerId: 1, amount: 90, amountCents: 9000, payToken: "t9" });
});
afterEach(() => vi.unstubAllEnvs());

describe("overlapping sessions in the app's history", () => {
  const row = (id: string, created: number, expires: number, ended: number | null = null) => ({
    invoiceId: 9,
    invoiceNumber: "INV-9",
    stripeSessionId: id,
    createdAt: t(created),
    expiresAt: t(expires),
    endedAt: ended == null ? null : t(ended),
  });

  it("a clean hand-over is silent: the old session ended before the new one opened", () => {
    expect(findOverlappingSessions([row("cs_1", 0, 24, 5), row("cs_2", 5, 29)])).toEqual([]);
  });
  it("a natural expiry is silent", () => {
    expect(findOverlappingSessions([row("cs_1", 0, 24), row("cs_2", 30, 54)])).toEqual([]);
  });
  it("flags a session minted while the earlier one was still payable — the incident's shape", () => {
    const found = findOverlappingSessions([row("cs_1", 0, 24), row("cs_2", 0.02, 24.02)]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ invoiceNumber: "INV-9", firstSessionId: "cs_1", secondSessionId: "cs_2" });
  });
  it("checks every earlier session, not just the previous one", () => {
    const found = findOverlappingSessions([row("cs_1", 0, 24), row("cs_2", 1, 25, 1.5), row("cs_3", 2, 26)]);
    expect(found.map(f => [f.firstSessionId, f.secondSessionId])).toEqual([
      ["cs_1", "cs_2"],
      ["cs_1", "cs_3"],
    ]);
  });
  it("never counts a superseded session — its url never reached anyone", () => {
    expect(findOverlappingSessions([{ ...row("cs_1", 0, 24, 3), endReason: "superseded" }, row("cs_2", 1, 25)])).toEqual([]);
  });
  it("reports an overlap once: only for sessions minted since the last run", () => {
    const rows = [row("cs_1", 0, 24), row("cs_2", 1, 25)];
    expect(findOverlappingSessions(rows, t(0.5))).toHaveLength(1);
    expect(findOverlappingSessions(rows, t(2))).toEqual([]);
  });
  it("keeps invoices apart", () => {
    expect(findOverlappingSessions([row("cs_1", 0, 24), { ...row("cs_2", 1, 25), invoiceId: 10 }])).toEqual([]);
  });
});

describe("Stripe's record against the app's", () => {
  it("reads a refunded payment as nothing, a processing one as in flight", () => {
    expect(
      sessionPaymentState({ status: "complete", payment_intent: { id: "pi", status: "succeeded", latest_charge: { refunded: true } } as never })
    ).toBeNull();
    expect(sessionPaymentState({ status: "complete", payment_intent: { id: "pi", status: "processing" } as never })).toEqual({
      intentId: "pi",
      state: "processing",
    });
    expect(sessionPaymentState({ status: "open", payment_intent: null })).toBeNull();
  });

  it("flags a succeeded payment plus one still processing — money in flight twice", async () => {
    const s1 = await stripeSession(9);
    const s2 = await stripeSession(9);
    customerPays(s1, "card", "pi_card");
    customerPays(s2, "ach", "pi_ach");
    seedInvoice({ ...kit.invoices.get(9)!, status: "paid", stripePaymentIntentId: "pi_card" });

    const f = await inspectPaymentIntegrity(new Date());
    expect(f.duplicatePayments).toEqual([
      { invoiceId: 9, invoiceNumber: "INV-9", payments: [{ intentId: "pi_card", state: "succeeded" }, { intentId: "pi_ach", state: "processing" }] },
    ]);
    // Paid by hand-reconciled record: not "unrecorded".
    expect(f.unrecordedStripePayments).toEqual([]);
  });

  it("one payment per invoice is silent", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "card", "pi_card");
    seedInvoice({ ...kit.invoices.get(9)!, status: "paid", stripePaymentIntentId: "pi_card" });
    const f = await inspectPaymentIntegrity(new Date());
    expect(paymentProblemCount(f)).toBe(0);
  });

  it("flags money Stripe holds for an invoice that still reads unpaid", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "ach", "pi_ach");
    bankSettles("pi_ach", "succeeded");
    const f = await inspectPaymentIntegrity(new Date());
    expect(f.unrecordedStripePayments).toEqual([{ invoiceId: 9, invoiceNumber: "INV-9", intentId: "pi_ach", state: "succeeded" }]);
  });

  it("does not flag a payment the invoice already knows is processing", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "ach", "pi_ach");
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    expect((await inspectPaymentIntegrity(new Date())).unrecordedStripePayments).toEqual([]);
  });

  it("gives a payment from the last hour time for its webhook", async () => {
    const s1 = await stripeSession(9, 0.1);
    customerPays(s1, "card", "pi_fresh");
    expect((await inspectPaymentIntegrity(new Date())).unrecordedStripePayments).toEqual([]);
  });

  it("flags two sessions open on Stripe at once", async () => {
    await stripeSession(9);
    await stripeSession(9);
    const f = await inspectPaymentIntegrity(new Date());
    expect(f.overlappingCheckoutSessions).toHaveLength(1);
    expect(f.overlappingCheckoutSessions[0]!.detail).toContain("2 checkout sessions are open at once");
  });

  it("ignores tip and deposit sessions", async () => {
    const tip = await fakeStripe.checkout.sessions.create({ expires_at: 2e9, line_items: [], metadata: { payment_type: "tip", booking_id: "4" } });
    customerPays(tip.id, "card", "pi_tip");
    expect(paymentProcessingLess(await inspectPaymentIntegrity(new Date()))).toBe(0);
  });

  it("reports a Stripe failure as a finding instead of a clean bill of health", async () => {
    const spy = vi.spyOn(fakeStripe.checkout.sessions, "list").mockImplementationOnce(() => {
      throw new Error("Stripe 500");
    });
    const f = await inspectPaymentIntegrity(new Date());
    spy.mockRestore();
    expect(f.paymentInspectionError).toContain("Stripe 500");
    expect(paymentProblemCount(f)).toBe(1);
    expect(formatPaymentFindings(f).join("\n")).toContain("PAYMENTS CHECK COULD NOT RUN IN FULL");
  });

  it("skips Stripe's half without a key, rather than failing every day in a keyless environment", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const s1 = await stripeSession(9);
    customerPays(s1, "card", "pi_x");
    const f = await inspectPaymentIntegrity(new Date());
    expect(f.paymentInspectionError).toBeNull();
    expect(f.unrecordedStripePayments).toEqual([]);
  });
});

describe("bank answers the webhook never delivered", () => {
  it("flags an invoice still 'processing' after Stripe has the bank's answer — and says how to sync it", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "ach", "pi_ach");
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(Date.now() - 3 * HOUR), paymentProcessingIntentId: "pi_ach" });
    bankSettles("pi_ach", "succeeded");

    const f = await inspectPaymentIntegrity(new Date());

    expect(f.bankAnswersNotRecorded).toEqual([{ invoiceId: 9, invoiceNumber: "INV-9", intentId: "pi_ach", stripeState: "succeeded" }]);
    const text = formatPaymentFindings(f).join("\n");
    expect(text).toContain("STRIPE HAS ANSWERED BUT THE APP WAS NEVER TOLD");
    expect(text).toContain("press Resend");
  });
  it("flags a failure the app never heard about", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "ach", "pi_ach");
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    bankSettles("pi_ach", "failed");
    expect((await inspectPaymentIntegrity(new Date())).bankAnswersNotRecorded[0]).toMatchObject({ stripeState: "failed" });
  });
  it("a payment still processing on Stripe is not flagged", async () => {
    const s1 = await stripeSession(9);
    customerPays(s1, "ach", "pi_ach");
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    expect((await inspectPaymentIntegrity(new Date())).bankAnswersNotRecorded).toEqual([]);
  });
});

describe("advice the owner can act on", () => {
  it("never tells the owner to record an unrecorded Stripe payment by hand, and splits the advice by state", async () => {
    const s1 = await stripeSession(9);
    const s2 = await stripeSession(9);
    customerPays(s1, "ach", "pi_done");
    bankSettles("pi_done", "succeeded");
    customerPays(s2, "ach", "pi_moving");
    const text = formatPaymentFindings(await inspectPaymentIntegrity(new Date())).join("\n");
    expect(text).toContain("Do NOT record these by hand");
    expect(text).toMatch(/pi_done \(succeeded\): press Resend/);
    expect(text).toMatch(/pi_moving \(still processing\): press Resend once/);
  });
});

describe("stuck processing", () => {
  it("flags a bank payment processing for longer than any bank takes", async () => {
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(Date.now() - 20 * 24 * HOUR), paymentProcessingIntentId: "pi_slow" });
    const f = await inspectPaymentIntegrity(new Date());
    expect(f.stuckPaymentProcessing).toEqual([expect.objectContaining({ invoiceNumber: "INV-9", intentId: "pi_slow", days: 20 })]);
    expect(formatPaymentFindings(f).join("\n")).toContain("checkout.session.async_payment_succeeded");
  });
  it("leaves a microdeposit customer who verified late (day 16) alone", async () => {
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(Date.now() - 16 * 24 * HOUR), paymentProcessingIntentId: "pi_late" });
    expect((await inspectPaymentIntegrity(new Date())).stuckPaymentProcessing).toEqual([]);
  });
  it("leaves a normal four-day ACH alone", async () => {
    seedInvoice({ ...kit.invoices.get(9)!, paymentProcessingAt: new Date(Date.now() - 4 * 24 * HOUR), paymentProcessingIntentId: "pi_ok" });
    expect((await inspectPaymentIntegrity(new Date())).stuckPaymentProcessing).toEqual([]);
  });
});

function paymentProcessingLess(f: Awaited<ReturnType<typeof inspectPaymentIntegrity>>): number {
  return paymentProblemCount(f);
}
