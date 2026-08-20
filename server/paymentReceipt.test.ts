/**
 * The payment receipt: proof of payment for every settled invoice.
 *
 * What this file pins:
 *   - both languages, with the amount paid and a zeroed remaining balance;
 *   - the itemized breakdown carried over from the invoice;
 *   - a manual invoice prints no booking reference, no service date and no
 *     deposit line — printing "$0 deposit" would imply a credit never made;
 *   - no payment link on a receipt: the invoice is settled, and a live pay URL
 *     invites a second payment;
 *   - it is a separate message from the tip ask, not a merged one.
 */
import { describe, expect, it } from "vitest";
import { buildPaymentReceiptEmail } from "./emails";
import type { BalanceEmailData } from "./emails";

const BASE: BalanceEmailData & { paidOn: string; paidVia: "card" | "manual" } = {
  reference: "GFC-ABC123",
  invoiceNumber: "INV-TEST-0001",
  serviceName: "Residential Cleaning",
  date: "2026-08-18",
  total: 170,
  deposit: 34,
  balance: 136,
  baseAmount: 100,
  items: [
    { name: "Inside fridge", amount: 26 },
    { name: "Garage sweep", amount: 10 },
  ],
  customerName: "Daniel",
  customerEmail: "daniel@example.com",
  address: "12 Pecan St, San Antonio",
  payUrl: "",
  expiresOn: "2026-08-25",
  locale: "en",
  paidOn: "2026-08-19",
  paidVia: "card",
};

describe("the payment receipt", () => {
  it("leads with the amount paid and confirms nothing is outstanding", () => {
    const { subject, body } = buildPaymentReceiptEmail(BASE);
    expect(subject).toContain("Payment received");
    expect(body).toContain("$136");
    expect(body).toContain("Amount paid: $136");
    expect(body).toContain("Balance remaining: $0");
    expect(body).toContain("settled in full");
  });

  it("carries the invoice's itemization so the total is never a mystery", () => {
    const { body } = buildPaymentReceiptEmail(BASE);
    expect(body).toContain("Service: $100");
    expect(body).toContain("Inside fridge: $26");
    expect(body).toContain("Garage sweep: $10");
  });

  it("records how and when it was paid", () => {
    expect(buildPaymentReceiptEmail(BASE).body).toContain("Payment date: 2026-08-19");
    expect(buildPaymentReceiptEmail(BASE).body).toContain("Card (online)");
    expect(buildPaymentReceiptEmail({ ...BASE, paidVia: "manual" }).body).toContain(
      "Recorded by our team"
    );
  });

  it("shows the deposit credit on a booking-backed balance", () => {
    const { body } = buildPaymentReceiptEmail(BASE);
    expect(body).toContain("Reference: GFC-ABC123");
    expect(body).toContain("Service date: 2026-08-18");
    expect(body).toContain("Deposit paid earlier: $34");
    expect(body).toContain("Service total: $170");
  });

  it("prints no reference, date or deposit line for a manual invoice", () => {
    // The manual shape: no booking behind it, so total === amount and deposit
    // is zero. A "$0 deposit" line would read as a credit never made.
    const { body } = buildPaymentReceiptEmail({
      ...BASE,
      reference: "",
      date: "",
      total: 136,
      deposit: 0,
      address: undefined,
      paidVia: "manual",
    });
    expect(body).not.toContain("Reference:");
    expect(body).not.toContain("Service date:");
    expect(body).not.toContain("Deposit");
    expect(body).not.toContain("Address:");
    expect(body).toContain("Amount paid: $136");
  });

  it("never carries a payment link — the invoice is already settled", () => {
    const { body } = buildPaymentReceiptEmail(BASE);
    expect(body).not.toContain("/pay/");
    expect(body).not.toContain("PAY ONLINE");
  });

  it("is a receipt, not a tip solicitation", () => {
    const { body } = buildPaymentReceiptEmail(BASE);
    expect(body.toLowerCase()).not.toContain("tip");
  });

  it("renders in genuine Spanish for a Spanish customer", () => {
    const { subject, body } = buildPaymentReceiptEmail({ ...BASE, locale: "es" });
    expect(subject).toContain("Pago recibido");
    expect(body).toContain("Monto pagado: $136");
    expect(body).toContain("Saldo pendiente: $0");
    expect(body).toContain("Tarjeta (en línea)");
    expect(body).toContain("Inside fridge: $26");
  });

  it("handles an un-itemized invoice without inventing lines", () => {
    const { body } = buildPaymentReceiptEmail({ ...BASE, items: [], baseAmount: undefined });
    expect(body).toContain("Amount paid: $136");
    expect(body).not.toContain("Service: $");
  });
});
