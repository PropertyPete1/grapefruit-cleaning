import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balanceReminderAction } from "./balanceRules";

const harness = vi.hoisted(() => {
  type State = {
    invoice: Record<string, unknown> | null;
    booking: Record<string, unknown>;
    inserts: Record<string, unknown>[];
    invoiceClaimWins: boolean;
    tipClaimWins: boolean;
  };

  let state: State;
  const reset = (overrides: Partial<State> = {}) => {
    state = {
      invoice: {
        id: 501,
        number: "INV-OFFLINE-1",
        bookingId: 42,
        customerId: 7,
        amount: 300,
        amountCents: 30000,
        kind: "balance",
        status: "sent",
        paidAt: null,
        paidVia: null,
        stripeSessionId: "cs_old",
      },
      booking: { id: 42, status: "confirmed", tipPaidAt: null, tipAmount: null, tipAmountCents: null },
      inserts: [],
      invoiceClaimWins: true,
      tipClaimWins: true,
      ...overrides,
    };
  };
  reset();

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.invoice ? [state.invoice] : []) }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if ("paidVia" in patch) {
            if (!state.invoiceClaimWins || !state.invoice) return [{ affectedRows: 0 }];
            Object.assign(state.invoice, patch);
            return [{ affectedRows: 1 }];
          }
          if ("tipPaidAt" in patch) {
            if (!state.tipClaimWins || state.booking.tipPaidAt) return [{ affectedRows: 0 }];
            Object.assign(state.booking, patch);
            return [{ affectedRows: 1 }];
          }
          if (patch.status === "completed") {
            if (!(["confirmed", "in_progress"] as unknown[]).includes(state.booking.status)) {
              return [{ affectedRows: 0 }];
            }
            Object.assign(state.booking, patch);
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 0 }];
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        state.inserts.push(row);
        return [{ insertId: 70 + state.inserts.length }];
      },
    }),
  };

  const fakeDb = {
    transaction: async <T>(work: (inner: typeof tx) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(state);
      try {
        return await work(tx);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    },
  };

  return { fakeDb, reset, get state() { return state; } };
});

vi.mock("drizzle-orm/mysql2", () => ({ drizzle: () => harness.fakeDb }));

import { mergeMonthlyRevenueRows, recordOfflineInvoicePayment, summarizeRevenueBySource } from "./db";

const INPUT = {
  invoiceId: 501,
  amountCents: 30000,
  method: "cash" as const,
  tipAmountCents: 2000,
  note: "  Collected on site  ",
  receivedOn: "2026-08-30",
  recordedByUserId: 9,
  recordedAt: new Date("2026-08-30T18:00:00Z"),
};

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "mysql://offline-payment-test");
  harness.reset();
});

afterEach(() => vi.unstubAllEnvs());

describe("recordOfflineInvoicePayment transaction", () => {
  it("settles the invoice, writes separate payment and tip rows, audits the admin, and completes an open booking", async () => {
    const result = await recordOfflineInvoicePayment(INPUT);

    expect(result).toMatchObject({
      outcome: "recorded",
      paymentId: 71,
      tipPaymentId: 72,
      bookingCompleted: true,
    });
    expect(harness.state.invoice).toMatchObject({ status: "paid", paidVia: "manual" });
    expect(harness.state.booking).toMatchObject({ status: "completed", tipAmount: 20, tipAmountCents: 2000 });
    expect(harness.state.inserts).toEqual([
      expect.objectContaining({
        invoiceId: 501,
        bookingId: 42,
        amountCents: 30000,
        kind: "balance",
        method: "cash",
        source: "offline",
        receivedOn: "2026-08-30",
        note: "Collected on site",
        recordedByUserId: 9,
        recordedAt: INPUT.recordedAt,
        status: "succeeded",
      }),
      expect.objectContaining({
        invoiceId: 501,
        bookingId: 42,
        amountCents: 2000,
        kind: "tip",
        method: "cash",
        source: "offline",
        recordedByUserId: 9,
        status: "succeeded",
      }),
    ]);

    expect(balanceReminderAction(result.outcome === "recorded" ? result.invoice : never, new Date("2026-09-30"))).toBeNull();
  });

  it("rejects a different amount before any write", async () => {
    const result = await recordOfflineInvoicePayment({ ...INPUT, amountCents: 29900 });
    expect(result).toEqual({ outcome: "amount_mismatch", expectedAmountCents: 30000 });
    expect(harness.state.invoice).toMatchObject({ status: "sent" });
    expect(harness.state.inserts).toEqual([]);
  });

  it("creates no rows when another settlement wins the invoice claim", async () => {
    harness.reset({ invoiceClaimWins: false });
    const result = await recordOfflineInvoicePayment(INPUT);
    expect(result).toEqual({ outcome: "already_settled", status: "paid" });
    expect(harness.state.inserts).toEqual([]);
  });

  it("rolls back the invoice and payment when a tip was already recorded", async () => {
    harness.reset({ tipClaimWins: false });
    const result = await recordOfflineInvoicePayment(INPUT);
    expect(result).toEqual({ outcome: "tip_already_recorded" });
    expect(harness.state.invoice).toMatchObject({ status: "sent", paidVia: null });
    expect(harness.state.inserts).toEqual([]);
  });
});

describe("Stripe and offline revenue reporting", () => {
  it("includes both sources in total revenue while keeping source totals separate", () => {
    expect(
      summarizeRevenueBySource([
        { source: "stripe", totalCents: 19000 },
        { source: "offline", totalCents: 32000 },
      ])
    ).toEqual({ totalRevenue: 510, stripeRevenue: 190, offlineRevenue: 320 });
  });

  it("keeps monthly Stripe and offline amounts separate while preserving the combined total", () => {
    expect(
      mergeMonthlyRevenueRows([
        { month: "2026-08", source: "stripe", totalCents: 19000 },
        { month: "2026-08", source: "offline", totalCents: 32000 },
        { month: "2026-09", source: "offline", totalCents: 8000 },
      ])
    ).toEqual([
      { month: "2026-08", total: 510, stripe: 190, offline: 320 },
      { month: "2026-09", total: 80, stripe: 0, offline: 80 },
    ]);
  });
});
