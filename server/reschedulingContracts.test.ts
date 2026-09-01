import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf-8");

describe("rescheduling persistence contract", () => {
  const db = source("./db.ts");

  it("updates schedule and reminder claims but never commercial columns in the atomic move", () => {
    const move = db.slice(db.indexOf("export async function moveBookingSchedule"), db.indexOf("export async function createBookingScheduleEvent"));
    expect(move).toContain("scheduledDate: input.toDate");
    expect(move).toContain("scheduledTime: input.toTime");
    expect(move).toContain("weekReminderSentAt: null");
    expect(move).toContain("dayReminderSentAt: null");
    for (const commercial of ["totalAmount:", "depositAmount:", "extras:", "frequency:", "serviceType:", "stripePaymentIntentId:"]) {
      expect(move).not.toContain(commercial);
    }
  });

  it("writes the immutable event and resolves an approved request in the same transaction", () => {
    const move = db.slice(db.indexOf("export async function moveBookingSchedule"), db.indexOf("export async function createBookingScheduleEvent"));
    expect(move).toContain("tx.insert(bookingScheduleEvents)");
    expect(move).toContain('status: "approved"');
    expect(move).toMatch(/tx\s*\.update\(bookingRescheduleRequests\)/);
  });
});

describe("rescheduling UI and email contract", () => {
  const appointments = source("../client/src/pages/admin/AdminAppointments.tsx");
  const calendar = source("../client/src/pages/admin/AdminCalendar.tsx");
  const staff = source("../client/src/pages/staff/StaffRoutes.tsx");
  const customer = source("../client/src/pages/RescheduleRequest.tsx");
  const emails = source("./emails.ts");

  it("exposes exact and pending-time admin moves with immutable history", () => {
    const dialog = source("../client/src/pages/admin/RescheduleDialog.tsx");
    expect(dialog).toContain("Date selected; time to be decided");
    expect(dialog).toContain("Schedule history");
    expect(appointments).toContain("Time to be decided");
    expect(calendar).toContain("TIME TBD");
  });

  it("keeps customer proposals non-binding and requires admin approval or counter acceptance", () => {
    expect(customer).toContain("this form does not change your appointment by itself");
    expect(customer).toContain("este formulario no cambia su cita por sí solo");
    expect(customer).toContain("acceptCounter");
  });

  it("shows moved and pending-time work clearly to assigned cleaners", () => {
    expect(staff).toContain("Time to be decided");
    expect(staff).toContain("Time TBD");
  });

  it("uses dedicated logged email types for customer, cleaner, request, counter, and decline messages", () => {
    for (const type of [
      "reschedule_confirmation",
      "reschedule_cleaner",
      "reschedule_request_received",
      "reschedule_counter",
      "reschedule_declined",
    ]) {
      expect(emails).toContain(type);
    }
  });
});
