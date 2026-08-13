/**
 * One live booking per slot, enforced by the database.
 *
 * The availability check in booking.create reads the calendar and then inserts,
 * so two customers submitting the same slot at the same time could both pass
 * it. The unique index on the generated slotKey column is what actually
 * decides; these tests cover the DDL that creates it, the status rule it
 * encodes, and how booking.create reports a collision to the customer.
 *
 * The index's runtime behaviour is MySQL's own and is not exercised here — no
 * MySQL in this environment. What is pinned is everything around it: the
 * migration that installs it, the status set it keys off, and the fact that a
 * violation surfaces as the ordinary "pick another time" message.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockExpireStaleForSlot = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    getSetting: vi.fn().mockResolvedValue(null),
    getBookedSlots: vi.fn().mockResolvedValue([]),
    getCouponByCode: vi.fn().mockResolvedValue(undefined),
    findOrCreateCustomer: vi.fn().mockResolvedValue(7),
    createBooking: (...args: unknown[]) => mockCreateBooking(...args),
    updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
    getBookingById: vi.fn().mockResolvedValue(undefined),
    getBalanceInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
    expireStaleBookingsForSlot: (...args: unknown[]) => mockExpireStaleForSlot(...args),
    // The real discriminator — this is part of what's under test.
    isSlotTakenError: actual.isSlotTakenError,
  };
});

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

import { bookings, SLOT_HOLDING_STATUSES, SLOT_UNIQUE_INDEX } from "../drizzle/schema";
import { _resetRateLimits } from "./antiSpam";
import { isSlotTakenError } from "./db";
import { adminRouter } from "./routers/admin";
import { bookingRouter } from "./routers/booking";
import { staffRouter } from "./routers/staff";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "..", "drizzle");

/** The migration that installs the constraint, found by content so renumbering can't break this. */
function slotMigrationSql(): string {
  const files = readdirSync(DRIZZLE_DIR).filter(f => f.endsWith(".sql"));
  const matches = files
    .map(f => readFileSync(path.join(DRIZZLE_DIR, f), "utf8"))
    .filter(sql => sql.includes("slotKey"));
  expect(matches, "no migration installs slotKey").toHaveLength(1);
  return matches[0]!;
}

/** MySQL duplicate-key error as mysql2 raises it. */
const dupError = (key: string, entry = "2026-07-20T10:00") =>
  Object.assign(new Error(`Duplicate entry '${entry}' for key '${key}'`), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
  });

describe("the slot constraint's migration", () => {
  const sql = slotMigrationSql();

  it("adds slotKey as a generated column, so no code path can leave it stale", () => {
    expect(sql).toMatch(/ADD `slotKey`/);
    expect(sql).toMatch(/GENERATED ALWAYS AS/);
  });

  it("nulls the key out for exactly the statuses that release the slot", () => {
    expect(sql).toContain("'cancelled'");
    expect(sql).toContain("'expired'");
    // NULLs are what let a released slot be reused: MySQL allows many of them
    // in a unique index, which is how this stands in for a partial index.
    expect(sql).toMatch(/then null/i);
    for (const status of SLOT_HOLDING_STATUSES) {
      expect(sql, `${status} must not be excluded from the constraint`).not.toContain(`'${status}'`);
    }
  });

  it("keys on the date and time together", () => {
    expect(sql).toMatch(/concat\(`scheduledDate`, 'T', `scheduledTime`\)/);
  });

  it("puts a unique index on it under the name the error check looks for", () => {
    expect(sql).toContain(SLOT_UNIQUE_INDEX);
    expect(sql).toMatch(/UNIQUE\(`slotKey`\)/);
  });
});

describe("slot-holding statuses", () => {
  it("covers every booking status except the two that release the slot", () => {
    const all = bookings.status.enumValues;
    const released = all.filter(s => !SLOT_HOLDING_STATUSES.includes(s as never));
    // Guards against a new status silently defaulting to "does not hold a slot".
    expect(released.sort()).toEqual(["cancelled", "expired"]);
  });
});

describe("isSlotTakenError", () => {
  it("recognises a duplicate on the slot index", () => {
    expect(isSlotTakenError(dupError("bookings.bookings_slotKey_unique"))).toBe(true);
    expect(isSlotTakenError(dupError("bookings_slotKey_unique"))).toBe(true);
  });

  it("unwraps a driver error the ORM wrapped in a cause", () => {
    const wrapped = Object.assign(new Error("query failed"), {
      cause: dupError("bookings.bookings_slotKey_unique"),
    });
    expect(isSlotTakenError(wrapped)).toBe(true);
  });

  it("does not mistake a reference collision for a taken slot", () => {
    // bookings.reference is unique too; that one needs a retry, not a "pick
    // another time" message.
    expect(isSlotTakenError(dupError("bookings.reference", "GFC-ABC123"))).toBe(false);
  });

  it("ignores unrelated failures", () => {
    expect(isSlotTakenError(new Error("connection lost"))).toBe(false);
    expect(isSlotTakenError(Object.assign(new Error("nope"), { code: "ER_NO_SUCH_TABLE" }))).toBe(false);
    expect(isSlotTakenError(null)).toBe(false);
    expect(isSlotTakenError(undefined)).toBe(false);
  });

  it("terminates on a self-referencing cause chain", () => {
    const loop: { cause?: unknown; message: string } = { message: "boom" };
    loop.cause = loop;
    expect(isSlotTakenError(loop)).toBe(false);
  });
});

const caller = () =>
  bookingRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });

const input = {
  quote: {
    type: "residential" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: 1200,
    extras: [],
    frequency: "onetime" as const,
  },
  date: OPEN_MONDAY, // Monday, a week out — open, and clear of the lead time
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
  mockCreateBooking.mockReset().mockResolvedValue(99);
  mockUpdateBooking.mockReset().mockResolvedValue(undefined);
  mockExpireStaleForSlot.mockReset().mockResolvedValue(0);
  mockSessionCreate.mockReset().mockResolvedValue({ id: "cs_1", url: "https://stripe.test/pay" });
});

describe("booking.create against the constraint", () => {
  it("hands back the slot an abandoned checkout is still holding, before inserting", async () => {
    await caller().create(input);
    expect(mockExpireStaleForSlot).toHaveBeenCalledWith(OPEN_MONDAY, "10:00");
    // Order matters: releasing the slot after the insert would be too late.
    expect(mockExpireStaleForSlot.mock.invocationCallOrder[0]!).toBeLessThan(
      mockCreateBooking.mock.invocationCallOrder[0]!
    );
  });

  it("turns a constraint violation into the ordinary 'choose another time' message", async () => {
    mockCreateBooking.mockRejectedValue(dupError("bookings.bookings_slotKey_unique"));
    await expect(caller().create(input)).rejects.toThrow(/not available/i);
  });

  it("says it in Spanish for a Spanish booking", async () => {
    mockCreateBooking.mockRejectedValue(dupError("bookings.bookings_slotKey_unique"));
    await expect(caller().create({ ...input, locale: "es" })).rejects.toThrow(/no está disponible/i);
  });

  it("never charges for a booking that lost the race", async () => {
    mockCreateBooking.mockRejectedValue(dupError("bookings.bookings_slotKey_unique"));
    await expect(caller().create(input)).rejects.toThrow();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("lets an unrelated database failure surface instead of blaming the slot", async () => {
    mockCreateBooking.mockRejectedValue(new Error("connection lost"));
    await expect(caller().create(input)).rejects.toThrow(/connection lost/i);
  });

  it("still books normally when the slot is free", async () => {
    const result = await caller().create(input);
    expect(result.reference).toMatch(/^GFC-[A-Z0-9]{6}$/);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cancelled and expired bookings null out their slotKey, so putting one back to
 * a slot-holding status makes it claim the slot again — which the index refuses
 * if someone else took it meanwhile. Both dashboards have to explain that
 * rather than leak a database error at the user.
 */
describe("reviving a released booking into a slot that was retaken", () => {
  const ctx = (role: "admin" | "staff") =>
    ({
      user: { id: 1, role },
      req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
      res: {},
    }) as unknown as TrpcContext;

  it("admin gets a clear conflict, not a server error", async () => {
    mockUpdateBooking.mockRejectedValue(dupError("bookings.bookings_slotKey_unique"));
    await expect(
      adminRouter.createCaller(ctx("admin")).updateBookingStatus({ id: 42, status: "confirmed" })
    ).rejects.toThrow(/already holds that date and time/i);
  });

  it("staff get the same explanation", async () => {
    mockUpdateBooking.mockRejectedValue(dupError("bookings.bookings_slotKey_unique"));
    await expect(
      staffRouter.createCaller(ctx("staff")).updateJobStatus({ bookingId: 42, status: "completed" })
    ).rejects.toThrow(/already holds that date and time/i);
  });

  it("an unrelated database failure is not reported as a slot conflict", async () => {
    mockUpdateBooking.mockRejectedValue(new Error("deadlock found when trying to get lock"));
    await expect(
      adminRouter.createCaller(ctx("admin")).updateBookingStatus({ id: 42, status: "confirmed" })
    ).rejects.toThrow(/deadlock/i);
  });

  it("an ordinary status change still succeeds", async () => {
    mockUpdateBooking.mockResolvedValue(undefined);
    await expect(
      adminRouter.createCaller(ctx("admin")).updateBookingStatus({ id: 42, status: "cancelled" })
    ).resolves.toEqual({ success: true });
  });
});
