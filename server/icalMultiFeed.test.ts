/**
 * Test B — several Airbnb calendars feed one company calendar with no
 * duplicates, and a change on the host's side lands as one move, not a churn.
 *
 * What this pins on top of icalSync.test.ts:
 *   - every connected property polls its own feed, and the same reservation UID
 *     in two different feeds is two cleanings (two units), never a collision;
 *   - one listing connects once: a second property on the same feed URL is
 *     refused at save time, in both the create and edit paths;
 *   - one unit checks out once a day: a second reservation UID on a checkout
 *     day that already has a live turnover is skipped, and takes the cancelled
 *     one's place within the same poll when the first vanishes;
 *   - the poll compares the FEED's last date (icalSourceDate), so a turnover
 *     the owner moved by hand stays where it was put — the column the sync
 *     wrote under the wrong name (icalCheckoutDate) never reached the row;
 *   - the sync's own moves no longer have their host notice pre-claimed by the
 *     atomic move, so a genuine host date change still emails the host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockCreateBooking = vi.fn();
const mockUpdateBooking = vi.fn();
const mockListAutoBookings = vi.fn();
const mockUpdateProperty = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetBookingById = vi.fn();
const mockMoveBookingSchedule = vi.fn();
const mockClaimTurnoverNotice = vi.fn();
const mockListActiveProperties = vi.fn();
const mockFindByUrl = vi.fn();
const mockCreateProperty = vi.fn();
const mockGetPropertyById = vi.fn();
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
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    moveBookingSchedule: (...a: unknown[]) => mockMoveBookingSchedule(...a),
    getEmployeeById: vi.fn().mockResolvedValue(undefined),
    claimTurnoverNotice: (...a: unknown[]) => mockClaimTurnoverNotice(...a),
    listActiveSyncProperties: (...a: unknown[]) => mockListActiveProperties(...a),
    findConnectedPropertyByIcalUrl: (...a: unknown[]) => mockFindByUrl(...a),
    createConnectedProperty: (...a: unknown[]) => mockCreateProperty(...a),
    getConnectedPropertyById: (...a: unknown[]) => mockGetPropertyById(...a),
  };
});

vi.mock("./_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { __resetTransporter } from "./emails";
import { syncAllProperties, syncConnectedProperty } from "./icalSync";
import { adminRouter } from "./routers/admin";
import { upcomingMonday } from "./testDates";
import type { ConnectedProperty } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const MONDAY = upcomingMonday();
const plusDays = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const TUESDAY = plusDays(MONDAY, 1);
const WEDNESDAY = plusDays(MONDAY, 2);

const RIVERWALK_URL = "https://www.airbnb.com/calendar/ical/123.ics";
const PEARL_URL = "https://www.airbnb.com/calendar/ical/456.ics";

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
    icalUrl: RIVERWALK_URL,
    defaultTime: "11:00",
    active: true,
    autoBook: true,
    perCleanEmails: false,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastSyncStatus: null,
    reservationCount: null,
    consecutiveFailures: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ConnectedProperty;

function feedWith(reservations: { uid: string; checkout: string; nights?: number }[]): string {
  const events = reservations
    .map(r => {
      const start = plusDays(r.checkout, -(r.nights ?? 2)).replace(/-/g, "");
      const end = r.checkout.replace(/-/g, "");
      return ["BEGIN:VEVENT", `UID:${r.uid}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, "SUMMARY:Reserved", "END:VEVENT"].join("\r\n");
    })
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR`;
}

/** One stub answering each feed URL with its own document. */
function stubFeeds(bodies: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = bodies[url];
      return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? "" };
    })
  );
}

const autoRow = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "GFC-AUTO1",
  customerId: 7,
  propertyId: 5,
  icalUid: "res-A",
  kind: "ical_auto",
  serviceType: "airbnb",
  sqft: 900,
  estimatedHours: 2,
  scheduledDate: MONDAY,
  scheduledTime: "11:00",
  icalSourceDate: MONDAY,
  status: "confirmed",
  totalAmount: 90,
  depositAmount: 0,
  createdAt: new Date(),
  ...overrides,
});

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
  } as unknown as TrpcContext);

const subjects = () => mockSendMail.mock.calls.map(c => (c[0] as { subject: string }).subject);

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
  mockGetCustomerById.mockResolvedValue({ id: 7, firstName: "Hank", email: "hank@example.com", preferredLocale: "en" });
  mockGetBookingById.mockImplementation(async (id: number) => autoRow({ id }));
  mockMoveBookingSchedule.mockImplementation(async (input: { bookingId: number; toDate: string; toTime: string | null }) => {
    const before = autoRow({ id: input.bookingId });
    return { outcome: "moved", before, after: { ...before, scheduledDate: input.toDate, scheduledTime: input.toTime } };
  });
  mockClaimTurnoverNotice.mockResolvedValue(true);
  mockListActiveProperties.mockResolvedValue([]);
  mockFindByUrl.mockResolvedValue(undefined);
  mockCreateProperty.mockResolvedValue(11);
  mockGetPropertyById.mockResolvedValue(property());
  mockNotifyOwner.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("several feeds, one calendar", () => {
  it("polls every active property's own feed and books each one's checkouts", async () => {
    const pearl = property({ id: 6, label: "Pearl loft", icalUrl: PEARL_URL, unitNumber: "3B" });
    mockListActiveProperties.mockResolvedValue([property(), pearl]);
    stubFeeds({
      [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]),
      [PEARL_URL]: feedWith([{ uid: "res-B", checkout: TUESDAY }]),
    });
    const summaries = await syncAllProperties();
    expect(summaries.map(s => [s.propertyId, s.ok, s.created])).toEqual([
      [5, true, 1],
      [6, true, 1],
    ]);
    const rows = mockCreateBooking.mock.calls.map(c => c[0] as Record<string, unknown>);
    expect(rows.map(r => [r.propertyId, r.scheduledDate, r.unitNumber])).toEqual([
      [5, MONDAY, "204"],
      [6, TUESDAY, "3B"],
    ]);
  });

  it("the same reservation UID in two feeds is two units' cleanings, not a clash", async () => {
    // Two listings that happen to share a UID string (different hosts, same
    // generator) each get their booking — idempotency is per (property, uid).
    const pearl = property({ id: 6, label: "Pearl loft", icalUrl: PEARL_URL });
    mockListActiveProperties.mockResolvedValue([property(), pearl]);
    stubFeeds({
      [RIVERWALK_URL]: feedWith([{ uid: "shared-uid", checkout: MONDAY }]),
      [PEARL_URL]: feedWith([{ uid: "shared-uid", checkout: MONDAY }]),
    });
    const summaries = await syncAllProperties();
    expect(summaries.map(s => s.created)).toEqual([1, 1]);
    expect(mockCreateBooking).toHaveBeenCalledTimes(2);
  });

  it("one property's failure never stops the next one's sync", async () => {
    const pearl = property({ id: 6, label: "Pearl loft", icalUrl: PEARL_URL });
    mockListActiveProperties.mockResolvedValue([property(), pearl]);
    stubFeeds({ [PEARL_URL]: feedWith([{ uid: "res-B", checkout: TUESDAY }]) }); // Riverwalk 404s
    const summaries = await syncAllProperties();
    expect(summaries[0]).toMatchObject({ propertyId: 5, ok: false });
    expect(summaries[1]).toMatchObject({ propertyId: 6, ok: true, created: 1 });
  });
});

describe("one listing connects once", () => {
  const input = {
    customerId: 7,
    label: "Riverwalk again",
    addressLine: "100 River St",
    sqft: 900,
    icalUrl: `  ${RIVERWALK_URL}  `,
  };

  it("refuses a second property on a feed URL that is already connected", async () => {
    mockFindByUrl.mockResolvedValue(property());
    stubFeeds({ [RIVERWALK_URL]: feedWith([]) });
    await expect(adminCaller().createProperty(input)).rejects.toThrow(/already connected as "Riverwalk condo"/);
    // Judged on the trimmed URL, and refused before the feed is even fetched.
    expect(mockFindByUrl).toHaveBeenCalledWith(RIVERWALK_URL);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockCreateProperty).not.toHaveBeenCalled();
  });

  it("connects a fresh feed, stored trimmed", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    const result = await adminCaller().createProperty(input);
    expect(result).toMatchObject({ id: 11, reservationsFound: 1 });
    expect(mockCreateProperty).toHaveBeenCalledWith(expect.objectContaining({ icalUrl: RIVERWALK_URL }));
  });

  it("refuses moving a property onto another property's feed, but allows its own", async () => {
    const pearl = property({ id: 6, label: "Pearl loft", icalUrl: PEARL_URL });
    mockGetPropertyById.mockResolvedValue(pearl);
    mockFindByUrl.mockResolvedValue(property()); // Riverwalk owns RIVERWALK_URL
    stubFeeds({ [RIVERWALK_URL]: feedWith([]) });
    await expect(adminCaller().updateProperty({ id: 6, icalUrl: RIVERWALK_URL })).rejects.toThrow(/already connected/);
    expect(mockUpdateProperty).not.toHaveBeenCalled();

    // Re-saving a property with its own URL is not a duplicate.
    mockFindByUrl.mockResolvedValue(pearl);
    stubFeeds({ [PEARL_URL]: feedWith([]) });
    await expect(adminCaller().updateProperty({ id: 6, icalUrl: PEARL_URL, label: "Pearl loft 3B" })).resolves.toMatchObject({ success: true });
  });
});

describe("one unit checks out once a day", () => {
  it("skips a second reservation on a checkout day that already has a live turnover", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }, { uid: "res-B", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([autoRow({ icalUid: "res-A" })]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ ok: true, created: 0, duplicates: 1, cancelled: 0 });
    expect(mockCreateBooking).not.toHaveBeenCalled();
  });

  it("lets a replacement reservation take a vanished one's place within a single poll", async () => {
    // res-A disappeared, res-B checks out the same day: cancel A, create B.
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-B", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([autoRow({ icalUid: "res-A" })]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ cancelled: 1, created: 1, duplicates: 0 });
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
    expect(mockCreateBooking).toHaveBeenCalledWith(expect.objectContaining({ icalUid: "res-B", scheduledDate: MONDAY }));
  });

  it("two checkouts on different days are two cleanings", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }, { uid: "res-B", checkout: TUESDAY }]) });
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ created: 2, duplicates: 0 });
  });

  it("a cancelled twin does not block the day", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-B", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([autoRow({ icalUid: "res-A", status: "cancelled" })]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ created: 1, duplicates: 0 });
  });
});

describe("a hand move survives the next poll", () => {
  it("leaves a turnover the owner moved to another day exactly where it is", async () => {
    // Feed still says MONDAY; the owner cleans this unit on TUESDAY mornings.
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([
      autoRow({ scheduledDate: TUESDAY, scheduledTime: "09:00", icalSourceDate: MONDAY }),
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ ok: true, moved: 0, created: 0, cancelled: 0 });
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
    expect(mockUpdateBooking).not.toHaveBeenCalled();
    expect(subjects()).toHaveLength(0);
  });

  it("still follows a genuine host date change on a hand-moved turnover", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: WEDNESDAY }]) });
    mockListAutoBookings.mockResolvedValue([
      autoRow({ scheduledDate: TUESDAY, scheduledTime: "09:00", icalSourceDate: MONDAY }),
    ]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, toDate: WEDNESDAY, icalSourceDate: WEDNESDAY, actorType: "ical", action: "ical_moved" })
    );
    expect(subjects().some(s => s.includes("Turnover rescheduled") && s.includes(WEDNESDAY))).toBe(true);
  });

  it("a quiet retry places a time-pending turnover on the owner's day, remembering the host's", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([
      autoRow({ scheduledDate: TUESDAY, scheduledTime: null, icalSourceDate: MONDAY }),
    ]);
    // The owner's move already told the host about TUESDAY, so the claim refuses.
    mockClaimTurnoverNotice.mockResolvedValue(false);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ toDate: TUESDAY, icalSourceDate: MONDAY, action: "ical_retry_placed" })
    );
    expect(mockClaimTurnoverNotice).toHaveBeenCalledWith(42, TUESDAY);
    expect(subjects()).toHaveLength(0);
  });

  it("backfills the feed date on a row from before the column was written, and does nothing else", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([autoRow({ icalSourceDate: null })]);
    const summary = await syncConnectedProperty(property());
    expect(summary).toMatchObject({ moved: 0, created: 0, cancelled: 0 });
    expect(mockUpdateBooking).toHaveBeenCalledTimes(1);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { icalSourceDate: MONDAY });
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });

  it("a legacy row with no feed date is still compared by its scheduled date", async () => {
    // The one-time cost of the fix: a row moved by hand BEFORE the column was
    // written looks like a host change on its first post-fix poll and is
    // placed back on the checkout day — after which icalSourceDate is set and
    // every later hand move is respected.
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    mockListAutoBookings.mockResolvedValue([autoRow({ scheduledDate: TUESDAY, icalSourceDate: null })]);
    const summary = await syncConnectedProperty(property());
    expect(summary.moved).toBe(1);
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith(expect.objectContaining({ toDate: MONDAY, icalSourceDate: MONDAY }));
  });

  it("new turnovers carry the feed date under the column's real name", async () => {
    stubFeeds({ [RIVERWALK_URL]: feedWith([{ uid: "res-A", checkout: MONDAY }]) });
    await syncConnectedProperty(property());
    const row = mockCreateBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.icalSourceDate).toBe(MONDAY);
    expect(row).not.toHaveProperty("icalCheckoutDate");
  });
});

describe("the column mismatch cannot come back", () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

  it("no server module writes the phantom icalCheckoutDate key", () => {
    for (const file of ["./icalSync.ts", "./db.ts", "./rescheduling.ts", "./routers/admin.ts", "./brainWriteRoutes.ts"]) {
      expect(source(file), file).not.toContain("icalCheckoutDate");
    }
    expect(source("../drizzle/schema.ts")).toContain('icalSourceDate: varchar("icalSourceDate"');
  });

  it("the atomic move writes icalSourceDate and leaves the sync's own host notice unclaimed", () => {
    const db = source("./db.ts");
    const move = db.slice(db.indexOf("export async function moveBookingSchedule"), db.indexOf("export async function createBookingScheduleEvent"));
    expect(move).toContain("icalSourceDate: input.icalSourceDate");
    expect(move).toContain('before.kind === "ical_auto" && input.actorType !== "ical"');
  });
});
