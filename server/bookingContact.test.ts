/**
 * The owner's view of a booking, and his pen for fixing it.
 *
 * Three things pinned here: the appointments list carries the full contact
 * block (the Details panel's data), no composed address anywhere can render
 * the word "null", and contact fields are editable — on the CUSTOMER record,
 * one person one identity — at any status, with the corrected email reaching
 * a resent deposit link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const mockListBookings = vi.fn();
const mockGetCustomersByIds = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockUpdateCustomer = vi.fn();
const mockUpdateBooking = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    getCustomersByIds: (...a: unknown[]) => mockGetCustomersByIds(...a),
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    updateCustomer: (...a: unknown[]) => mockUpdateCustomer(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getSetting: vi.fn().mockResolvedValue(null),
    listInvoicesAwaitingApproval: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { composeAddress, composeAddressOr } from "@shared/property";
import { __resetTransporter } from "./emails";
import { adminRouter } from "./routers/admin";
import { OPEN_MONDAY } from "./testDates";

const ADMIN_DIR = fileURLToPath(new URL("../client/src/pages/admin", import.meta.url));
const read = (file: string) => readFileSync(join(ADMIN_DIR, file), "utf-8");

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
  } as never);

const staffCaller = () =>
  adminRouter.createCaller({
    user: { id: 9, role: "staff" },
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
  } as never);

const bookingRow = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "GFC-LEAD1",
  customerId: 7,
  kind: "admin",
  status: "pending_deposit",
  serviceType: null,
  frequency: "onetime",
  scheduledDate: null,
  scheduledTime: null,
  bedrooms: 2,
  bathrooms: 1,
  sqft: null,
  estimatedHours: null,
  extras: "[]",
  addressLine: null,
  unitNumber: null,
  propertyType: "house",
  city: null,
  zip: null,
  notes: null,
  locale: "en",
  totalAmount: 0,
  depositAmount: 0,
  couponCode: null,
  discountApplied: 0,
  verifiedSqft: null,
  sqftMismatch: false,
  slotConflict: false,
  employeeId: null,
  hasPayToken: true,
  payTokenExpiresAt: new Date(Date.now() + 20 * 3_600_000),
  adminProvided: null,
  propertyId: null,
  icalUid: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const customer = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  firstName: "Maria",
  lastName: "Lopez",
  email: "typo@exmaple.com",
  phone: "2105550134",
  address: null,
  city: null,
  zip: null,
  preferredLocale: "en",
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  mockListBookings.mockResolvedValue([bookingRow()]);
  mockGetCustomersByIds.mockResolvedValue([customer()]);
  mockGetBookingById.mockResolvedValue(bookingRow());
  mockGetCustomerById.mockResolvedValue(customer());
  mockUpdateCustomer.mockResolvedValue(undefined);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

describe("the appointments list carries the full contact block", () => {
  it("names, phone, email and language ride every row", async () => {
    const rows = await adminCaller().bookings({});
    expect(rows[0]).toMatchObject({
      customerName: "Maria Lopez",
      customerPhone: "2105550134",
      customerEmail: "typo@exmaple.com",
      customerLocale: "en",
    });
  });

  it("a booking whose customer vanished still lists, with empty contact", async () => {
    mockGetCustomersByIds.mockResolvedValue([]);
    const rows = await adminCaller().bookings({});
    expect(rows[0]).toMatchObject({ customerName: "", customerPhone: null, customerEmail: null });
  });

  it("the token itself still never rides along", async () => {
    const rows = await adminCaller().bookings({});
    expect(JSON.stringify(rows)).not.toContain("payToken\":");
  });
});

describe("no composed address ever says 'null'", () => {
  it("absent parts are omitted, wholly-absent addresses fall back", () => {
    expect(composeAddress({ addressLine: null, unitNumber: null, city: null, zip: null })).toBe("");
    expect(composeAddressOr({}, "No address yet")).toBe("No address yet");
    expect(composeAddressOr({ city: "San Antonio" }, "No address yet")).toBe("San Antonio");
  });

  it("survives literal 'null'/'undefined' strings a bad writer might store", () => {
    const composed = composeAddress({
      addressLine: "null" as never,
      unitNumber: "undefined" as never,
      city: "NULL" as never,
      zip: " null " as never,
    });
    expect(composed).toBe("");
    expect(composed).not.toMatch(/null/i);
  });

  it("keeps real addresses intact around absent parts", () => {
    expect(composeAddress({ addressLine: "1 Main St", city: null, zip: "78201" })).toBe("1 Main St, 78201");
  });

  it("every render surface goes through the shared composer", () => {
    const admin = read("AdminAppointments.tsx");
    expect(admin).toContain("composeAddressOr(");
    expect(admin).toContain('"No address yet"');
    expect(admin).not.toMatch(/\{b\.addressLine\}, \{b\.city\}/);
    const staff = readFileSync(
      fileURLToPath(new URL("../client/src/pages/staff/StaffRoutes.tsx", import.meta.url)),
      "utf-8"
    );
    expect(staff).toContain("composeAddress(booking)");
    // Server-side email surfaces: finalize, reminders, balance, resend.
    for (const file of ["routers/booking.ts", "reminders.ts", "balance.ts", "routers/admin.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf-8");
      expect(source, `${file} must compose addresses centrally`).toContain("composeAddress(");
    }
    // The pay page hides the row rather than rendering an empty string.
    const pay = readFileSync(
      fileURLToPath(new URL("../client/src/pages/PayDeposit.tsx", import.meta.url)),
      "utf-8"
    );
    expect(pay).toContain("booking.address &&");
  });
});

describe("editing contact info", () => {
  const edit = {
    bookingId: 42,
    firstName: "Maria",
    lastName: "Lopez",
    email: "maria@example.com",
    phone: "2105550134",
    locale: "es" as const,
  };

  it("lands on the customer record — one person, one identity", async () => {
    await adminCaller().updateBookingContact(edit);
    expect(mockUpdateCustomer).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        firstName: "Maria",
        email: "maria@example.com",
        phone: "2105550134",
        preferredLocale: "es",
      })
    );
    // And the booking carries the language, which drives its emails and page.
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { locale: "es" });
  });

  it("skips the booking write when the language is unchanged", async () => {
    await adminCaller().updateBookingContact({ ...edit, locale: "en" });
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("is allowed at any status — contact is not a price input", async () => {
    for (const status of ["confirmed", "in_progress", "completed", "cancelled"]) {
      mockGetBookingById.mockResolvedValue(bookingRow({ status }));
      await expect(adminCaller().updateBookingContact(edit)).resolves.toMatchObject({ success: true });
    }
  });

  it("rejects a malformed email with a friendly message", async () => {
    await expect(
      adminCaller().updateBookingContact({ ...edit, email: "not-an-email" })
    ).rejects.toThrow(/doesn't look right/i);
    expect(mockUpdateCustomer).not.toHaveBeenCalled();
  });

  it("rejects a malformed phone", async () => {
    await expect(adminCaller().updateBookingContact({ ...edit, phone: "abc" })).rejects.toThrow(
      /doesn't look right/i
    );
  });

  it("refuses to strand the customer with no contact at all", async () => {
    await expect(
      adminCaller().updateBookingContact({ ...edit, email: "", phone: "" })
    ).rejects.toThrow(/at least one way/i);
  });

  it("clearing just the email keeps the phone-only lead honest", async () => {
    await adminCaller().updateBookingContact({ ...edit, email: "" });
    expect(mockUpdateCustomer).toHaveBeenCalledWith(7, expect.objectContaining({ email: null }));
  });

  it("blocks non-admins", async () => {
    await expect(staffCaller().updateBookingContact(edit)).rejects.toThrow(/admin/i);
    expect(mockUpdateCustomer).not.toHaveBeenCalled();
  });
});

describe("the corrected email reaches a resent link", () => {
  it("resend loads the customer fresh and targets the new address", async () => {
    vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
    // The edit has landed on the customer record…
    mockGetCustomerById.mockResolvedValue(customer({ email: "maria@example.com" }));
    mockGetBookingById.mockResolvedValue(bookingRow());
    const result = await adminCaller().resendDepositLink({ id: 42 });
    expect(result.emailSent).toBe(true);
    const to = mockSendMail.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(to).toContain("maria@example.com");
    expect(to).not.toContain("typo@exmaple.com");
    vi.unstubAllEnvs();
  });
});

describe("the Details panel says everything", () => {
  const panel = read("BookingDetails.tsx");

  it("leads with the contact block, then property, then money", () => {
    const contact = panel.indexOf('title="Customer"');
    const property = panel.indexOf('title="Property"');
    const money = panel.indexOf('title="Money"');
    expect(contact).toBeGreaterThan(-1);
    expect(property).toBeGreaterThan(contact);
    expect(money).toBeGreaterThan(property);
  });

  it("phone is tap-to-call and email is mailto", () => {
    expect(panel).toMatch(/href=\{`tel:/);
    expect(panel).toMatch(/href=\{`mailto:/);
  });

  it("covers the full field set", () => {
    for (const needle of [
      "customerName",
      "customerPhone",
      "customerEmail",
      "customerLocale",
      "propertyType",
      "unitNumber",
      "sqft",
      "serviceType",
      "extras",
      "couponCode",
      "totalAmount",
      "depositAmount",
      "Balance after deposit",
      "NotesBlock",
      "KIND_LABELS",
      "payTokenExpiresAt",
    ]) {
      expect(panel, `panel must render ${needle}`).toContain(needle);
    }
  });

  it("is mounted in both views — card disclosure and desktop dialog", () => {
    const admin = read("AdminAppointments.tsx");
    expect(admin).toContain("note={<BookingDetails row={b as BookingDetailsRow} />}");
    expect(admin).toContain("setDetailRow(b as BookingDetailsRow)");
  });

  it("offers the contact edit and points link bookings at Resend", () => {
    expect(panel).toContain("updateBookingContact");
    expect(panel).toContain("hit Resend on the link");
  });
});

// OPEN_MONDAY import keeps the shared fixture warm for future date needs.
void OPEN_MONDAY;
