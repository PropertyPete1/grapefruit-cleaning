/**
 * Minimum booking lead time.
 *
 * Three things are pinned here: the boundary (a slot exactly N hours out is
 * still offerable, a minute inside is not), the timezone (slot times are wall
 * clock in San Antonio, and reading them as UTC gets the answer wrong by five
 * or six hours), and the fact that the rule composes with the schedule rather
 * than replacing it — it can only ever take slots away.
 *
 * Both enforcement points are covered: the availability query the calendar
 * renders from, and booking.create, which is what a crafted request hits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  getOccupiedBookings: (...args: unknown[]) => mockGetOccupiedBookings(...args),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  createBooking: (...args: unknown[]) => mockCreateBooking(...args),
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

import { bookableSlots } from "@shared/availability";
import {
  DEFAULT_LEAD_TIME_HOURS,
  LEAD_TIME_SETTING_KEY,
  MAX_LEAD_TIME_HOURS,
  isValidLeadTimeHours,
  parseLeadTimeHours,
  readLeadTimeHours,
  slotMeetsLeadTime,
  slotStartInstant,
} from "@shared/leadTime";
import { DEFAULT_SCHEDULE, SCHEDULE_SETTING_KEY, slotsForDate } from "@shared/schedule";
import { _resetRateLimits } from "./antiSpam";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

/** A Wednesday: open 8–18 under the default schedule. */
const WEDNESDAY = "2026-08-19";
/** The Sunday before it: closed by default. */
const SUNDAY = "2026-08-16";

/** 10:00 on WEDNESDAY, Chicago wall clock, as a UTC instant. */
const TEN_AM = new Date(slotStartInstant(WEDNESDAY, "10:00"));
const hoursBefore = (instant: Date, hours: number) => new Date(instant.getTime() - hours * 3_600_000);
const minutesBefore = (instant: Date, minutes: number) => new Date(instant.getTime() - minutes * 60_000);

describe("parseLeadTimeHours", () => {
  it("defaults when nothing is configured", () => {
    expect(parseLeadTimeHours(null)).toBe(DEFAULT_LEAD_TIME_HOURS);
    expect(parseLeadTimeHours(undefined)).toBe(DEFAULT_LEAD_TIME_HOURS);
    expect(parseLeadTimeHours("")).toBe(DEFAULT_LEAD_TIME_HOURS);
    expect(parseLeadTimeHours("   ")).toBe(DEFAULT_LEAD_TIME_HOURS);
  });

  it("reads a whole number of hours, including the disabled and capped ends", () => {
    expect(parseLeadTimeHours("0")).toBe(0);
    expect(parseLeadTimeHours("6")).toBe(6);
    expect(parseLeadTimeHours(" 12 ")).toBe(12);
    expect(parseLeadTimeHours(String(MAX_LEAD_TIME_HOURS))).toBe(MAX_LEAD_TIME_HOURS);
  });

  it("falls back to the default rather than to 'no rule' on anything invalid", () => {
    // Corruption must never quietly reopen the calendar to same-minute bookings.
    for (const raw of ["abc", "-1", "3.5", "1e3", String(MAX_LEAD_TIME_HOURS + 1), "NaN", "{}"]) {
      expect(parseLeadTimeHours(raw), raw).toBe(DEFAULT_LEAD_TIME_HOURS);
    }
  });

  it("tells the save path apart from the read path's fallback", () => {
    // The distinction the admin validator needs: null means "this string is
    // not a lead time", which a caller may not store, while parse turns the
    // same string into the safe default at read time.
    expect(readLeadTimeHours("6")).toBe(6);
    expect(readLeadTimeHours("0")).toBe(0);
    // Blank is the trap: Number("") is 0, so a validator built on the number
    // alone would accept it as "disabled" while the reader saw "unconfigured".
    expect(readLeadTimeHours("")).toBeNull();
    expect(readLeadTimeHours("   ")).toBeNull();
    expect(readLeadTimeHours(null)).toBeNull();
    expect(readLeadTimeHours("abc")).toBeNull();
    expect(readLeadTimeHours(String(MAX_LEAD_TIME_HOURS + 1))).toBeNull();
  });

  it("agrees with the validator the admin save path uses", () => {
    expect(isValidLeadTimeHours(0)).toBe(true);
    expect(isValidLeadTimeHours(MAX_LEAD_TIME_HOURS)).toBe(true);
    expect(isValidLeadTimeHours(MAX_LEAD_TIME_HOURS + 1)).toBe(false);
    expect(isValidLeadTimeHours(-1)).toBe(false);
    expect(isValidLeadTimeHours(2.5)).toBe(false);
    expect(isValidLeadTimeHours("3")).toBe(false);
  });
});

describe("the lead-time boundary", () => {
  it("still offers a slot exactly N hours away", () => {
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, hoursBefore(TEN_AM, 3))).toBe(true);
  });

  it("withdraws it one minute inside the window", () => {
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, minutesBefore(TEN_AM, 179))).toBe(false);
  });

  it("still offers it one minute outside", () => {
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, minutesBefore(TEN_AM, 181))).toBe(true);
  });

  it("never offers a slot that has already started", () => {
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, TEN_AM)).toBe(false);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, new Date(TEN_AM.getTime() + 60_000))).toBe(false);
  });

  it("is disabled at 0 — even a slot starting this second is offerable", () => {
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 0, TEN_AM)).toBe(true);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 0, minutesBefore(TEN_AM, 1))).toBe(true);
  });

  it("scales with the configured hours", () => {
    const now = hoursBefore(TEN_AM, 5);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 3, now)).toBe(true);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 5, now)).toBe(true);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", 6, now)).toBe(false);
    expect(slotMeetsLeadTime(WEDNESDAY, "10:00", MAX_LEAD_TIME_HOURS, now)).toBe(false);
  });
});

describe("slot times are San Antonio wall clock, not UTC", () => {
  it("resolves a summer slot at the CDT offset", () => {
    // 10:00 CDT on 2026-08-19 is 15:00Z, not 10:00Z.
    expect(new Date(slotStartInstant("2026-08-19", "10:00")).toISOString()).toBe("2026-08-19T15:00:00.000Z");
  });

  it("resolves a winter slot at the CST offset", () => {
    expect(new Date(slotStartInstant("2026-01-14", "10:00")).toISOString()).toBe("2026-01-14T16:00:00.000Z");
  });

  it("lands on the right side of both daylight-saving changes", () => {
    // Spring forward is 2026-03-08: the day before is CST (-6), that morning CDT (-5).
    expect(new Date(slotStartInstant("2026-03-07", "09:00")).toISOString()).toBe("2026-03-07T15:00:00.000Z");
    expect(new Date(slotStartInstant("2026-03-08", "09:00")).toISOString()).toBe("2026-03-08T14:00:00.000Z");
    // Fall back is 2026-11-01.
    expect(new Date(slotStartInstant("2026-10-31", "09:00")).toISOString()).toBe("2026-10-31T14:00:00.000Z");
    expect(new Date(slotStartInstant("2026-11-01", "09:00")).toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });

  /**
   * The case a UTC comparison gets backwards. At 02:00Z on the 14th it is still
   * 9 PM on the 13th in San Antonio: the UTC date has rolled over and the local
   * one has not. A 1 AM slot on the 14th is four hours away and bookable, but
   * read as UTC it looks like an hour in the past.
   */
  it("gets a slot right across the UTC-midnight boundary", () => {
    const now = new Date("2026-08-14T02:00:00Z");
    expect(slotMeetsLeadTime("2026-08-14", "01:00", 3, now)).toBe(true);
    // The naive reading that this guards against.
    expect(Date.parse("2026-08-14T01:00:00Z") - now.getTime()).toBeLessThan(0);
    // And a slot genuinely inside the window on the local side of midnight.
    expect(slotMeetsLeadTime("2026-08-13", "23:00", 3, now)).toBe(false);
  });
});

describe("composition with the weekly schedule", () => {
  it("adds nothing the schedule did not already offer", () => {
    const now = hoursBefore(new Date(slotStartInstant(WEDNESDAY, "08:00")), 48);
    const offerable = bookableSlots({ date: WEDNESDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 3, occupied: [], now: now });
    expect(offerable).toEqual(slotsForDate(WEDNESDAY, DEFAULT_SCHEDULE));
    expect(offerable).not.toContain("12:00"); // the lunch gap survives
  });

  it("keeps a closed Sunday closed at every lead time", () => {
    const longBefore = hoursBefore(new Date(slotStartInstant(SUNDAY, "08:00")), 500);
    expect(bookableSlots({ date: SUNDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 0, occupied: [], now: longBefore })).toEqual([]);
    expect(bookableSlots({ date: SUNDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 3, occupied: [], now: longBefore })).toEqual([]);
  });

  it("trims only the front of the day when the clock is already inside it", () => {
    // 09:00 local, 3 hours' notice: 12:00 is the lunch gap, so 13:00 is first.
    const now = new Date(slotStartInstant(WEDNESDAY, "09:00"));
    expect(bookableSlots({ date: WEDNESDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 3, occupied: [], now: now })).toEqual([
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ]);
  });

  it("empties the day once every slot is inside the window", () => {
    const now = new Date(slotStartInstant(WEDNESDAY, "17:00"));
    expect(bookableSlots({ date: WEDNESDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 3, occupied: [], now: now })).toEqual([]);
  });

  it("respects an admin-shortened day", () => {
    const shortDay = { ...DEFAULT_SCHEDULE, 3: { open: true, start: 8, end: 11 } };
    const now = hoursBefore(new Date(slotStartInstant(WEDNESDAY, "08:00")), 48);
    expect(bookableSlots({ date: WEDNESDAY, schedule: shortDay, leadTimeHours: 3, occupied: [], now: now })).toEqual(["08:00", "09:00", "10:00"]);
  });
});

// ---------------------------------------------------------------------------
// Both enforcement points, through the router.
// ---------------------------------------------------------------------------

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

/** getSetting answers per key, so a test can set just the lead time. */
function settings(leadHours?: string) {
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === LEAD_TIME_SETTING_KEY) return leadHours ?? null;
    if (key === SCHEDULE_SETTING_KEY) return null;
    return null;
  });
}

const createInput = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [],
    frequency: "onetime" as const,
  },
  date: WEDNESDAY,
  time: "10:00",
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
  settings();
  mockSetSetting.mockReset().mockResolvedValue(undefined);
  mockGetOccupiedBookings.mockReset().mockResolvedValue([]);
  mockCreateBooking.mockReset().mockResolvedValue(99);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("booking.availability applies the lead time", () => {
  it("greys out the slots inside the window and keeps the rest", async () => {
    vi.setSystemTime(new Date(slotStartInstant(WEDNESDAY, "09:00")));
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    // Every slot the schedule offers is still listed — an empty list is the
    // calendar's "closed today" message and would be a lie here.
    expect(slots.map(s => s.time)).toEqual(slotsForDate(WEDNESDAY, DEFAULT_SCHEDULE));
    expect(slots.filter(s => s.available).map(s => s.time)).toEqual([
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ]);
  });

  it("offers the whole day when the default notice is comfortably clear", async () => {
    vi.setSystemTime(hoursBefore(new Date(slotStartInstant(WEDNESDAY, "08:00")), 48));
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    expect(slots.every(s => s.available)).toBe(true);
  });

  it("offers everything, right up to the hour, when set to 0", async () => {
    settings("0");
    vi.setSystemTime(new Date(slotStartInstant(WEDNESDAY, "09:59")));
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    expect(slots.find(s => s.time === "10:00")?.available).toBe(true);
    // 09:00 has already started, so even with the rule off it is behind us —
    // but nothing here removes it, because nothing here is a lead time.
    expect(slots.every(s => s.available)).toBe(true);
  });

  it("honours an admin-edited notice period", async () => {
    settings("8");
    vi.setSystemTime(new Date(slotStartInstant(WEDNESDAY, "08:00")));
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    // 8 hours from 08:00 is 16:00.
    expect(slots.filter(s => s.available).map(s => s.time)).toEqual(["16:00", "17:00"]);
  });

  it("composes with taken slots rather than overriding them", async () => {
    // A one-hour job at 14:00, so this case stays about the lead time.
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 1, time: "14:00", serviceType: "residential", sqft: 900, estimatedHours: 1 },
    ]);
    vi.setSystemTime(new Date(slotStartInstant(WEDNESDAY, "09:00")));
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    expect(slots.find(s => s.time === "14:00")?.available).toBe(false); // taken
    expect(slots.find(s => s.time === "09:00")?.available).toBe(false); // too soon
    expect(slots.find(s => s.time === "15:00")?.available).toBe(true); // free and far enough
  });

  it("still says nothing at all for a closed Sunday", async () => {
    vi.setSystemTime(hoursBefore(new Date(slotStartInstant(SUNDAY, "08:00")), 48));
    expect(await publicCaller().availability({ date: SUNDAY })).toEqual([]);
  });
});

describe("booking.create rejects a slot inside the window", () => {
  it("refuses a crafted request for a slot two hours out", async () => {
    vi.setSystemTime(hoursBefore(TEN_AM, 2));
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("says so in Spanish for a Spanish booking", async () => {
    vi.setSystemTime(hoursBefore(TEN_AM, 2));
    await expect(publicCaller().create({ ...createInput, locale: "es" })).rejects.toThrow(/no está disponible/i);
  });

  it("accepts the same slot at exactly the lead time", async () => {
    vi.setSystemTime(hoursBefore(TEN_AM, 3));
    await expect(publicCaller().create(createInput)).resolves.toMatchObject({ bookingId: 99 });
  });

  it("refuses it a minute inside", async () => {
    vi.setSystemTime(minutesBefore(TEN_AM, 179));
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
  });

  it("accepts a same-minute booking once the rule is switched off", async () => {
    settings("0");
    vi.setSystemTime(TEN_AM);
    await expect(publicCaller().create(createInput)).resolves.toMatchObject({ bookingId: 99 });
  });

  it("applies the admin-edited notice period", async () => {
    settings("24");
    vi.setSystemTime(hoursBefore(TEN_AM, 12));
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
    vi.setSystemTime(hoursBefore(TEN_AM, 25));
    await expect(publicCaller().create(createInput)).resolves.toMatchObject({ bookingId: 99 });
  });

  it("still refuses a closed Sunday, whatever the notice period", async () => {
    settings("0");
    vi.setSystemTime(hoursBefore(new Date(slotStartInstant(SUNDAY, "10:00")), 48));
    await expect(publicCaller().create({ ...createInput, date: SUNDAY })).rejects.toThrow(/not available/i);
  });

  it("leaves an ordinary far-out booking working", async () => {
    vi.useRealTimers();
    await expect(
      publicCaller().create({ ...createInput, date: OPEN_MONDAY })
    ).resolves.toMatchObject({ bookingId: 99 });
  });
});

describe("saving the lead time from Admin → Settings", () => {
  const adminCaller = () =>
    adminRouter.createCaller({
      user: { id: 1, role: "admin" },
      req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
      res: {},
    } as unknown as TrpcContext);

  it("accepts whole hours across the allowed range", async () => {
    for (const value of ["0", "3", "24", String(MAX_LEAD_TIME_HOURS)]) {
      await expect(
        adminCaller().saveSetting({ key: LEAD_TIME_SETTING_KEY, value })
      ).resolves.toEqual({ success: true });
    }
  });

  it("refuses anything parseLeadTimeHours would silently turn back into the default", async () => {
    for (const value of ["abc", "-1", "2.5", String(MAX_LEAD_TIME_HOURS + 1), ""]) {
      await expect(
        adminCaller().saveSetting({ key: LEAD_TIME_SETTING_KEY, value }),
        value
      ).rejects.toThrow(/whole number of hours/i);
    }
  });

  it("leaves every other setting alone", async () => {
    await expect(
      adminCaller().saveSetting({ key: "business_phone", value: "(210) 555-0123" })
    ).resolves.toEqual({ success: true });
  });
});
