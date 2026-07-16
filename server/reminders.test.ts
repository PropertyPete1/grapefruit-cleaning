import { describe, expect, it } from "vitest";
import { daysBetween, dueReminderKind } from "./reminders";

function makeBooking(overrides: Partial<Parameters<typeof dueReminderKind>[0]> = {}) {
  return {
    scheduledDate: "2026-08-10",
    status: "confirmed" as const,
    weekReminderSentAt: null,
    dayReminderSentAt: null,
    createdAt: new Date("2026-07-20T12:00:00Z"),
    ...overrides,
  };
}

describe("daysBetween", () => {
  it("computes day differences across months", () => {
    expect(daysBetween("2026-07-28", "2026-08-04")).toBe(7);
    expect(daysBetween("2026-08-10", "2026-08-10")).toBe(0);
    expect(daysBetween("2026-08-11", "2026-08-10")).toBe(-1);
  });
});

describe("dueReminderKind", () => {
  it("sends the week reminder 7 days out when booked at least a week ahead", () => {
    expect(dueReminderKind(makeBooking(), "2026-08-03")).toBe("week");
  });

  it("still sends the week reminder on catch-up days (6 days out)", () => {
    expect(dueReminderKind(makeBooking(), "2026-08-04")).toBe("week");
  });

  it("skips the week reminder when the booking was made less than a week out", () => {
    const shortNotice = makeBooking({ createdAt: new Date("2026-08-05T12:00:00Z") });
    expect(dueReminderKind(shortNotice, "2026-08-06")).toBe(null);
  });

  it("does not resend the week reminder once sent", () => {
    const sent = makeBooking({ weekReminderSentAt: new Date("2026-08-03T09:00:00Z") });
    expect(dueReminderKind(sent, "2026-08-04")).toBe(null);
  });

  it("sends the day-before reminder 1 day out", () => {
    expect(dueReminderKind(makeBooking(), "2026-08-09")).toBe("day");
  });

  it("sends the day reminder as catch-up on the day itself", () => {
    expect(dueReminderKind(makeBooking(), "2026-08-10")).toBe("day");
  });

  it("does not resend the day reminder once sent", () => {
    const sent = makeBooking({ dayReminderSentAt: new Date("2026-08-09T09:00:00Z") });
    expect(dueReminderKind(sent, "2026-08-09")).toBe(null);
  });

  it("ignores past, cancelled and pending-deposit bookings", () => {
    expect(dueReminderKind(makeBooking(), "2026-08-12")).toBe(null);
    expect(dueReminderKind(makeBooking({ status: "cancelled" as never }), "2026-08-09")).toBe(null);
    expect(dueReminderKind(makeBooking({ status: "pending_deposit" as never }), "2026-08-09")).toBe(null);
  });

  it("prefers the day reminder when both would be due", () => {
    // e.g. booking made far out but cron was down for a week
    expect(dueReminderKind(makeBooking(), "2026-08-09")).toBe("day");
  });
});
