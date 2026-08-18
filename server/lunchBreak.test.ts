/**
 * The lunch break.
 *
 * The 12:00 slot used to be skipped unconditionally, inherited from the
 * original site, and nothing in the admin panel said so — the owner noticed
 * noon had gone missing and asked where it went. It is a setting now, off by
 * default, and what is pinned here is that the switch reaches every place a
 * slot is decided: the calendar the customer sees AND the validator that
 * accepts the booking. A rule the calendar hides but the server does not
 * enforce is a rule a crafted request walks straight through.
 *
 * The duration interaction is the other thing pinned here. Reserving lunch
 * removes noon as a START time only. A job booked at 11:00 that runs three
 * hours still works through it, and still blocks it against anyone else. The
 * alternative — treating the hour as dead time inside a job — would either
 * stretch every span crossing noon or refuse to book across it at all, and
 * both cost the owner far more slots than the setting is worth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  getOccupiedBookings: (...args: unknown[]) => mockGetOccupiedBookings(...args),
  createBooking: (...args: unknown[]) => mockCreateBooking(...args),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  updateBooking: vi.fn().mockResolvedValue(undefined),
  expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
  isSlotTakenError: () => false,
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

import { bookableSlots, slotsCoveredBy } from "@shared/availability";
import { DURATION_SETTING_KEY } from "@shared/duration";
import { LEAD_TIME_SETTING_KEY, slotStartInstant } from "@shared/leadTime";
import {
  DEFAULT_SCHEDULE,
  LUNCH_SETTING_KEY,
  SCHEDULE_SETTING_KEY,
  slotsForDate,
} from "@shared/schedule";
import { _resetRateLimits } from "./antiSpam";
import { bookingRouter } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

const SETTINGS_PAGE = fileURLToPath(new URL("../client/src/pages/admin/AdminSettings.tsx", import.meta.url));
const BOOKING_PAGE = fileURLToPath(new URL("../client/src/pages/Booking.tsx", import.meta.url));

/** A Wednesday: open 8:00–18:00 under the default schedule. */
const WEDNESDAY = "2026-08-19";

const atLocal = (time: string) => new Date(slotStartInstant(WEDNESDAY, time));

const caller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

/** Stored settings, with the lunch break off unless a test turns it on. */
function settings({ lunch }: { lunch?: string } = {}) {
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === LUNCH_SETTING_KEY) return lunch ?? null;
    if (key === LEAD_TIME_SETTING_KEY) return "0"; // notice period out of the way
    if (key === DURATION_SETTING_KEY) return null;
    if (key === SCHEDULE_SETTING_KEY) return null;
    return null;
  });
}

const offered = async () =>
  (await caller().availability({ date: WEDNESDAY })).filter(s => s.available).map(s => s.time);

const input = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [],
    frequency: "onetime" as const,
  },
  date: WEDNESDAY,
  time: "12:00",
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  address: "1 Main St",
  city: "San Antonio",
  zip: "78201",
  locale: "en" as const,
};

beforeEach(() => {
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(atLocal("06:00"));
  settings();
  mockGetOccupiedBookings.mockReset().mockResolvedValue([]);
  mockCreateBooking.mockReset().mockResolvedValue(99);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the calendar", () => {
  it("offers noon by default — the setting ships off", async () => {
    expect(await offered()).toContain("12:00");
  });

  it("drops noon once the owner reserves the lunch hour", async () => {
    settings({ lunch: "true" });
    expect(await offered()).not.toContain("12:00");
  });

  it("drops noon and nothing else", async () => {
    const withoutLunch = await offered();
    settings({ lunch: "true" });
    const withLunch = await offered();
    expect(withLunch).toEqual(withoutLunch.filter(t => t !== "12:00"));
  });

  it("stops listing the slot at all rather than showing it greyed out", async () => {
    // The distinction matters: a listed-but-unavailable noon reads as "someone
    // booked it", and the owner would field the phone call. It is not on offer.
    settings({ lunch: "true" });
    const listed = (await caller().availability({ date: WEDNESDAY })).map(s => s.time);
    expect(listed).not.toContain("12:00");
  });

  it("hands the flag to the client so the gap can be explained", async () => {
    settings({ lunch: "true" });
    await expect(caller().schedule()).resolves.toMatchObject({ lunchBreak: true });
    settings();
    await expect(caller().schedule()).resolves.toMatchObject({ lunchBreak: false });
  });

  it("still returns the weekly days alongside it", async () => {
    const result = await caller().schedule();
    expect(result.days[0]!.open).toBe(false); // Sunday closed by default
    expect(result.days[3]).toEqual(DEFAULT_SCHEDULE[3]);
  });
});

describe("server-side validation", () => {
  it("takes a noon booking while the break is off", async () => {
    await expect(caller().create(input)).resolves.toMatchObject({ bookingId: 99 });
  });

  it("refuses a noon booking once the break is on, even though the form allows it", async () => {
    // The calendar hides the slot; this is what stops a crafted request, a
    // stale tab, or a link built by hand.
    settings({ lunch: "true" });
    await expect(caller().create(input)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("keeps taking every other hour of that day", async () => {
    settings({ lunch: "true" });
    await expect(caller().create({ ...input, time: "13:00" })).resolves.toMatchObject({ bookingId: 99 });
  });

  it("says the same thing to the customer as any other unavailable slot", async () => {
    // Not "we're at lunch" — the message is the one the flow already has, so a
    // reserved hour is indistinguishable from a taken one to a prober.
    settings({ lunch: "true" });
    await expect(caller().create(input)).rejects.toThrow(
      /The selected time is not available for booking/i
    );
  });

  it("refuses it in Spanish too", async () => {
    settings({ lunch: "true" });
    await expect(caller().create({ ...input, locale: "es" })).rejects.toThrow(/no está disponible/i);
  });
});

describe("the duration interaction", () => {
  it("lets a job booked earlier run straight through the reserved hour", async () => {
    // 11:00 + 3h covers 11, 12 and 13. Lunch takes noon off the grid as a
    // start time; it does not interrupt a cleaning already under way.
    settings({ lunch: "true" });
    await expect(caller().create({ ...input, time: "11:00" })).resolves.toMatchObject({ bookingId: 99 });
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.estimatedHours).toBe(3);
    expect(written.scheduledTime).toBe("11:00");
  });

  it("counts the reserved hour as occupied when a job spans it", () => {
    // Which is what stops a second booking being squeezed into the gap.
    expect(slotsCoveredBy("11:00", 3)).toContain("12:00");
  });

  it("blocks the hours around a job that spans noon", async () => {
    settings({ lunch: "true" });
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "11:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "confirmed", createdAt: new Date() },
    ]);
    const free = await offered();
    expect(free).not.toContain("11:00");
    expect(free).not.toContain("13:00");
    expect(free).toContain("14:00");
  });

  it("does not lengthen a job to make room for the break", async () => {
    // A 3-hour job starting at 11:00 ends at 14:00 with lunch on or off. If
    // the break were dead time inside the job it would have to end at 15:00.
    settings({ lunch: "true" });
    await caller().create({ ...input, time: "11:00" });
    const withLunch = (mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>).estimatedHours;
    mockCreateBooking.mockClear();
    settings();
    await caller().create({ ...input, time: "11:00" });
    const withoutLunch = (mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>).estimatedHours;
    expect(withLunch).toBe(withoutLunch);
  });

  it("still refuses a job that would run past closing, break or no break", async () => {
    settings({ lunch: "true" });
    // 16:00 + 3h = 19:00 against an 18:00 close.
    await expect(caller().create({ ...input, time: "16:00" })).rejects.toThrow(/not available/i);
  });
});

describe("composition with the other rules", () => {
  it("only ever subtracts, like every other scheduling rule", () => {
    const all = slotsForDate(WEDNESDAY, DEFAULT_SCHEDULE, true);
    const bookable = bookableSlots({
      date: WEDNESDAY,
      schedule: DEFAULT_SCHEDULE,
      lunchBreak: true,
      leadTimeHours: 0,
      occupied: [],
      now: atLocal("06:00"),
    });
    expect(bookable.every(slot => all.includes(slot))).toBe(true);
  });

  it("keeps a closed day closed rather than reopening it", () => {
    expect(
      bookableSlots({
        date: "2026-08-23", // Sunday
        schedule: DEFAULT_SCHEDULE,
        lunchBreak: true,
        leadTimeHours: 0,
        occupied: [],
        now: atLocal("06:00"),
      })
    ).toEqual([]);
  });
});

describe("the admin control", () => {
  const source = readFileSync(SETTINGS_PAGE, "utf-8");

  it("lives in the booking-hours panel", () => {
    const panel = source.slice(source.indexOf("function BookingHoursSection"));
    expect(panel.slice(0, panel.indexOf("function BookingLeadTimeSection"))).toContain("LUNCH_SETTING_KEY");
  });

  it("saves the flag under the setting key the booking rules read", () => {
    expect(source).toMatch(/save\.mutate\(\{ key: LUNCH_SETTING_KEY, value: String\(lunchBreak\) \}\)/);
  });

  it("reads the stored value through the same parser the server uses", () => {
    // Otherwise "saved" and "in force" can drift apart.
    expect(source).toContain("parseLunchBreak");
  });

  it("refreshes the slot lists after a save, not just the day grid", () => {
    expect(source).toContain("utils.booking.availability.invalidate()");
  });
});

describe("the customer-facing note", () => {
  const source = readFileSync(BOOKING_PAGE, "utf-8");

  it("explains the gap instead of leaving an unexplained hole in the hours", () => {
    expect(source).toContain("t.booking.lunchBreakNote");
  });

  it("only appears when the break is actually on", () => {
    expect(source).toMatch(/scheduleQuery\.data\?\.lunchBreak && \(/);
  });

  it("is written in both languages", () => {
    const en = readFileSync(fileURLToPath(new URL("../client/src/i18n/translations/en.ts", import.meta.url)), "utf-8");
    const es = readFileSync(fileURLToPath(new URL("../client/src/i18n/translations/es.ts", import.meta.url)), "utf-8");
    expect(en).toMatch(/lunchBreakNote: "[^"]+"/);
    expect(es).toMatch(/lunchBreakNote: "[^"]+"/);
    // And not the same string twice — a copy-paste that never got translated.
    const enNote = en.match(/lunchBreakNote: "([^"]+)"/)![1];
    const esNote = es.match(/lunchBreakNote: "([^"]+)"/)![1];
    expect(esNote).not.toBe(enNote);
  });

  it("reads the day grid from the new schedule shape", () => {
    expect(source).toContain("scheduleQuery.data?.days?.[d.getDay()]");
  });
});
