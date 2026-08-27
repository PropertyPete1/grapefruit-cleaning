import { describe, expect, it } from "vitest";
import {
  lineItemAmountCents,
  lineItemName,
  lineItemsTotalCents,
  parseLineItems,
  serializeLineItems,
  type InvoiceLineItem,
} from "@shared/invoiceItems";
import { buildStripeLineItems, lineItemLabel } from "./balance";

describe("dynamic catalog invoice snapshots", () => {
  const v2Items: InvoiceLineItem[] = [
    {
      version: 2,
      kind: "addon",
      catalogKey: "sectional-steam-cleaning",
      nameEn: "Sectional Steam Cleaning",
      nameEs: "Limpieza a vapor de sofá seccional",
      amountCents: 12_999,
      priceMode: "starting_at",
      source: "approval",
    },
    {
      version: 2,
      kind: "custom",
      nameEn: "Confirmed additional treatment",
      nameEs: "Tratamiento adicional confirmado",
      amountCents: 7_999,
      source: "approval",
    },
  ];

  it("round-trips exact cents and both immutable language names", () => {
    const parsed = parseLineItems(serializeLineItems(v2Items));
    expect(parsed).toEqual(v2Items);
    expect(lineItemsTotalCents(parsed)).toBe(20_998);
    expect(lineItemName(parsed[0], "en")).toBe("Sectional Steam Cleaning");
    expect(lineItemName(parsed[0], "es")).toBe("Limpieza a vapor de sofá seccional");
    expect(lineItemLabel(parsed[0], "es")).toBe("Limpieza a vapor de sofá seccional");
    expect(lineItemAmountCents(parsed[1])).toBe(7_999);
  });

  it("builds Stripe lines that sum exactly to the approved cents total", () => {
    const lines = buildStripeLineItems({
      amount: 345.95,
      amountCents: 34_595,
      items: v2Items,
      serviceName: "Deep Cleaning",
      locale: "en",
      description: "Approved invoice",
    });
    expect(lines.map(line => line.price_data.unit_amount)).toEqual([13_597, 12_999, 7_999]);
    expect(lines.reduce((sum, line) => sum + (line.price_data.unit_amount ?? 0), 0)).toBe(34_595);
  });

  it("keeps version-1 historical rows byte-for-byte compatible", () => {
    const raw = JSON.stringify([
      { kind: "addon", id: "laundry", name: "Laundry & folding", amount: 30 },
      { kind: "custom", name: "Legacy charge", amount: 25 },
    ]);
    const parsed = parseLineItems(raw);
    expect(parsed).toEqual(JSON.parse(raw));
    expect(serializeLineItems(parsed)).toBe(raw);
    expect(lineItemLabel(parsed[0], "es")).toBe("Lavandería y doblado");
  });
});
