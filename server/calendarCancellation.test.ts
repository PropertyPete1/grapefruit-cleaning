/**
 * Test A — cancellation removes a booking from the calendar, and nothing else
 * about the customer is lost.
 *
 * The slot itself frees on the status write (the generated slotKey is NULL for
 * cancelled and expired rows); what this file pins is everything around it:
 *
 *   - the calendars no longer draw a released booking (the admin month grid
 *     used to render cancelled AND expired rows as ordinary chips, because the
 *     date-range query applied no status filter);
 *   - the appointments table still lists them — history stays visible;
 *   - cancelling voids any unpaid balance invoice for the job, so reminders
 *     stop and the approval queue empties;
 *   - when the owner asks, the customer (or the host, for an Airbnb turnover)
 *     gets a bilingual cancellation notice that is logged like every other
 *     transactional email — and a mail failure never fails the cancellation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockUpdateBooking = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetConnectedPropertyById = vi.fn();
const mockGetSetting = vi.fn();
const mockVoidInvoices = vi.fn();
const mockRecordEmail = vi.fn();
const mockListBookings = vi.fn();
const mockGetCustomersByIds = vi.fn();
const mockListBalanceInvoices = vi.fn();
const mockSendMail = vi.fn();
const mockSessionRetrieve = vi.fn();
const mockSessionExpire = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    listGrandfatheredCustomers: vi.fn().mockResolvedValue([]),
    stripPayToken: actual.stripPayToken,
    isSlotTakenError: actual.isSlotTakenError,
    getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
    updateBooking: (...a: unknown[]) => mockUpdateBooking(...a),
    getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
    getConnectedPropertyById: (...a: unknown[]) => mockGetConnectedPropertyById(...a),
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    voidUnpaidBalanceInvoicesForBooking: (...a: unknown[]) => mockVoidInvoices(...a),
    recordEmailAttemptReturningId: (...a: unknown[]) => mockRecordEmail(...a),
    lastEmailAlertAt: vi.fn().mockResolvedValue(new Date()),
    markEmailAlertSuppressed: vi.fn().mockResolvedValue(undefined),
    countSuppressedSince: vi.fn().mockResolvedValue(0),
    markEmailAlertSent: vi.fn().mockResolvedValue(undefined),
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    getCustomersByIds: (...a: unknown[]) => mockGetCustomersByIds(...a),
    listBalanceInvoicesForBookings: (...a: unknown[]) => mockListBalanceInvoices(...a),
  };
});

vi.mock("./stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: (...a: unknown[]) => mockSessionRetrieve(...a),
        expire: (...a: unknown[]) => mockSessionExpire(...a),
      },
    },
  }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { holdsCalendarSlot } from "@shared/bookingStatus";
import { __resetTransporter } from "./emails";
import { dueReminderKind } from "./reminders";
import { adminRouter } from "./routers/admin";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin", name: "Karyme" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as unknown as TrpcContext);

const CUSTOMER = {
  id: 7,
  firstName: "Maria",
  lastName: "Lopez",
  email: "maria@example.com",
  phone: "2105550134",
  preferredLocale: "en",
};

const booking = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  reference: "GFC-ABC123",
  customerId: 7,
  kind: "self_serve",
  status: "confirmed",
  serviceType: "deep",
  frequency: "onetime",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "10:00",
  addressLine: "1 Main St",
  unitNumber: null,
  city: "San Antonio",
  zip: "78201",
  totalAmount: 250,
  depositAmount: 50,
  depositAmountCents: 5000,
  stripePaymentIntentId: "pi_dep",
  stripeSessionId: null,
  locale: "en",
  propertyId: null,
  notes: null,
  createdAt: new Date(),
  ...overrides,
});

const sentEmails = () =>
  mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string });

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetBookingById.mockResolvedValue(booking());
  mockUpdateBooking.mockResolvedValue(undefined);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetConnectedPropertyById.mockResolvedValue(undefined);
  mockGetSetting.mockResolvedValue("(210) 555-0123");
  mockVoidInvoices.mockResolvedValue([]);
  mockRecordEmail.mockResolvedValue(1);
  mockListBookings.mockResolvedValue([]);
  mockGetCustomersByIds.mockResolvedValue([CUSTOMER]);
  mockListBalanceInvoices.mockResolvedValue([]);
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockSessionRetrieve.mockResolvedValue({ payment_status: "unpaid", status: "open" });
  mockSessionExpire.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("which bookings belong on a calendar", () => {
  it("every slot-holding status does; cancelled and expired do not", () => {
    for (const status of ["pending_deposit", "confirmed", "in_progress", "completed"]) {
      expect(holdsCalendarSlot(status), status).toBe(true);
    }
    expect(holdsCalendarSlot("cancelled")).toBe(false);
    expect(holdsCalendarSlot("expired")).toBe(false);
  });

  it("the calendar query drops released rows; the appointments query keeps them", async () => {
    mockListBookings.mockResolvedValue([
      booking({ id: 1, status: "confirmed" }),
      booking({ id: 2, status: "cancelled" }),
      booking({ id: 3, status: "expired" }),
      booking({ id: 4, status: "completed" }),
    ]);
    const calendar = await adminCaller().bookings({ from: "2026-09-01", to: "2026-09-30", onCalendar: true });
    expect(calendar.map(row => row.id)).toEqual([1, 4]);
    // The status filter is applied after the query, so the date range still
    // reaches the database untouched.
    expect(mockListBookings).toHaveBeenLastCalledWith({ from: "2026-09-01", to: "2026-09-30" });

    const appointments = await adminCaller().bookings({});
    expect(appointments.map(row => row.id)).toEqual([1, 2, 3, 4]);
  });

  it("the staff month calendar excludes expired holds as well as cancellations", () => {
    const db = source("./db.ts");
    const body = db.slice(
      db.indexOf("export async function listBookingsForMonth"),
      db.indexOf("export async function createEmployee")
    );
    expect(body).toContain("NOT IN ('cancelled', 'expired')");
  });

  it("the reminder scan never picks up a cancelled booking", () => {
    expect(
      dueReminderKind(
        { status: "cancelled", scheduledDate: OPEN_MONDAY, weekReminderSentAt: null, dayReminderSentAt: null, createdAt: new Date() },
        OPEN_MONDAY
      )
    ).toBeNull();
  });
});

describe("cancelling from Admin → Appointments", () => {
  it("cancels the row, voids the unpaid balance and emails the customer when asked", async () => {
    mockVoidInvoices.mockResolvedValue([{ id: 501, number: "INV-1", status: "sent", stripeSessionId: "cs_open" }]);
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });

    expect(result).toMatchObject({ success: true, cancellation: { voidedInvoices: 1, customerNotified: true } });
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
    expect(mockVoidInvoices).toHaveBeenCalledWith(42);
    // The voided invoice's open Checkout is closed so an old tab cannot pay it.
    expect(mockSessionExpire).toHaveBeenCalledWith("cs_open");

    const [email] = sentEmails();
    expect(email!.to).toBe("maria@example.com");
    expect(email!.subject).toContain("has been cancelled");
    expect(email!.subject).toContain("GFC-ABC123");
    expect(email!.subject).toContain(OPEN_MONDAY);
    expect(email!.text).toContain("Deep Cleaning");
    expect(email!.text).toContain("1 Main St");
    expect(email!.text).toContain("won't be charged");
    // A deposit was collected: the email promises a follow-up, never a refund.
    expect(email!.text).toContain("follow up with you");
    expect(email!.text).toContain("(210) 555-0123");
  });

  it("logs the notice to email_log under its own type, against the booking", async () => {
    await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    expect(mockRecordEmail).toHaveBeenCalledWith(
      expect.objectContaining({ emailType: "booking_cancelled", bookingId: 42, outcome: "delivered" })
    );
  });

  it("writes in the customer's language", async () => {
    mockGetBookingById.mockResolvedValue(booking({ locale: "es" }));
    await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    const [email] = sentEmails();
    expect(email!.subject).toContain("fue cancelada");
    expect(email!.text).toContain("Limpieza Profunda");
    expect(email!.text).toContain("No se le cobrará");
  });

  it("quotes the owner's note when one is given", async () => {
    await adminCaller().updateBookingStatus({
      id: 42,
      status: "cancelled",
      notifyCustomer: true,
      note: "Our crew is out sick this week — we'd love to rebook you.",
    });
    expect(sentEmails()[0]!.text).toContain('Note from our team: "Our crew is out sick this week');
  });

  it("tells the host which turnover came off the schedule, in the automatic notices' voice", async () => {
    mockGetBookingById.mockResolvedValue(
      booking({ kind: "ical_auto", serviceType: "airbnb", propertyId: 5, depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null })
    );
    mockGetConnectedPropertyById.mockResolvedValue({ id: 5, label: "Riverwalk condo", customerId: 7 });
    await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    const [email] = sentEmails();
    expect(email!.subject).toContain("Turnover cancelled — Riverwalk condo");
    expect(email!.text).toContain("Riverwalk condo");
    expect(email!.text).toContain("calendar feed stays connected");
    // An Airbnb turnover never takes a deposit, so no deposit follow-up is promised.
    expect(email!.text).not.toContain("deposit");
  });

  it("sends nothing unless the owner asked, but still clears the money", async () => {
    mockVoidInvoices.mockResolvedValue([{ id: 501, number: "INV-1", status: "awaiting_approval", stripeSessionId: null }]);
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled" });
    expect(result.cancellation).toEqual({ voidedInvoices: 1, customerNotified: false });
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockSessionExpire).not.toHaveBeenCalled();
  });

  it("a customer with no email address gets no notice and no error", async () => {
    mockGetCustomerById.mockResolvedValue({ ...CUSTOMER, email: null });
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    expect(result.cancellation?.customerNotified).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("a mail failure never fails the cancellation", async () => {
    mockSendMail.mockRejectedValue(new Error("mailbox unavailable"));
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    expect(result.success).toBe(true);
    expect(result.cancellation?.customerNotified).toBe(false);
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "cancelled" });
  });

  it("a Stripe hiccup while closing a voided invoice's checkout is swallowed", async () => {
    mockVoidInvoices.mockResolvedValue([{ id: 501, number: "INV-1", status: "sent", stripeSessionId: "cs_gone" }]);
    mockSessionExpire.mockRejectedValue(new Error("already expired"));
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled" });
    expect(result).toMatchObject({ success: true, cancellation: { voidedInvoices: 1 } });
  });

  it("re-cancelling an already cancelled booking runs no side effects", async () => {
    mockGetBookingById.mockResolvedValue(booking({ status: "cancelled" }));
    const result = await adminCaller().updateBookingStatus({ id: 42, status: "cancelled", notifyCustomer: true });
    expect(result.cancellation).toBeUndefined();
    expect(mockVoidInvoices).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("every other status change is untouched by the cancellation path", async () => {
    await adminCaller().updateBookingStatus({ id: 42, status: "in_progress" });
    expect(mockVoidInvoices).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("the vanished-reservation notice keeps its own wording", async () => {
    // Same family, different reason: a feed dropping a reservation is the
    // host's doing, an admin cancel is ours. The pinned host wording from the
    // iCal round must survive the shared builder.
    const { buildAutoCleanCancelledEmail, buildBookingCancelledEmail } = await import("./emails");
    const vanished = buildAutoCleanCancelledEmail({ label: "Riverwalk condo", date: OPEN_MONDAY, time: "11:00", customerName: "Hank", locale: "en" });
    expect(vanished.subject).toContain("Reservation cancelled");
    expect(vanished.body).toContain("no longer shows that reservation");
    const ours = buildBookingCancelledEmail({
      reference: "GFC-1", serviceName: "Airbnb Cleaning", date: OPEN_MONDAY, time: "11:00",
      customerName: "Hank", locale: "en", propertyLabel: "Riverwalk condo",
    });
    expect(ours.body).not.toContain("no longer shows that reservation");
    expect(ours.body).toContain("off the schedule");
  });
});

describe("the admin UI asks before cancelling", () => {
  const appointments = source("../client/src/pages/admin/AdminAppointments.tsx");
  const dialog = source("../client/src/pages/admin/CancelBookingDialog.tsx");
  const calendar = source("../client/src/pages/admin/AdminCalendar.tsx");
  const staff = source("../client/src/pages/staff/StaffRoutes.tsx");

  it("routes the Cancelled choice through a confirmation dialog on both layouts", () => {
    // Every status select goes through changeStatus; none mutates directly.
    expect(appointments).not.toContain("onValueChange={v => updateStatus.mutate(");
    expect(appointments.match(/onValueChange=\{v => changeStatus\(b, v\)\}/g)).toHaveLength(2);
    expect(appointments).toContain('if (next === "cancelled") {');
    expect(appointments).toContain("setCancelling(row)");
    expect(appointments).toContain("<CancelBookingDialog");
  });

  it("offers the customer notice with a note, and says what happens to the money", () => {
    expect(dialog).toContain("notifyCustomer");
    expect(dialog).toContain("a cancellation notice");
    expect(dialog).toContain("Email the host that this turnover is cancelled");
    expect(dialog).toContain("No email on file");
    expect(dialog).toContain("Add a short note to the email");
    expect(dialog).toContain("voided");
    expect(dialog).toContain('variant="destructive"');
    expect(dialog).toContain("<DialogFooter sticky>");
  });

  it("the admin calendar asks for calendar-only rows; the staff day view drops released ones", () => {
    expect(calendar).toContain("onCalendar: true");
    expect(calendar).toContain("holdsCalendarSlot(b.status)");
    expect(staff).toContain("holdsCalendarSlot(j.booking.status)");
  });
});
