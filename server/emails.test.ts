import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTransporter,
  buildReminderEmail,
  buildCustomerConfirmation,
  buildOwnerNotification,
  deliverEmail,
  wrapEmailHtml,
  type BookingEmailData,
} from "./emails";

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

  it("warns the owner when a late payment recovered a booking into a retaken slot", () => {
    const { title, content } = buildOwnerNotification({ ...baseData, slotConflict: true });
    expect(title).toContain("SCHEDULING CONFLICT");
    expect(content).toContain("SCHEDULING CONFLICT");
    expect(content).toContain("reschedule");
  });

  it("adds no conflict warning on a normal confirmation", () => {
    const { title, content } = buildOwnerNotification(baseData);
    expect(title).not.toContain("CONFLICT");
    expect(content).not.toContain("CONFLICT");
  });

  it("handles bookings without extras gracefully", () => {
    const { body } = buildCustomerConfirmation({ ...baseData, extras: [] });
    expect(body).toContain("Extras: None");
  });
});

describe("email delivery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    __resetTransporter();
  });

  it("wraps plain text into branded HTML and escapes markup", () => {
    const html = wrapEmailHtml("Test subject", "Hello <World>\n\nPAYMENT SUMMARY\nTotal: $99");
    expect(html).toContain("Grapefruit Cleaning Co.");
    expect(html).toContain("Hello &lt;World&gt;");
    expect(html).toContain("PAYMENT SUMMARY");
    expect(html).not.toContain("<World>");
  });

  it("falls back to logging when Gmail credentials are missing", async () => {
    vi.stubEnv("GMAIL_USER", "");
    vi.stubEnv("GMAIL_APP_PASSWORD", "");
    const delivered = await deliverEmail("jane@example.com", "Subject", "Body");
    expect(delivered).toBe(false);
  });
});

describe("reminder emails", () => {
  it("builds the week-out reminder in English", () => {
    const { subject, body } = buildReminderEmail(baseData, "week");
    expect(subject).toContain("coming soon");
    expect(body).toContain("one week away");
    expect(body).toContain("GFC-TEST23");
    expect(body).toContain("$200 USD"); // remaining balance
  });

  it("builds the day-before reminder in English", () => {
    const { subject, body } = buildReminderEmail(baseData, "day");
    expect(subject).toContain("tomorrow");
    expect(body).toContain("tomorrow");
    expect(body).toContain("123 Main St");
  });

  it("builds Spanish reminders keeping the brand name in English", () => {
    const week = buildReminderEmail({ ...baseData, locale: "es" }, "week");
    expect(week.subject).toContain("Su limpieza se acerca");
    expect(week.body).toContain("Grapefruit Cleaning Co.");
    const day = buildReminderEmail({ ...baseData, locale: "es" }, "day");
    expect(day.subject).toContain("mañana");
    expect(day.body).not.toContain("tomorrow");
  });
});
