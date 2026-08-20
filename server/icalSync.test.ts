/**
 * The sync engine: every reservation's checkout becomes a cleaning, and the
 * feed reconciles idempotently — re-polls change nothing, moved reservations
 * move their booking, vanished ones cancel it, and a turnover that fits
 * nowhere becomes an unscheduled booking plus an owner alert, never a silent
 * drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockListAutoBookings = vi.fn();
const mockUpdateProperty = vi.fn();
const mockGetCustomerById = vi.fn();
const mockClaimTurnoverNotice = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    isDuplicateUidError: actual.isDuplicateUidError,
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
    createBooking: (...a: unknown[]) => mockCreateBooking(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    listAutoBookingsForProperty: (...a: unknown[]) => mockListAutoBookings(...a),
    updateConnectedProperty: (...a: unknown[]) => mockUpdateProperty(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    claimTurnoverNotice: (...a: unknown[]) => mockClaimTurnoverNotice(...a),
    listActiveSyncProperties: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { calculateQuote, DEFAULT_PRICING } from "@shared/pricing";
import { todayInBookingZone } from "@shared/leadTime";
import { __resetTransporter } from "./emails";
import { FEED_FAILURE_ALERT_THRESHOLD, pickAutoSlot, syncConnectedProperty } from "./icalSync";
import type { ConnectedProperty } from "../drizzle/schema";
import { DEFAULT_SCHEDULE } from "@shared/schedule";
import { upcomingMonday } from "./testDates";

/** Checkout days on a guaranteed-open future week (Mon/Tue/Wed). */
const MONDAY = upcomingMonday();
const plusDays = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const TUESDAY = plusDays(MONDAY, 1);
const WEDNESDAY = plusDays(MONDAY, 2);

const property = (overrides: Partial<ConnectedProperty> = {}): ConnectedProperty =>
  ({
    id: 5,
    customerId: 7,
    label: "Riverwalk condo",
    addressLine: "100 River St",
    unitNumber: "204",
    propertyType: "apartment",
    city: "San Antonio",
    zip: "78205",
    sqft: 900,
    serviceType: "airbnb",
    icalUrl: "https://www.airbnb.com/calendar/ical/123.ics",
    defaultTime: "11:00",
    active: true,
    autoBook: true,
    perCleanEmails: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    reservationCount: null,
    consecutiveFailures: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ConnectedProperty;

/** A feed with the given (uid, checkoutDate) reservations, all-day style. */
function feedWith(reservations: { uid: string; checkout: string; nights?: number }[]): string {
  const events = reservations
    .map(r => {
      const start = plusDays(r.checkout, -(r.nights ?? 2)).replace(/-/g, "");
      const end = r.checkout.replace(/-/g, "");
      return [
        "BEGIN:VEVENT",
        `UID:${r.uid}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        "SUMMARY:Reserved",
        "END:VEVENT",
      ].join("\r\n");
    })
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR`;
}

function stubFeed(body: string, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 404, text: async () => body })
  );
}

/** An existing auto booking row, as listAutoBookingsForProperty returns it. */
const autoRow = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "GFC-AUTO1",
  customerId: 7,
  propertyId: 5,
  icalUid: "res-1@airbnb.com",
  kind: "ical_auto",
  serviceType: "airbnb",
  sqft: 900,
  estimatedHours: 2,
  scheduledDate: MONDAY,
  scheduledTime: "11:00",
  status: "confirmed",
  totalAmount: 90,
  depositAmount: 0,
  createdAt: new Date(),
  ...overrides,
});

const written = () => mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
const ownerAlerts = () => [
  ...mockNotifyOwner.mock.calls.map(c => (c[0] as { title: string }).title),
  ...mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject),
];

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetSetting.mockResolvedValue(null);
  mockGetOccupiedBookings.mockResolvedValue([]);
  mockCreateBooking.mockResolvedValue(99);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockListAutoBookings.mockResolvedValue([]);
  mockUpdateProperty.mockResolvedValue(undefined);
  mockGetCustomerById.mockResolvedValue({
    id: 7,
    firstName: "Hank",
    email: "hank@example.com",
    preferredLocale: "en",
  });
  // The claim succeeds by default: a fresh reservation has never been announced.
  mockClaimTurnoverNotice.mockResolvedValue(true);
  mockNotifyOwner.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("creating cleanings from reservations", () => {
  it("books each future checkout: confirmed, zero deposit, priced from the live config", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: MONDAY }]));
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ ok: true, created: 1, moved: 0, cancelled: 0, unplaced: 0 });
    const expected = calculateQuote(
      { type: "airbnb", bedrooms: 2, bathrooms: 1, sqft: 900, extras: [], frequency: "onetime" },
      DEFAULT_PRICING
    );
    expect(written()).toMatchObject({
      kind: "ical_auto",
      status: "confirmed",
      propertyId: 5,
      icalUid: "res-1@airbnb.com",
      scheduledDate: MONDAY,
      scheduledTime: "11:00",
      totalAmount: expected.total,
      depositAmount: 0,
      unitNumber: "204",
      propertyType: "apartment",
    });
  });

  it("ignores checkouts already behind us", async () => {
    stubFeed(feedWith([{ uid: "old-1", checkout: "2020-01-06" }]));
    const summary = await syncConnectedProperty(property());
    expect(summary.created).toBe(0);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("books nothing when autoBook is off, while still recording the sync", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    const summary = await syncConnectedProperty(property({ autoBook: false }));
    expect(summary.ok).toBe(true);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockUpdateProperty).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ lastSyncStatus: "ok", reservationCount: 1 })
    );
  });

  /**
   * The scheduling notice is NOT a per-clean report, so perCleanEmails must not
   * gate it — a host who declined running commentary still needs to know their
   * next guest is covered. perCleanEmails is false on the default fixture, so
   * this asserts the unconditional behaviour directly.
   */
  it("always tells the host a new reservation was scheduled, even with per-clean emails off", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    await syncConnectedProperty(property({ perCleanEmails: false }));
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("New booking detected"))).toBe(true);
    expect(subjects.some(s => s.includes(MONDAY))).toBe(true);
    // Claimed for the announced date, which is what keeps the retry quiet.
    expect(mockClaimTurnoverNotice).toHaveBeenCalledWith(99, MONDAY);
  });

  it("names the property address and admits when the time is not settled yet", async () => {
    // A fully-booked day: the turnover is created unscheduled, so the notice has
    // a date but no time.
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    // getOccupiedBookings returns {time, serviceType, sqft, estimatedHours} —
    // one job spanning the whole day leaves nowhere for this turnover to go.
    mockGetOccupiedBookings.mockResolvedValue([
      { time: "08:00", serviceType: "airbnb", sqft: 900, estimatedHours: 14 },
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary.unplaced).toBe(1);
    // The owner alert also mentions "turnover", so match on the host copy.
    const body = mockSendMail.mock.calls
      .map(c => (c[0] as { text: string }).text)
      .find(t => t.includes("Your next guest is covered"));
    expect(body).toBeTruthy();
    expect(body).toContain("100 River St");
    expect(body).toContain("still confirming the exact time");
  });

  it("sends the notice in the host's language", async () => {
    mockGetCustomerById.mockResolvedValue({
      id: 7,
      firstName: "Hank",
      email: "hank@example.com",
      preferredLocale: "es",
    });
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    await syncConnectedProperty(property());
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("Nueva reserva detectada"))).toBe(true);
  });
});

describe("scheduling-notice dedupe", () => {
  /**
   * The regression that motivated the date-keyed claim: an unplaced turnover is
   * retried every hour, and the retry used to re-email the host each time it
   * finally landed. Same date already announced → the claim refuses → silence.
   */
  it("does not re-email when the hourly retry places a turnover on the date already announced", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: MONDAY }]));
    // An existing turnover for that reservation, unplaced, already announced for
    // MONDAY — exactly the state the retry path picks up.
    mockListAutoBookings.mockResolvedValue([
      autoRow({ scheduledDate: null, scheduledTime: null, turnoverNoticeDate: MONDAY }),
    ]);
    mockClaimTurnoverNotice.mockResolvedValue(false); // already claimed for MONDAY
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1); // it DID get placed
    expect(mockClaimTurnoverNotice).toHaveBeenCalledWith(42, MONDAY);
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.filter(s => s.includes("turnover") || s.includes("booking detected"))).toHaveLength(0);
  });

  it("still notifies when the reservation genuinely moves to a new date", async () => {
    // Feed now says WEDNESDAY; the booking sits on MONDAY and was announced for MONDAY.
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: WEDNESDAY }]));
    mockListAutoBookings.mockResolvedValue([
      autoRow({ scheduledDate: MONDAY, scheduledTime: "11:00", turnoverNoticeDate: MONDAY }),
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    // A different date, so the claim is asked for the NEW one and succeeds.
    expect(mockClaimTurnoverNotice).toHaveBeenCalledWith(42, WEDNESDAY);
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("Turnover rescheduled") && s.includes(WEDNESDAY))).toBe(true);
  });

  it("a mail failure never breaks the sync — the booking still stands", async () => {
    mockSendMail.mockRejectedValue(new Error("mailbox unavailable"));
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ ok: true, created: 1 });
  });
});

describe("cancelled reservations", () => {
  it("tells the host and alerts the owner when a dropped reservation cancels its cleaning", async () => {
    // Feed no longer carries res-1: the guest cancelled.
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow()]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("Reservation cancelled") && s.includes(MONDAY))).toBe(true);
    expect(ownerAlerts().some(t => t.includes("Turnover cancelled"))).toBe(true);
  });

  it("names the removed date and time in the host's notice", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow()]);
    await syncConnectedProperty(property());
    const body = mockSendMail.mock.calls
      .map(c => (c[0] as { text: string }).text)
      .find(t => t.includes("no longer shows that reservation"));
    expect(body).toBeTruthy();
    expect(body).toContain(MONDAY);
    expect(body).toContain("11:00");
    expect(body).toContain("won't be charged");
  });

  it("cancels and notifies regardless of the per-clean setting", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow()]);
    await syncConnectedProperty(property({ perCleanEmails: false }));
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("Reservation cancelled"))).toBe(true);
  });

  it("says nothing about a past cleaning, and does not touch it", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: "2020-01-06" })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(0);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
    const subjects = mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);
    expect(subjects.some(s => s.includes("Reservation cancelled"))).toBe(false);
  });

  it("says nothing when a human already cancelled or the job is under way", async () => {
    for (const status of ["cancelled", "in_progress", "completed"]) {
      vi.clearAllMocks();
      mockGetSetting.mockResolvedValue(null);
      mockGetOccupiedBookings.mockResolvedValue([]);
      mockUpdateProperty.mockResolvedValue(undefined);
      mockGetCustomerById.mockResolvedValue({
        id: 7,
        firstName: "Hank",
        email: "hank@example.com",
        preferredLocale: "en",
      });
      mockSendMail.mockResolvedValue({ messageId: "1" });
      stubFeed(feedWith([]));
      mockListAutoBookings.mockResolvedValue([autoRow({ status })]);
      const summary = await syncConnectedProperty(property());
      expect(summary.cancelled, status).toBe(0);
      expect(mockUpdateBooking, status).not.toHaveBeenCalled();
      expect(mockSendMail.mock.calls.length, status).toBe(0);
    }
  });

  it("a cancellation-notice failure still leaves the booking cancelled", async () => {
    mockSendMail.mockRejectedValue(new Error("mailbox unavailable"));
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow()]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
  });
});

describe("idempotent re-polls", () => {
  it("a second poll of the same feed creates nothing", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: MONDAY }]));
    mockListAutoBookings.mockResolvedValue([autoRow()]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ ok: true, created: 0, moved: 0, cancelled: 0 });
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });
});

describe("moved reservations", () => {
  it("moves the booking to the new checkout day", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: WEDNESDAY }]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: MONDAY })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ scheduledDate: WEDNESDAY, scheduledTime: "11:00" })
    );
  });

  it("never touches an in-progress or completed booking", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: WEDNESDAY }]));
    mockListAutoBookings.mockResolvedValue([
      autoRow({ status: "in_progress" }),
      autoRow({ id: 43, icalUid: "res-2", status: "completed", scheduledDate: MONDAY }),
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(0);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("retries placing a still-unscheduled booking quietly when space may have freed", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: MONDAY }]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: null, scheduledTime: null })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ scheduledDate: MONDAY, scheduledTime: "11:00" })
    );
    // Quiet retry: the owner was alerted when it first failed to place.
    expect(ownerAlerts().filter(t => t.includes("ACTION NEEDED"))).toHaveLength(0);
  });
});

describe("vanished reservations", () => {
  it("cancels a still-future booking whose reservation disappeared", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: WEDNESDAY })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
  });

  it("leaves past bookings alone — history rolls off feeds naturally", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: "2020-01-06" })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(0);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("never resurrects or re-cancels a hand-cancelled booking", async () => {
    stubFeed(feedWith([{ uid: "res-1@airbnb.com", checkout: WEDNESDAY }]));
    mockListAutoBookings.mockResolvedValue([autoRow({ status: "cancelled", scheduledDate: MONDAY })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.created).toBe(0);
    expect(summary.moved).toBe(0);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("cancels an unscheduled booking too when its reservation vanishes", async () => {
    stubFeed(feedWith([]));
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: null, scheduledTime: null })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.cancelled).toBe(1);
  });
});

describe("conflict fallback", () => {
  it("slides to a later slot when the default is occupied", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "11:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "confirmed", createdAt: new Date() },
    ]);
    await syncConnectedProperty(property());
    // 11:00–14:00 is taken; the first slot at-or-after that fits a 2h airbnb
    // clean is 14:00.
    expect(written()).toMatchObject({ scheduledDate: MONDAY, scheduledTime: "14:00" });
  });

  it("never books before the default — the guest is still packing", () => {
    const slot = pickAutoSlot({
      date: MONDAY,
      jobHours: 2,
      defaultTime: "11:00",
      context: {
        schedule: DEFAULT_SCHEDULE,
        lunchBreak: false,
        occupied: [
          // Everything 11:00 onward is walled off…
          { time: "11:00", hours: 7 },
        ],
      },
    });
    // …and 08:00–10:00 sit empty. They are before checkout: not offered.
    expect(slot).toBeNull();
  });

  it("creates the booking UNSCHEDULED and alerts the owner when nothing fits", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "11:00", serviceType: "deep", sqft: 3000, estimatedHours: 7, status: "confirmed", createdAt: new Date() },
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ created: 1, unplaced: 1 });
    expect(written()).toMatchObject({ scheduledDate: null, scheduledTime: null, status: "confirmed" });
    const alerts = ownerAlerts();
    expect(alerts.some(t => t.includes("[ACTION NEEDED]"))).toBe(true);
    // The turnover exists either way — never silently dropped.
  });

  it("respects the lunch break when the owner has reserved it", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "booking_lunch_break" ? "true" : null
    );
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "11:00", serviceType: "residential", sqft: 800, estimatedHours: 1, status: "confirmed", createdAt: new Date() },
    ]);
    await syncConnectedProperty(property());
    // 11:00 taken, 12:00 is lunch — the slide lands on 13:00.
    expect(written()).toMatchObject({ scheduledTime: "13:00" });
  });

  it("blocks around other bookings' full spans — duration rules hold for auto bookings", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    mockGetOccupiedBookings.mockResolvedValue([
      // A 4h deep clean at 10:00 covers 10–14; first free-at-or-after-11 is 14:00.
      { id: 1, time: "10:00", serviceType: "deep", sqft: 1500, estimatedHours: 4, status: "confirmed", createdAt: new Date() },
    ]);
    await syncConnectedProperty(property());
    expect(written()).toMatchObject({ scheduledTime: "14:00" });
  });
});

describe("racing syncs", () => {
  it("treats a duplicate-UID insert as already created, not an error", async () => {
    stubFeed(feedWith([{ uid: "res-1", checkout: MONDAY }]));
    mockCreateBooking.mockRejectedValueOnce(
      Object.assign(new Error("Duplicate entry '5-res-1' for key 'bookings_property_uid_unique'"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      })
    );
    const summary = await syncConnectedProperty(property());
    expect(summary.ok).toBe(true);
    expect(summary.created).toBe(1);
    expect(summary.unplaced).toBe(0);
  });
});

describe("feed failures", () => {
  it("records the error and counts the streak without alerting on the first blip", async () => {
    stubFeed("", false);
    const summary = await syncConnectedProperty(property({ consecutiveFailures: 0 }));
    expect(summary.ok).toBe(false);
    expect(mockUpdateProperty).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ consecutiveFailures: 1, lastSyncStatus: expect.stringContaining("404") })
    );
    expect(ownerAlerts()).toHaveLength(0);
  });

  it("alerts the owner exactly when the streak crosses the threshold", async () => {
    stubFeed("", false);
    await syncConnectedProperty(property({ consecutiveFailures: FEED_FAILURE_ALERT_THRESHOLD - 1 }));
    const alerts = ownerAlerts();
    expect(alerts.some(t => t.includes("stopped syncing"))).toBe(true);
  });

  it("does not re-alert every hour once past the threshold", async () => {
    stubFeed("", false);
    await syncConnectedProperty(property({ consecutiveFailures: FEED_FAILURE_ALERT_THRESHOLD }));
    expect(ownerAlerts()).toHaveLength(0);
  });

  it("a non-calendar response is a failure, not a parse of garbage", async () => {
    stubFeed("<html>Sign in to Airbnb</html>", true);
    const summary = await syncConnectedProperty(property());
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("not an iCalendar");
  });

  it("success resets the streak", async () => {
    stubFeed(feedWith([]));
    await syncConnectedProperty(property({ consecutiveFailures: 2 }));
    expect(mockUpdateProperty).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ consecutiveFailures: 0, lastSyncStatus: "ok" })
    );
  });
});

describe("zero-deposit balance math", () => {
  it("bills the full price after completion — no deposit was paid, none is credited", async () => {
    const { balanceDueForBooking } = await import("./balance");
    // Auto bookings: depositAmount 0, no payment intent.
    expect(
      balanceDueForBooking({ totalAmount: 96, depositAmount: 0, stripePaymentIntentId: null })
    ).toBe(96);
    // Belt and braces: even a nonzero depositAmount is not credited without a
    // real payment intent — the deposit-credit rule from the balance round.
    expect(
      balanceDueForBooking({ totalAmount: 96, depositAmount: 19, stripePaymentIntentId: null })
    ).toBe(96);
    expect(
      balanceDueForBooking({ totalAmount: 96, depositAmount: 19, stripePaymentIntentId: "pi_x" })
    ).toBe(77);
  });
});
