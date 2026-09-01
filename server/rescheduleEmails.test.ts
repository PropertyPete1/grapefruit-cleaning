import { describe, expect, it } from "vitest";
import { buildCleanerRescheduleNotice, buildRescheduleConfirmation } from "./emails";

const BASE = {
  bookingId: 41,
  reference: "GFC-RS41",
  customerName: "Ana",
  customerEmail: "ana@example.com",
  fromDate: "2026-09-03",
  fromTime: "11:00",
  toDate: "2026-09-04",
  rescheduleUrl: "https://grapeclean.com/en/reschedule/token",
  employeeName: "Karyme",
  employeeEmail: "crew@example.com",
};

describe("reschedule email content", () => {
  it("confirms an exact English move with old and new schedule plus a future request link", () => {
    const email = buildRescheduleConfirmation({ ...BASE, locale: "en", toTime: "14:00" });
    expect(email.subject).toContain("Your cleaning was rescheduled");
    expect(email.body).toContain("2026-09-04 at 14:00");
    expect(email.body).toContain("Previous schedule: 2026-09-03 at 11:00");
    expect(email.body).toContain(BASE.rescheduleUrl);
  });

  it("states naturally in Spanish that the new date is recorded and the time will follow", () => {
    const email = buildRescheduleConfirmation({
      ...BASE,
      locale: "es",
      toTime: null,
      rescheduleUrl: "https://grapeclean.com/es/reprogramar/token",
    });
    expect(email.subject).toContain("Su limpieza fue reprogramada");
    expect(email.body).toContain("Le confirmaremos la hora en cuanto quede definida");
    expect(email.body).toContain("2026-09-04 — hora por definir");
  });

  it("tells the assigned cleaner the exact moved time", () => {
    const email = buildCleanerRescheduleNotice({ ...BASE, locale: "en", toTime: "14:00" });
    expect(email.subject).toContain("Job rescheduled");
    expect(email.body).toContain("New schedule: 2026-09-04 at 14:00");
    expect(email.body).toContain("Please check your Grapefruit calendar");
  });

  it("tells the assigned cleaner when the new date has no time yet", () => {
    const email = buildCleanerRescheduleNotice({ ...BASE, locale: "es", toTime: null });
    expect(email.body).toContain("2026-09-04 — hora por definir");
    expect(email.body).toContain("Revise su calendario de Grapefruit");
  });
});
