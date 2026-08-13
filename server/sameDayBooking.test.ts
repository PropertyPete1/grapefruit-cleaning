/**
 * Same-day booking.
 *
 * The booking calendar used to disable today outright, through a
 * `before: now + 24h` matcher that react-day-picker compares in calendar days —
 * so it blocked today and nothing else, whatever the hour. That predated the
 * lead-time rule and made it invisible: a 3-hour notice period could never
 * remove a slot the calendar was still offering, because the only day it could
 * have applied to was hidden.
 *
 * Today is now selectable, and how soon a customer may book is decided entirely
 * by the rules the server enforces: the notice period, the hours a crew is
 * already committed to, and whether the job finishes before closing. What is
 * pinned here is that those rules leave exactly the right slots on today, at
 * both ends of the day and at their boundaries.
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

import { DURATION_SETTING_KEY, serializeDurationConfig, type DurationConfig } from "@shared/duration";
import { DEFAULT_DURATIONS } from "@shared/duration";
import { LEAD_TIME_SETTING_KEY, slotStartInstant, todayInBookingZone } from "@shared/leadTime";
import { SCHEDULE_SETTING_KEY } from "@shared/schedule";
import { _resetRateLimits } from "./antiSpam";
import { bookingRouter } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

const BOOKING_PAGE = fileURLToPath(new URL("../client/src/pages/Booking.tsx", import.meta.url));

/** A Wednesday: open 8:00–18:00, slots 8–11 and 13–17 under the default schedule. */
const TODAY = "2026-08-19";

/** Freezes the clock at a wall-clock time on TODAY, San Antonio. */
const atLocal = (time: string) => new Date(slotStartInstant(TODAY, time));

const caller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

function settings(overrides: { leadTime?: string; durations?: DurationConfig } = {}) {
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === LEAD_TIME_SETTING_KEY) return overrides.leadTime ?? null; // default: 3 hours
    if (key === DURATION_SETTING_KEY) return overrides.durations ? serializeDurationConfig(overrides.durations) : null;
    if (key === SCHEDULE_SETTING_KEY) return null;
    return null;
  });
}

/** Times the calendar would let a customer pick. */
async function offeredToday(job?: { serviceType: "residential" | "deep"; sqft: number }) {
  const slots = await caller().availability({ date: TODAY, ...job });
  return slots.filter(s => s.available).map(s => s.time);
}

beforeEach(() => {
  _resetRateLimits();
  vi.stubEnv("PUBLIC_BASE_URL", undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  settings();
  mockGetOccupiedBookings.mockReset().mockResolvedValue([]);
  mockCreateBooking.mockReset().mockResolvedValue(99);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the calendar no longer hides today", () => {
  const source = readFileSync(BOOKING_PAGE, "utf-8");
  const matchers = source.slice(source.indexOf("disabled={["), source.indexOf("]}", source.indexOf("disabled={[")));

  it("has dropped the blanket 24-hour block", () => {
    // react-day-picker compares `before` in calendar days, so this disabled
    // today and only today — a rule the lead time now expresses properly.
    expect(source).not.toContain("24 * 3600 * 1000");
    expect(matchers).not.toContain("before:");
  });

  it("still refuses dates in the past", () => {
    expect(matchers).toContain("todayInBookingZone()");
  });

  it("judges the past in the business's timezone, not the browser's", () => {
    // A customer abroad must not have the current San Antonio day hidden.
    expect(source).toContain("todayInBookingZone");
    expect(source).not.toMatch(/new Date\(\)\.getFullYear\(\)/);
  });

  it("still closes days the schedule marks closed", () => {
    expect(matchers).toContain("!day.open");
  });
});

describe("todayInBookingZone", () => {
  it("reports the San Antonio date, not the UTC one", () => {
    // 02:00Z on the 20th is still 21:00 on the 19th in San Antonio.
    expect(todayInBookingZone(new Date("2026-08-20T02:00:00Z"))).toBe("2026-08-19");
    // And by 06:00Z the local date has caught up.
    expect(todayInBookingZone(new Date("2026-08-20T06:00:00Z"))).toBe("2026-08-20");
  });

  it("holds across a winter offset too", () => {
    expect(todayInBookingZone(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-14");
    expect(todayInBookingZone(new Date("2026-01-15T07:00:00Z"))).toBe("2026-01-15");
  });
});

describe("what today still offers", () => {
  it("leaves the slots that clear the notice period and finish before closing", async () => {
    // 09:30 on the day. Default 3-hour notice → nothing before 12:30, so 13:00
    // is the first candidate. A 1,200 sq ft residential clean runs 3 hours
    // against an 18:00 close → last start 15:00.
    vi.setSystemTime(atLocal("09:30"));
    expect(await offeredToday({ serviceType: "residential", sqft: 1200 })).toEqual([
      "13:00",
      "14:00",
      "15:00",
    ]);
  });

  it("offers the whole rest of the day first thing in the morning", async () => {
    // 05:00, before opening: the 3-hour notice clears everything from 08:00,
    // and a 2-hour job fits up to a 16:00 start.
    vi.setSystemTime(atLocal("05:00"));
    expect(await offeredToday({ serviceType: "residential", sqft: 800 })).toEqual([
      "08:00",
      "09:00",
      "10:00",
      "11:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
  });

  it("offers nothing once the day has run out", async () => {
    // 16:00: the notice period alone pushes past closing.
    vi.setSystemTime(atLocal("16:00"));
    expect(await offeredToday({ serviceType: "residential", sqft: 1200 })).toEqual([]);
  });

  it("still lists the day's slots when none are left, rather than claiming it is closed", async () => {
    vi.setSystemTime(atLocal("16:00"));
    const slots = await caller().availability({ date: TODAY, serviceType: "residential", sqft: 1200 });
    // The booking page tells these two states apart: an empty list means
    // "closed that day", a full list with nothing available means "no times
    // left today".
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every(s => !s.available)).toBe(true);
  });

  it("holds the notice boundary exactly", async () => {
    // 10:00 with a 3-hour notice: 13:00 is exactly three hours out and stands.
    vi.setSystemTime(atLocal("10:00"));
    expect(await offeredToday({ serviceType: "residential", sqft: 800 })).toContain("13:00");
    // A minute later it is inside the window and goes.
    vi.setSystemTime(new Date(atLocal("10:00").getTime() + 60_000));
    expect(await offeredToday({ serviceType: "residential", sqft: 800 })).not.toContain("13:00");
  });

  it("holds the closing boundary exactly", async () => {
    vi.setSystemTime(atLocal("05:00"));
    // A 5-hour deep clean against an 18:00 close may start at 13:00, not 14:00.
    const deep = await offeredToday({ serviceType: "deep", sqft: 2500 });
    expect(deep).toContain("13:00");
    expect(deep).not.toContain("14:00");
  });

  it("opens the last hour of the day when the notice period is switched off", async () => {
    settings({
      leadTime: "0",
      durations: {
        ...DEFAULT_DURATIONS,
        ladders: { ...DEFAULT_DURATIONS.ladders, residential: [{ maxSqft: Infinity, hours: 1 }] },
      },
    });
    vi.setSystemTime(atLocal("16:30"));
    // A one-hour job at 17:00 lands exactly on the 18:00 close, and half an
    // hour of notice is enough with the rule off.
    expect(await offeredToday({ serviceType: "residential", sqft: 800 })).toEqual(["17:00"]);
  });

  it("never offers an hour that has already gone, even with no notice required", async () => {
    settings({ leadTime: "0" });
    vi.setSystemTime(atLocal("14:30"));
    const offered = await offeredToday({ serviceType: "residential", sqft: 800 });
    // The morning is behind us. "No notice required" must not mean a customer
    // can book this morning's nine o'clock.
    for (const gone of ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00"]) {
      expect(offered, gone).not.toContain(gone);
    }
    expect(offered).toEqual(["15:00", "16:00"]);
  });

  it("takes a longer notice period into account", async () => {
    settings({ leadTime: "8" });
    vi.setSystemTime(atLocal("08:00"));
    // Eight hours from 08:00 is 16:00; a 2-hour job then fits at 16:00 only.
    expect(await offeredToday({ serviceType: "residential", sqft: 800 })).toEqual(["16:00"]);
  });

  it("still removes the hours a crew is already committed to", async () => {
    vi.setSystemTime(atLocal("05:00"));
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "13:00", serviceType: "deep", sqft: 2500, estimatedHours: 3 }, // [13,16)
    ]);
    const offered = await offeredToday({ serviceType: "residential", sqft: 800 });
    expect(offered).not.toContain("13:00");
    expect(offered).not.toContain("14:00");
    expect(offered).not.toContain("15:00");
    expect(offered).toContain("16:00");
    // And a 2-hour job at 11:00 would run into it.
    expect(offered).not.toContain("12:00");
  });
});

describe("booking.create accepts a valid same-day slot", () => {
  const input = {
    quote: {
      type: "residential" as const,
      bedrooms: 2,
      bathrooms: 1,
      sqft: 1200,
      extras: [],
      frequency: "onetime" as const,
    },
    date: TODAY,
    time: "13:00",
    firstName: "Ana",
    lastName: "Lopez",
    email: "ana@example.com",
    phone: "2105550000",
    address: "1 Main St",
    city: "San Antonio",
    zip: "78201",
    locale: "en" as const,
  };

  it("takes a booking for later today", async () => {
    vi.setSystemTime(atLocal("09:30"));
    await expect(caller().create(input)).resolves.toMatchObject({ bookingId: 99 });
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.scheduledDate).toBe(TODAY);
    expect(written.estimatedHours).toBe(3);
  });

  it("still refuses one inside the notice period", async () => {
    vi.setSystemTime(atLocal("11:00")); // 13:00 is only two hours out
    await expect(caller().create(input)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("still refuses one that would run past closing", async () => {
    vi.setSystemTime(atLocal("05:00"));
    // 16:00 + 3h = 19:00, an hour past the 18:00 close.
    await expect(caller().create({ ...input, time: "16:00" })).rejects.toThrow(/not available/i);
  });

  it("refuses a date that has already gone by", async () => {
    vi.setSystemTime(atLocal("09:30"));
    await expect(caller().create({ ...input, date: "2026-08-18" })).rejects.toThrow(/not available/i);
  });
});

describe("the booking page explains a day with nothing left", () => {
  const source = readFileSync(BOOKING_PAGE, "utf-8");

  it("derives the state from the slots themselves", () => {
    // Now that today is selectable, a wall of disabled buttons is a state
    // customers will actually reach — most often on an afternoon booking.
    expect(source).toMatch(/const noneLeftToday =[^;]*some\(s => s\.available\)/s);
  });

  it("actually renders the message on that condition", () => {
    // Asserting the identifiers merely appear would still pass with the branch
    // wired to something that is never true.
    expect(source).toMatch(/\{\s*date && availability\.data && noneLeftToday && \(/);
    const branch = source.slice(source.indexOf("noneLeftToday && ("));
    expect(branch.slice(0, 400)).toContain("t.booking.noTimesLeft");
  });

  it("hides the slot grid in that state instead of showing dead buttons", () => {
    expect(source).toMatch(/availability\.data\.length > 0 && !noneLeftToday && \(/);
  });

  it("still keeps the closed-day message for a day the schedule closes", () => {
    expect(source).toMatch(/availability\.data\.length === 0 && \(/);
    expect(source).toContain("t.booking.closedDay");
  });

  it("has the copy in both languages", () => {
    const en = readFileSync(fileURLToPath(new URL("../client/src/i18n/translations/en.ts", import.meta.url)), "utf-8");
    const es = readFileSync(fileURLToPath(new URL("../client/src/i18n/translations/es.ts", import.meta.url)), "utf-8");
    expect(en).toMatch(/noTimesLeft: "/);
    expect(es).toMatch(/noTimesLeft: "/);
  });
});

describe("the default ladder is what these cases assume", () => {
  it("still runs a 1,200 sq ft residential clean for 3 hours", () => {
    // Guards the arithmetic above from drifting if the defaults are retuned.
    expect(DEFAULT_DURATIONS.ladders.residential.find(b => b.maxSqft === 2000)?.hours).toBe(3);
  });
});
