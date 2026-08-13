/**
 * Jobs block the whole span they run for.
 *
 * A booking used to occupy only the hour it started in, so a four-hour deep
 * clean from 11:00 left 12:00 and 13:00 showing free and a second customer
 * could book straight into a crew still on site.
 *
 * What is pinned here: the ladder's write-path rules, the interval arithmetic
 * at its boundaries (half-open — a job ending at 14:00 leaves 14:00 free), the
 * composition with lead time and closing hours, that a released booking frees
 * its entire span rather than only its start, that a late payment recovering
 * into an overlap raises the same owner alert an identical start does, and that
 * editing the ladder never moves a booking that already exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockGetBookingById = vi.fn();
const mockConfirmUnpaidBooking = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  getOccupiedBookings: (...args: unknown[]) => mockGetOccupiedBookings(...args),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  confirmUnpaidBooking: (...args: unknown[]) => mockConfirmUnpaidBooking(...args),
  createBooking: (...args: unknown[]) => mockCreateBooking(...args),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  findOrCreateCustomer: vi.fn().mockResolvedValue(7),
  updateBooking: vi.fn().mockResolvedValue(undefined),
  expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
  createPayment: vi.fn(),
  getCustomerById: vi.fn().mockResolvedValue(undefined),
  incrementCouponRedemptions: vi.fn(),
  isSlotTakenError: () => false,
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

import {
  bookableSlots,
  fitsBeforeClose,
  formatJobSpan,
  intervalEndTime,
  intervalsOverlap,
  isSlotBookable,
  overlapsAny,
  slotsCoveredBy,
} from "@shared/availability";
import {
  DEFAULT_DURATIONS,
  DURATION_FLAT_TYPES,
  DURATION_SETTING_KEY,
  MAX_DURATION_HOURS,
  MAX_DURATION_TIERS_PER_SERVICE,
  durationHoursFor,
  parseDurationConfig,
  serializeDurationConfig,
  validateDurationConfig,
  type DurationConfig,
} from "@shared/duration";
import { LEAD_TIME_SETTING_KEY, slotStartInstant } from "@shared/leadTime";
import { DEFAULT_SCHEDULE, SCHEDULE_SETTING_KEY, slotsForDate } from "@shared/schedule";
import type { CleaningType } from "@shared/pricing";
import { _resetRateLimits } from "./antiSpam";
import { adminRouter } from "./routers/admin";
import { bookingRouter, finalizeBooking, occupiedIntervals } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

/** A Wednesday: open 8:00–18:00 under the default schedule. */
const WEDNESDAY = "2026-08-19";
const ALL_SERVICES: CleaningType[] = ["residential", "commercial", "airbnb", "moveinout", "deep", "office"];

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("duration defaults", () => {
  it("gives every service type a usable duration at every size", () => {
    for (const type of ALL_SERVICES) {
      for (const sqft of [200, 999, 1000, 1500, 2000, 3500, 8000]) {
        const hours = durationHoursFor(type, sqft);
        expect(Number.isInteger(hours), `${type} @ ${sqft}`).toBe(true);
        expect(hours, `${type} @ ${sqft}`).toBeGreaterThan(0);
        expect(hours, `${type} @ ${sqft}`).toBeLessThanOrEqual(MAX_DURATION_HOURS);
      }
    }
  });

  it("grows with the home", () => {
    expect(durationHoursFor("residential", 800)).toBe(2);
    expect(durationHoursFor("residential", 1500)).toBe(3);
    expect(durationHoursFor("residential", 3000)).toBe(4);
    expect(durationHoursFor("residential", 5000)).toBe(5);
  });

  it("runs deep cleans and move in/outs longer than a standard clean", () => {
    for (const sqft of [800, 1500, 3000, 5000]) {
      expect(durationHoursFor("deep", sqft)).toBeGreaterThan(durationHoursFor("residential", sqft));
      expect(durationHoursFor("moveinout", sqft)).toBeGreaterThan(durationHoursFor("residential", sqft));
    }
  });

  it("bounds are exclusive, exactly like the pricing ladder", () => {
    // A 1,000 sq ft home falls past the "under 1,000" band for its duration in
    // the same way it does for its price — one rule for both ladders.
    expect(durationHoursFor("residential", 999)).toBe(2);
    expect(durationHoursFor("residential", 1000)).toBe(3);
  });

  it("prices Airbnb turnovers off the residential ladder, as their price is", () => {
    for (const sqft of [800, 1500, 3000]) {
      expect(durationHoursFor("airbnb", sqft)).toBe(durationHoursFor("residential", sqft));
    }
  });

  it("gives the flat services a block that ignores size", () => {
    for (const type of DURATION_FLAT_TYPES) {
      expect(durationHoursFor(type, 500)).toBe(durationHoursFor(type, 9000));
      expect(durationHoursFor(type, 500)).toBe(DEFAULT_DURATIONS.flatHours[type]);
    }
  });

  it("never returns zero for a service it has never heard of", () => {
    // A zero-hour job would block nothing, which is the bug this exists to fix.
    expect(durationHoursFor("some_new_service", 1200)).toBeGreaterThan(0);
  });
});

describe("duration config validation (write path)", () => {
  const valid = () => JSON.parse(serializeDurationConfig(DEFAULT_DURATIONS));

  it("accepts the defaults", () => {
    expect(validateDurationConfig(valid()).ok).toBe(true);
    expect(validateDurationConfig(serializeDurationConfig(DEFAULT_DURATIONS)).ok).toBe(true);
  });

  it("refuses thresholds that do not increase", () => {
    const config = valid();
    config.ladders.residential = [{ maxSqft: 2000, hours: 2 }, { maxSqft: 1000, hours: 3 }, { maxSqft: null, hours: 4 }];
    const result = validateDurationConfig(config);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/must be greater than/i);
  });

  it("refuses a ladder with no open-ended band", () => {
    const config = valid();
    config.ladders.deep = [{ maxSqft: 1000, hours: 3 }];
    const result = validateDurationConfig(config);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/unbounded/i);
  });

  it("refuses an open-ended band anywhere but last", () => {
    const config = valid();
    config.ladders.deep = [{ maxSqft: null, hours: 3 }, { maxSqft: 2000, hours: 4 }];
    const result = validateDurationConfig(config);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/must be the last one/i);
  });

  it("refuses hours that are zero, negative, fractional, or over the cap", () => {
    for (const hours of [0, -2, 2.5, MAX_DURATION_HOURS + 1]) {
      const config = valid();
      config.ladders.residential[0].hours = hours;
      const result = validateDurationConfig(config);
      expect(result.ok, `hours=${hours}`).toBe(false);
      expect(result.ok === false && result.errors.join(" ")).toMatch(/whole number between 1 and|hours/i);
    }
  });

  it("accepts hours at both ends of the allowed range", () => {
    for (const hours of [1, MAX_DURATION_HOURS]) {
      const config = valid();
      config.ladders.residential[0].hours = hours;
      expect(validateDurationConfig(config).ok, `hours=${hours}`).toBe(true);
    }
  });

  it("refuses a non-positive or fractional threshold", () => {
    for (const maxSqft of [0, -500, 1000.5]) {
      const config = valid();
      config.ladders.residential[0].maxSqft = maxSqft;
      expect(validateDurationConfig(config).ok, `maxSqft=${maxSqft}`).toBe(false);
    }
  });

  it("caps how many bands a service may have", () => {
    const config = valid();
    config.ladders.residential = [
      ...Array.from({ length: MAX_DURATION_TIERS_PER_SERVICE }, (_, i) => ({ maxSqft: (i + 1) * 100, hours: 2 })),
      { maxSqft: null, hours: 5 },
    ];
    expect(validateDurationConfig(config).ok).toBe(false);
  });

  it("refuses flat hours outside the range, and demands both services", () => {
    const tooBig = valid();
    tooBig.flatHours.commercial = MAX_DURATION_HOURS + 1;
    expect(validateDurationConfig(tooBig).ok).toBe(false);

    const missing = valid();
    delete missing.flatHours.office;
    expect(validateDurationConfig(missing).ok).toBe(false);
  });

  it("refuses input that is not JSON at all", () => {
    expect(validateDurationConfig("not json").ok).toBe(false);
    expect(validateDurationConfig({}).ok).toBe(false);
    expect(validateDurationConfig(null).ok).toBe(false);
  });
});

describe("duration config parsing (read path)", () => {
  it("falls back to the defaults on anything missing or broken", () => {
    // Falling back to "no duration" would silently switch the blocking off.
    for (const raw of [null, undefined, "", "not json", "{}", '{"ladders":{}}']) {
      expect(parseDurationConfig(raw)).toEqual(DEFAULT_DURATIONS);
    }
  });

  it("round-trips a valid config, restoring the open-ended band", () => {
    const restored = parseDurationConfig(serializeDurationConfig(DEFAULT_DURATIONS));
    expect(restored).toEqual(DEFAULT_DURATIONS);
    expect(restored.ladders.residential[restored.ladders.residential.length - 1]!.maxSqft).toBe(Infinity);
  });

  it("sorts bands so lookup order is right however they were stored", () => {
    const scrambled: DurationConfig = {
      ...DEFAULT_DURATIONS,
      ladders: {
        ...DEFAULT_DURATIONS.ladders,
        residential: [
          { maxSqft: Infinity, hours: 9 },
          { maxSqft: 1000, hours: 2 },
          { maxSqft: 2000, hours: 4 },
        ],
      },
    };
    const parsed = parseDurationConfig(serializeDurationConfig(scrambled));
    expect(parsed.ladders.residential.map(b => b.maxSqft)).toEqual([1000, 2000, Infinity]);
    expect(durationHoursFor("residential", 500, parsed)).toBe(2);
    expect(durationHoursFor("residential", 9000, parsed)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Interval arithmetic
// ---------------------------------------------------------------------------

describe("what a job covers", () => {
  it("covers every hour it runs, and stops at the one it ends on", () => {
    // The case from the brief: 11:00 + 3h takes 11, 12 and 1, and leaves 2 free.
    expect(slotsCoveredBy("11:00", 3)).toEqual(["11:00", "12:00", "13:00"]);
    expect(slotsCoveredBy("11:00", 3)).not.toContain("14:00");
  });

  it("covers exactly its own hour at one hour long", () => {
    expect(slotsCoveredBy("09:00", 1)).toEqual(["09:00"]);
  });

  it("includes the lunch hour it works through", () => {
    // 12:00 is never offered as a start, but a crew running 11:00–14:00 is
    // genuinely there at noon.
    expect(slotsCoveredBy("11:00", 3)).toContain("12:00");
  });

  it("reports the hour it ends", () => {
    expect(intervalEndTime("11:00", 3)).toBe("14:00");
    expect(intervalEndTime("09:00", 1)).toBe("10:00");
    // A long job late in the day clamps at midnight rather than rolling over.
    expect(intervalEndTime("23:00", 4)).toBe("24:00");
  });

  it("formats the span for the crew and admin views", () => {
    expect(formatJobSpan("11:00", 4)).toBe("11:00–15:00 · est. 4h");
  });
});

describe("overlap at the boundaries", () => {
  const job = { time: "11:00", hours: 3 }; // [11, 14)

  it("does not overlap a job that ends exactly when it starts", () => {
    expect(intervalsOverlap(job, { time: "09:00", hours: 2 })).toBe(false); // [9,11)
  });

  it("does not overlap a job that starts exactly when it ends", () => {
    expect(intervalsOverlap(job, { time: "14:00", hours: 2 })).toBe(false); // [14,16)
  });

  it("overlaps a job starting one hour inside", () => {
    expect(intervalsOverlap(job, { time: "13:00", hours: 2 })).toBe(true);
  });

  it("overlaps a job that ends one hour inside", () => {
    expect(intervalsOverlap(job, { time: "09:00", hours: 3 })).toBe(true); // [9,12)
  });

  it("overlaps an identical start", () => {
    expect(intervalsOverlap(job, { time: "11:00", hours: 1 })).toBe(true);
  });

  it("overlaps a job that swallows it whole", () => {
    expect(intervalsOverlap(job, { time: "08:00", hours: 9 })).toBe(true);
  });

  it("is symmetric", () => {
    const other = { time: "13:00", hours: 2 };
    expect(intervalsOverlap(job, other)).toBe(intervalsOverlap(other, job));
  });

  it("finds an overlap anywhere in the day's list", () => {
    const day = [
      { time: "08:00", hours: 2 },
      { time: "13:00", hours: 2 },
    ];
    expect(overlapsAny(job, day)).toBe(true);
    expect(overlapsAny({ time: "16:00", hours: 2 }, day)).toBe(false);
    expect(overlapsAny(job, [])).toBe(false);
  });
});

describe("finishing before closing time", () => {
  it("allows a job that ends exactly at close", () => {
    // Default Wednesday closes at 18:00, so a 4-hour job may start at 14:00.
    expect(fitsBeforeClose("14:00", 4, WEDNESDAY, DEFAULT_SCHEDULE)).toBe(true);
  });

  it("refuses one that would run an hour past", () => {
    expect(fitsBeforeClose("15:00", 4, WEDNESDAY, DEFAULT_SCHEDULE)).toBe(false);
  });

  it("refuses everything on a closed day", () => {
    expect(fitsBeforeClose("10:00", 1, "2026-08-16", DEFAULT_SCHEDULE)).toBe(false);
  });

  it("follows an admin-shortened day", () => {
    const short = { ...DEFAULT_SCHEDULE, 3: { open: true, start: 8, end: 12 } };
    expect(fitsBeforeClose("10:00", 2, WEDNESDAY, short)).toBe(true);
    expect(fitsBeforeClose("11:00", 2, WEDNESDAY, short)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Well clear of any lead time, so these cases are only about duration. */
const LONG_BEFORE = new Date(slotStartInstant(WEDNESDAY, "08:00") - 72 * 3_600_000);

describe("duration blocking composes with the other rules", () => {
  const base = { date: WEDNESDAY, schedule: DEFAULT_SCHEDULE, leadTimeHours: 3, now: LONG_BEFORE };

  it("takes every hour a job runs off the calendar", () => {
    const slots = bookableSlots({ ...base, occupied: [{ time: "11:00", hours: 3 }], jobHours: 1 });
    // 11 and 13 are gone (12 is the lunch gap and never offered); 14 survives.
    expect(slots).not.toContain("11:00");
    expect(slots).not.toContain("13:00");
    expect(slots).toContain("14:00");
    expect(slots).toContain("10:00");
  });

  it("blocks an earlier start that would run into a later job", () => {
    // A 2-hour job at 10:00 would still be going when the 11:00 job begins.
    const context = { ...base, occupied: [{ time: "11:00", hours: 3 }] };
    expect(isSlotBookable({ ...context, jobHours: 2 }, "10:00")).toBe(false);
    expect(isSlotBookable({ ...context, jobHours: 1 }, "10:00")).toBe(true);
  });

  it("withholds a start too late in the day for the job to finish", () => {
    const forFourHours = bookableSlots({ ...base, occupied: [], jobHours: 4 });
    expect(forFourHours).toContain("14:00"); // 14:00 + 4h = 18:00, exactly close
    expect(forFourHours).not.toContain("15:00");
    expect(forFourHours).not.toContain("17:00");
    // A short job still gets the late slots.
    expect(bookableSlots({ ...base, occupied: [], jobHours: 1 })).toContain("17:00");
  });

  it("still applies the lead time", () => {
    const insideWindow = new Date(slotStartInstant(WEDNESDAY, "09:00"));
    const slots = bookableSlots({ ...base, occupied: [], jobHours: 2, now: insideWindow });
    expect(slots).not.toContain("10:00"); // one hour out, inside a 3-hour notice
    expect(slots).toContain("13:00");
  });

  it("still respects a closed day, whatever the duration", () => {
    expect(bookableSlots({ ...base, date: "2026-08-16", occupied: [], jobHours: 1 })).toEqual([]);
  });

  it("returns nothing bookable for a day fully committed", () => {
    const allDay = [{ time: "08:00", hours: 10 }];
    expect(bookableSlots({ ...base, occupied: allDay, jobHours: 1 })).toEqual([]);
  });

  it("checks the job's own hour even when its duration is unknown", () => {
    // The calendar can open before the quote is finished; the start hour is
    // still the minimum any job needs.
    const context = { ...base, occupied: [{ time: "11:00", hours: 3 }] };
    expect(isSlotBookable(context, "11:00")).toBe(false);
    expect(isSlotBookable(context, "13:00")).toBe(false);
    expect(isSlotBookable(context, "14:00")).toBe(true);
    // And with no duration to check, the closing-time rule stands down.
    expect(isSlotBookable({ ...base, occupied: [] }, "17:00")).toBe(true);
  });
});

describe("releasing a booking frees its whole span", () => {
  const base = {
    date: WEDNESDAY,
    schedule: DEFAULT_SCHEDULE,
    leadTimeHours: 3,
    now: LONG_BEFORE,
    jobHours: 1,
  };

  it("hands back every hour, not just the start", () => {
    // A cancelled, expired, or stale-unpaid booking stops being returned by
    // getOccupiedBookings at all, so all four of its hours come back at once.
    const held = bookableSlots({ ...base, occupied: [{ time: "10:00", hours: 4 }] });
    expect(held).not.toContain("10:00");
    expect(held).not.toContain("11:00");
    expect(held).not.toContain("13:00");

    const released = bookableSlots({ ...base, occupied: [] });
    for (const time of ["10:00", "11:00", "13:00"]) expect(released).toContain(time);
  });
});

// ---------------------------------------------------------------------------
// Storage choice: the duration is pinned on the booking
// ---------------------------------------------------------------------------

describe("a booking keeps the duration it was made with", () => {
  const longerLadder: DurationConfig = {
    ...DEFAULT_DURATIONS,
    ladders: {
      ...DEFAULT_DURATIONS.ladders,
      residential: [{ maxSqft: Infinity, hours: 6 }],
    },
  };

  it("uses the stored hours, not what the ladder says today", () => {
    // The reason this column exists: raising the ladder must not stretch a
    // booking that is already paid for into its neighbour.
    const rows = [{ time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 3 }];
    expect(occupiedIntervals(rows, longerLadder)).toEqual([{ time: "10:00", hours: 3 }]);
  });

  it("falls back to the current ladder for rows that predate the column", () => {
    const rows = [{ time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: null }];
    expect(occupiedIntervals(rows, longerLadder)).toEqual([{ time: "10:00", hours: 6 }]);
  });

  it("keeps an existing booking's neighbours bookable after the ladder grows", () => {
    const occupied = occupiedIntervals(
      [{ time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 2 }],
      longerLadder
    );
    const slots = bookableSlots({
      date: WEDNESDAY,
      schedule: DEFAULT_SCHEDULE,
      leadTimeHours: 3,
      now: LONG_BEFORE,
      occupied,
      jobHours: 1,
    });
    // Stored 2 hours: 10 and 11 are taken, 13 is free. Under the new 6-hour
    // ladder it would have swallowed 13 as well.
    expect(slots).not.toContain("11:00");
    expect(slots).toContain("13:00");
  });
});

// ---------------------------------------------------------------------------
// Through the router
// ---------------------------------------------------------------------------

const publicCaller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

/** getSetting answers per key so a test can set just the ladder. */
function settings(overrides: { leadTime?: string; durations?: DurationConfig } = {}) {
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === LEAD_TIME_SETTING_KEY) return overrides.leadTime ?? "0";
    if (key === DURATION_SETTING_KEY) return overrides.durations ? serializeDurationConfig(overrides.durations) : null;
    if (key === SCHEDULE_SETTING_KEY) return null;
    return null;
  });
}

const occupying = (time: string, hours: number, id = 7) => ({
  id,
  time,
  serviceType: "residential",
  sqft: 900,
  estimatedHours: hours,
});

const createInput = {
  quote: {
    type: "deep" as const,
    bedrooms: 3,
    bathrooms: 2,
    sqft: 2500, // deep @ 2,500 → 5 hours by default
    extras: [],
    frequency: "onetime" as const,
  },
  date: WEDNESDAY,
  time: "09:00",
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
  vi.setSystemTime(LONG_BEFORE);
  settings();
  mockSetSetting.mockReset().mockResolvedValue(undefined);
  mockGetOccupiedBookings.mockReset().mockResolvedValue([]);
  mockCreateBooking.mockReset().mockResolvedValue(99);
  mockGetBookingById.mockReset();
  mockConfirmUnpaidBooking.mockReset().mockResolvedValue(true);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("booking.availability blocks the whole span", () => {
  it("greys out every hour a live job runs", async () => {
    mockGetOccupiedBookings.mockResolvedValue([occupying("11:00", 3)]);
    const slots = await publicCaller().availability({ date: WEDNESDAY });
    const free = slots.filter(s => s.available).map(s => s.time);
    expect(free).not.toContain("11:00");
    expect(free).not.toContain("13:00");
    expect(free).toContain("14:00");
    // Still the full list, so the calendar does not claim the day is closed.
    expect(slots.map(s => s.time)).toEqual(slotsForDate(WEDNESDAY, DEFAULT_SCHEDULE));
  });

  it("withholds late starts once it knows how long the job is", async () => {
    const withJob = await publicCaller().availability({ date: WEDNESDAY, serviceType: "deep", sqft: 2500 });
    const free = withJob.filter(s => s.available).map(s => s.time);
    // A 5-hour deep clean against an 18:00 close may start no later than 13:00.
    expect(free).toContain("13:00");
    expect(free).not.toContain("14:00");
  });

  it("does not restrict late starts before it knows", async () => {
    const withoutJob = await publicCaller().availability({ date: WEDNESDAY });
    expect(withoutJob.filter(s => s.available).map(s => s.time)).toContain("17:00");
  });

  it("uses the admin's ladder, not the defaults", async () => {
    settings({
      durations: {
        ...DEFAULT_DURATIONS,
        ladders: { ...DEFAULT_DURATIONS.ladders, residential: [{ maxSqft: Infinity, hours: 2 }] },
      },
    });
    const slots = await publicCaller().availability({ date: WEDNESDAY, serviceType: "residential", sqft: 5000 });
    const free = slots.filter(s => s.available).map(s => s.time);
    // Two hours now, so 16:00 is the last start that finishes by 18:00.
    expect(free).toContain("16:00");
    expect(free).not.toContain("17:00");
  });
});

describe("booking.create refuses an overlapping start", () => {
  it("rejects a slot inside a live job's span", async () => {
    mockGetOccupiedBookings.mockResolvedValue([occupying("08:00", 3)]); // [8,11)
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects a start whose own duration would run into a later job", async () => {
    // This 5-hour deep clean at 09:00 runs to 14:00, across a 13:00 booking.
    mockGetOccupiedBookings.mockResolvedValue([occupying("13:00", 1)]);
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
  });

  it("accepts a start that finishes exactly when the next job begins", async () => {
    mockGetOccupiedBookings.mockResolvedValue([occupying("14:00", 1)]);
    await expect(publicCaller().create(createInput)).resolves.toMatchObject({ bookingId: 99 });
  });

  it("rejects a start too late to finish before closing", async () => {
    // 14:00 + 5h = 19:00, an hour past the 18:00 close.
    await expect(publicCaller().create({ ...createInput, time: "14:00" })).rejects.toThrow(/not available/i);
  });

  it("says it in Spanish for a Spanish booking", async () => {
    mockGetOccupiedBookings.mockResolvedValue([occupying("08:00", 3)]);
    await expect(publicCaller().create({ ...createInput, locale: "es" })).rejects.toThrow(/no está disponible/i);
  });

  it("pins the duration on the booking it writes", async () => {
    await publicCaller().create(createInput);
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.estimatedHours).toBe(5); // deep @ 2,500 sq ft
  });

  it("pins the duration from the verified size, not the entered one", async () => {
    const property = await import("./property");
    vi.mocked(property.lookupPropertySqft).mockResolvedValueOnce({
      verified: true,
      addressVerified: true,
      sqft: 4000,
      source: "bexar_gis",
    } as never);
    await publicCaller().create(createInput);
    const written = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    // Re-priced up to 4,000 sq ft, so the job is booked as the longer one too.
    expect(written.sqft).toBe(4000);
    expect(written.estimatedHours).toBe(6);
  });

  it("re-checks occupancy after the county lookup, not only before it", async () => {
    // The gap between the two checks is a network round trip. Someone taking
    // overlapping hours inside it must still be caught.
    mockGetOccupiedBookings.mockResolvedValueOnce([]).mockResolvedValue([occupying("10:00", 1)]);
    await expect(publicCaller().create(createInput)).rejects.toThrow(/not available/i);
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(mockGetOccupiedBookings.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("books normally when the day is clear", async () => {
    await expect(publicCaller().create(createInput)).resolves.toMatchObject({ bookingId: 99 });
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });
});

describe("late-payment recovery into an overlap", () => {
  const recovering = {
    id: 42,
    customerId: 7,
    reference: "GFC-DUR42",
    depositAmount: 33,
    couponCode: null,
    extras: "[]",
    scheduledDate: WEDNESDAY,
    scheduledTime: "11:00",
    serviceType: "residential",
    sqft: 1200,
    estimatedHours: 3, // [11, 14)
    status: "expired" as const,
  };

  it("flags slotConflict when another job now runs across its hours", async () => {
    // Nobody starts at 11:00 — an earlier long job simply runs through it, which
    // the old same-start check would have missed entirely.
    mockGetBookingById.mockResolvedValue(recovering);
    mockGetOccupiedBookings.mockResolvedValue([occupying("09:00", 4, 8)]); // [9,13)
    await finalizeBooking(42, "pi_late");
    expect(mockConfirmUnpaidBooking).toHaveBeenCalledWith(42, expect.objectContaining({ slotConflict: true }));
  });

  it("does not flag when the other job ends exactly as this one starts", async () => {
    mockGetBookingById.mockResolvedValue(recovering);
    mockGetOccupiedBookings.mockResolvedValue([occupying("09:00", 2, 8)]); // [9,11)
    await finalizeBooking(42, "pi_late");
    expect(mockConfirmUnpaidBooking).toHaveBeenCalledWith(42, expect.objectContaining({ slotConflict: false }));
  });

  it("never reports a booking as clashing with itself", async () => {
    mockGetBookingById.mockResolvedValue(recovering);
    // The row itself comes back in the occupancy list; it must be excluded.
    mockGetOccupiedBookings.mockResolvedValue([{ ...occupying("11:00", 3), id: 42 }]);
    await finalizeBooking(42, "pi_late");
    expect(mockConfirmUnpaidBooking).toHaveBeenCalledWith(42, expect.objectContaining({ slotConflict: false }));
  });

  it("still confirms the payment either way", async () => {
    mockGetBookingById.mockResolvedValue(recovering);
    mockGetOccupiedBookings.mockResolvedValue([occupying("09:00", 4, 8)]);
    await finalizeBooking(42, "pi_late");
    // A paid deposit is never dropped — the owner is warned, not the customer.
    expect(mockConfirmUnpaidBooking).toHaveBeenCalled();
  });
});

describe("saving durations from Admin → Services", () => {
  const adminCaller = () =>
    adminRouter.createCaller({
      user: { id: 1, role: "admin" },
      req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
      res: {},
    } as unknown as TrpcContext);

  it("stores a valid ladder, normalized through the validator", async () => {
    await expect(
      adminCaller().saveDurationConfig({ config: serializeDurationConfig(DEFAULT_DURATIONS) })
    ).resolves.toEqual({ success: true });
    const [key, value] = mockSetSetting.mock.calls[0]!;
    expect(key).toBe(DURATION_SETTING_KEY);
    expect(parseDurationConfig(value as string)).toEqual(DEFAULT_DURATIONS);
  });

  it("refuses a ladder the scheduler would ignore", async () => {
    const broken = JSON.parse(serializeDurationConfig(DEFAULT_DURATIONS));
    broken.ladders.residential = [{ maxSqft: 2000, hours: 2 }, { maxSqft: 1000, hours: 3 }, { maxSqft: null, hours: 4 }];
    await expect(adminCaller().saveDurationConfig({ config: JSON.stringify(broken) })).rejects.toThrow(
      /Invalid job durations/i
    );
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("guards the generic settings endpoint too", async () => {
    await expect(
      adminCaller().saveSetting({ key: DURATION_SETTING_KEY, value: '{"ladders":{}}' })
    ).rejects.toThrow(/Invalid job durations/i);
  });

  it("hands the editor the live ladder", async () => {
    settings({
      durations: {
        ...DEFAULT_DURATIONS,
        ladders: { ...DEFAULT_DURATIONS.ladders, residential: [{ maxSqft: Infinity, hours: 7 }] },
      },
    });
    const config = await adminCaller().durationConfig();
    expect(config.ladders.residential).toEqual([{ maxSqft: Infinity, hours: 7 }]);
  });
});
