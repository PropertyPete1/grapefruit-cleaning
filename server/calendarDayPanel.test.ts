/**
 * Test C — click a day on the admin calendar.
 *
 *   - an empty future day opens New booking with that date already chosen;
 *   - a day with bookings opens a panel listing every one of them with the
 *     facts the owner scans for: name, service, address, time span, price,
 *     payment status, booking status, notes — plus its own "add" button;
 *   - Airbnb work is drawn in one violet everywhere (both calendars, the
 *     appointments table, the day panel), and other services keep their color.
 *
 * Payment status is derived server-side from the booking and its balance
 * invoice; the pure matrix is pinned here alongside the router wiring.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListBookings = vi.fn();
const mockGetCustomersByIds = vi.fn();
const mockListBalanceInvoices = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    stripPayToken: actual.stripPayToken,
    getSetting: vi.fn().mockResolvedValue(null),
    listBookings: (...a: unknown[]) => mockListBookings(...a),
    getCustomersByIds: (...a: unknown[]) => mockGetCustomersByIds(...a),
    listBalanceInvoicesForBookings: (...a: unknown[]) => mockListBalanceInvoices(...a),
  };
});

import { derivePaymentStatus, PAYMENT_STATUS_LABELS, type BookingPaymentStatus } from "@shared/paymentStatus";
import { isAirbnbBooking } from "@shared/bookingStatus";
import { longDateLabel, sortDayBookings } from "../client/src/pages/admin/calendarDay";
import { adminRouter } from "./routers/admin";
import { OPEN_MONDAY } from "./testDates";
import type { TrpcContext } from "./_core/context";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
  } as unknown as TrpcContext);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  reference: "GFC-1",
  customerId: 7,
  kind: "self_serve",
  status: "confirmed",
  serviceType: "residential",
  scheduledDate: OPEN_MONDAY,
  scheduledTime: "10:00",
  sqft: 1200,
  estimatedHours: 2,
  depositAmount: 30,
  depositAmountCents: 3000,
  stripePaymentIntentId: "pi_1",
  totalAmount: 150,
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCustomersByIds.mockResolvedValue([{ id: 7, firstName: "Maria", lastName: "Lopez", email: "m@x.com", phone: "2105550134", preferredLocale: "en" }]);
  mockListBalanceInvoices.mockResolvedValue([]);
});

describe("payment status, derived from the booking and its balance invoice", () => {
  const base = { depositAmount: 30, depositAmountCents: 3000, stripePaymentIntentId: "pi_1" };

  it.each<[Partial<Parameters<typeof derivePaymentStatus>[0]>, BookingPaymentStatus]>([
    [{ status: "pending_deposit" }, "deposit_due"],
    [{ status: "pending_deposit", depositAmount: 0, depositAmountCents: 0 }, "pay_after_service"],
    [{ status: "confirmed" }, "deposit_paid"],
    [{ status: "in_progress" }, "deposit_paid"],
    // Airbnb turnovers and zero-deposit bookings collect nothing up front.
    [{ status: "confirmed", depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null }, "pay_after_service"],
    [{ status: "completed" }, "unpaid"],
    [{ status: "completed", invoice: { status: "awaiting_approval" } }, "balance_pending_approval"],
    [{ status: "completed", invoice: { status: "sent" } }, "balance_due"],
    [{ status: "completed", invoice: { status: "overdue" } }, "balance_due"],
    [{ status: "completed", invoice: { status: "paid", paidVia: "stripe" } }, "paid"],
    [{ status: "completed", invoice: { status: "paid", paidVia: "manual" } }, "paid_offline"],
    // A voided invoice is no invoice.
    [{ status: "completed", invoice: { status: "void" } }, "unpaid"],
    [{ status: "cancelled", invoice: { status: "sent" } }, "released"],
    [{ status: "expired" }, "released"],
  ])("%o → %s", (input, expected) => {
    expect(derivePaymentStatus({ ...base, ...input } as Parameters<typeof derivePaymentStatus>[0])).toBe(expected);
  });

  it("a booking settled while still confirmed reads as paid — the invoice outranks the status", () => {
    expect(derivePaymentStatus({ ...base, status: "confirmed", invoice: { status: "paid", paidVia: "stripe" } })).toBe("paid");
  });

  it("every status has a label the badge can show", () => {
    const statuses: BookingPaymentStatus[] = [
      "deposit_due", "deposit_paid", "pay_after_service", "cash_pending", "balance_pending_approval",
      "balance_due", "unpaid", "paid", "paid_cash", "paid_offline", "released",
    ];
    for (const status of statuses) expect(PAYMENT_STATUS_LABELS[status], status).toBeTruthy();
  });

  it("rides every admin bookings row, from one invoice query for the page", async () => {
    mockListBookings.mockResolvedValue([
      row({ id: 1, status: "completed" }),
      row({ id: 2, status: "completed" }),
      row({ id: 3, status: "confirmed", kind: "ical_auto", serviceType: "airbnb", depositAmount: 0, depositAmountCents: 0, stripePaymentIntentId: null }),
    ]);
    mockListBalanceInvoices.mockResolvedValue([
      { id: 501, bookingId: 1, status: "paid", paidVia: "manual", amount: 120, amountCents: 12000 },
      { id: 502, bookingId: 2, status: "sent", paidVia: null, amount: 120, amountCents: 12000 },
    ]);
    const rows = await adminCaller().bookings({ onCalendar: true });
    // The Airbnb turnover reads Unpaid until its one payment lands — never "pay after cleaning".
    expect(rows.map(r => r.paymentStatus)).toEqual(["paid_offline", "balance_due", "unpaid"]);
    expect(mockListBalanceInvoices).toHaveBeenCalledTimes(1);
    expect(mockListBalanceInvoices).toHaveBeenCalledWith([1, 2, 3]);
  });
});

describe("day panel helpers", () => {
  it("orders timed jobs by start and puts time-to-be-decided last", () => {
    const sorted = sortDayBookings([
      { id: "tbd", scheduledTime: null },
      { id: "late", scheduledTime: "14:00" },
      { id: "early", scheduledTime: "09:00" },
    ]);
    expect(sorted.map(s => s.id)).toEqual(["early", "late", "tbd"]);
  });

  it("labels the day without slipping across a timezone", () => {
    expect(longDateLabel("2026-09-30")).toBe("Wednesday, September 30, 2026");
    expect(longDateLabel("2026-01-01")).toBe("Thursday, January 1, 2026");
  });

  it("recognizes Airbnb work by service or by feed origin", () => {
    expect(isAirbnbBooking({ serviceType: "airbnb", kind: "self_serve" })).toBe(true);
    expect(isAirbnbBooking({ serviceType: "residential", kind: "ical_auto" })).toBe(true);
    expect(isAirbnbBooking({ serviceType: "deep", kind: "admin" })).toBe(false);
  });
});

describe("the admin calendar page", () => {
  const calendar = source("../client/src/pages/admin/AdminCalendar.tsx");
  const panel = source("../client/src/pages/admin/CalendarDayPanel.tsx");
  const dialog = source("../client/src/pages/admin/NewBookingDialog.tsx");

  it("makes every day a tap target that opens the panel or a prefilled new booking", () => {
    expect(calendar).toContain("onClick={() => openDay(dateStr)}");
    // An empty future day goes straight to a new booking on that date.
    expect(calendar).toContain("if (!hasBookings && dateStr >= todayStr) {");
    expect(calendar).toContain("setNewBookingDate(dateStr)");
    expect(calendar).toContain("<CalendarDayPanel");
    expect(calendar).toContain("initialDate={newBookingDate}");
    expect(calendar).toContain("trigger={false}");
    // A cell is a real button, so it works from a keyboard too.
    expect(calendar).toMatch(/<button\s+key=\{i\}\s+type="button"/);
  });

  it("the new-booking form takes the date and opens on the schedule step", () => {
    expect(dialog).toContain("initialDate?: string;");
    expect(dialog).toContain('useState(initialDate ?? "")');
    expect(dialog).toContain('useState<string | null>(initialDate ? "schedule" : null)');
    // Controlled mode for the calendar, self-owned trigger for Appointments.
    expect(dialog).toContain("const open = controlledOpen ?? internalOpen;");
    expect(dialog).toContain("{trigger && (");
  });

  it("the day panel shows every fact the owner scans for, and the add button", () => {
    for (const needle of [
      "b.customerName",
      "b.customerPhone",
      "SERVICE_LABELS",
      'composeAddressOr(b, "No address yet")',
      "formatJobSpan(b.scheduledTime, b.durationHours)",
      "fmtMoney(b.totalAmount)",
      "<PaymentStatusBadge status={b.paymentStatus} />",
      "<StatusBadge status={b.status} />",
      "<NotesBlock notes={b.notes}",
      "New booking on this day",
      "<DialogFooter sticky>",
    ]) {
      expect(panel, `panel must render ${needle}`).toContain(needle);
    }
    // No per-page viewport cap: the primitive scrolls the dialog.
    expect(panel).not.toMatch(/max-h-\[/);
    expect(panel).not.toContain("overflow-y-auto");
  });

  it("keeps the released-booking filter and the time-to-be-decided marker", () => {
    expect(calendar).toContain("onCalendar: true");
    expect(calendar).toContain("TIME TBD");
    expect(calendar).toContain("Time to be decided");
  });
});

describe("Airbnb has one color everywhere", () => {
  const shared = source("../client/src/pages/admin/adminShared.tsx");
  const calendar = source("../client/src/pages/admin/AdminCalendar.tsx");
  const staff = source("../client/src/pages/staff/StaffRoutes.tsx");
  const appointments = source("../client/src/pages/admin/AdminAppointments.tsx");
  const panel = source("../client/src/pages/admin/CalendarDayPanel.tsx");

  it("is defined once, as a violet nothing else in the dashboards uses", () => {
    expect(shared).toContain('export const AIRBNB_CHIP_CLASS = "bg-violet-100 text-violet-900"');
    expect(shared).toContain("export function AirbnbBadge(");
    // No other admin or staff page invents its own violet.
    for (const file of [calendar, staff, appointments, panel]) {
      expect(file).not.toMatch(/bg-violet-100 text-violet-900/);
    }
  });

  it("both month grids paint Airbnb chips with it and leave other services as they were", () => {
    expect(calendar).toContain("${airbnb ? AIRBNB_CHIP_CLASS : b.scheduledTime ? \"bg-primary/10 text-accent-foreground\" : \"bg-amber-100 text-amber-900\"}");
    expect(staff).toContain('${isAirbnbBooking(j.booking) ? AIRBNB_CHIP_CLASS : "bg-secondary/15 text-secondary-foreground"}');
  });

  it("the appointments table, staff cards and day panel badge Airbnb work by service, not only by feed", () => {
    expect(appointments).toContain("isAirbnbBooking(b) && <AirbnbBadge");
    expect(staff).toContain("isAirbnbBooking(booking) && <AirbnbBadge");
    expect(panel).toContain("<AirbnbBadge auto={b.kind === \"ical_auto\"} />");
    // The old one-off badge is gone from both.
    expect(appointments).not.toContain("Auto · Airbnb\n");
    expect(staff).not.toContain("Auto · Airbnb\n");
  });

  it("the calendar carries a legend so the colors explain themselves", () => {
    expect(calendar).toContain("bg-violet-300");
    expect(calendar).toContain("> Airbnb");
    expect(calendar).toContain("Time to be decided");
  });
});
