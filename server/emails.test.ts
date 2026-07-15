import { describe, expect, it } from "vitest";
import { buildCustomerConfirmation, buildOwnerNotification, type BookingEmailData } from "./emails";

const baseData: BookingEmailData = {
  reference: "GFC-TEST23",
  serviceName: "Residential Cleaning",
  date: "2026-08-01",
  time: "09:00",
  frequencyLabel: "One-time",
  extras: ["Inside oven"],
  total: 250,
  deposit: 50,
  customerName: "Jane Doe",
  customerEmail: "jane@example.com",
  customerPhone: "(555) 123-4567",
  address: "123 Main St, Austin, TX",
  locale: "en",
};

describe("booking confirmation emails", () => {
  it("builds an English confirmation with booking details", () => {
    const { subject, body } = buildCustomerConfirmation(baseData);
    expect(subject).toContain("GFC-TEST23");
    expect(body).toContain("Jane Doe");
    expect(body).toContain("Residential Cleaning");
    expect(body).toContain("$250 USD");
    expect(body).toContain("$50 USD");
    expect(body).toContain("$200 USD"); // remaining balance
  });

  it("builds a Spanish confirmation when locale is es", () => {
    const { subject, body } = buildCustomerConfirmation({ ...baseData, locale: "es" });
    expect(subject).toContain("Reserva GFC-TEST23");
    expect(body).toContain("DETALLES DE SU RESERVA");
    expect(body).not.toContain("Thank you for booking");
  });

  it("keeps the brand name in English within Spanish emails", () => {
    const { body } = buildCustomerConfirmation({ ...baseData, locale: "es" });
    expect(body).toContain("Grapefruit Cleaning Co.");
  });

  it("builds an owner notification with customer contact info", () => {
    const { title, content } = buildOwnerNotification(baseData);
    expect(title).toContain("GFC-TEST23");
    expect(content).toContain("jane@example.com");
    expect(content).toContain("123 Main St");
    expect(content).toContain("Deposit paid: $50 USD");
  });

  it("handles bookings without extras gracefully", () => {
    const { body } = buildCustomerConfirmation({ ...baseData, extras: [] });
    expect(body).toContain("Extras: None");
  });
});
