import { describe, expect, it } from "vitest";
import {
  centsToDollars,
  depositCents,
  dollarsToCents,
  dualMoney,
  formatCents,
  moneyCents,
} from "@shared/money";
import { normalizeBookingMoney, normalizeInvoiceMoney, normalizePaymentMoney } from "./db";

describe("exact cents money bridge", () => {
  it("represents the approved .99 catalog prices exactly", () => {
    expect(dollarsToCents(69.99)).toBe(6999);
    expect(dollarsToCents(39.99)).toBe(3999);
    expect(dollarsToCents(69.99) + dollarsToCents(39.99)).toBe(10998);
    expect(formatCents(10998)).toBe("109.98");
  });

  it("keeps the specification example exact", () => {
    expect(dollarsToCents(115.99) + dollarsToCents(229.96)).toBe(34595);
    expect(centsToDollars(34595)).toBe(345.95);
  });

  it("computes the deposit from the exact total, including add-ons", () => {
    expect(depositCents(34595, 0.2)).toBe(6919);
    expect(formatCents(6919)).toBe("69.19");
  });

  it("prefers cents and falls back to historical whole dollars", () => {
    expect(moneyCents(7999, 80)).toBe(7999);
    expect(moneyCents(null, 80)).toBe(8000);
    expect(moneyCents(undefined, 170)).toBe(17000);
  });

  it("dual-writes an exact cents amount and a rollback-compatible legacy value", () => {
    expect(dualMoney(7999)).toEqual({ cents: 7999, legacyDollars: 80 });
  });

  it("normalizes every centralized write without changing legacy column semantics", () => {
    expect(normalizeBookingMoney({ totalAmount: 79.99, depositAmountCents: 1600, discountApplied: 0 })).toMatchObject({
      totalAmount: 80,
      totalAmountCents: 7999,
      depositAmount: 16,
      depositAmountCents: 1600,
      discountApplied: 0,
      discountAppliedCents: 0,
    });
    expect(normalizeInvoiceMoney({ amount: 69.99, computedAmountCents: 10998 })).toMatchObject({
      amount: 70,
      amountCents: 6999,
      computedAmount: 110,
      computedAmountCents: 10998,
    });
    expect(normalizePaymentMoney({ amountCents: 34595 })).toMatchObject({ amount: 346, amountCents: 34595 });
  });
});
