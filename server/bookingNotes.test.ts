/**
 * Customer notes have to reach whoever is looking at the booking.
 *
 * bookings.notes is where door codes, gate instructions and access details
 * live. It rendered on the staff job card and nowhere in the admin dashboard at
 * all, which meant the person scheduling and billing the job could not see how
 * the crew was supposed to get in.
 *
 * The rendering checks read the source rather than a DOM (there is none in this
 * suite), in the same spirit as adminMobileLayout.test.ts: they pin the places
 * the notes must appear, so a future refactor of these pages cannot quietly
 * drop them again. The delivery checks are ordinary behaviour tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockListAwaitingApproval = vi.fn();
const mockNotifyOwner = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  listInvoicesAwaitingApproval: (...args: unknown[]) => mockListAwaitingApproval(...args),
  confirmUnpaidBooking: vi.fn().mockResolvedValue(true),
  createPayment: vi.fn(),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  incrementCouponRedemptions: vi.fn(),
  getOccupiedBookings: vi.fn().mockResolvedValue([]),
  updateBooking: vi.fn(),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn(), expire: vi.fn() } } }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...args: unknown[]) => mockNotifyOwner(...args),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import { __resetTransporter, buildOwnerNotification, type BookingEmailData } from "./emails";
import { adminRouter } from "./routers/admin";
import { finalizeBooking } from "./routers/booking";
import type { TrpcContext } from "./_core/context";

const ADMIN_DIR = fileURLToPath(new URL("../client/src/pages/admin", import.meta.url));
const STAFF_DIR = fileURLToPath(new URL("../client/src/pages/staff", import.meta.url));
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

const NOTE = "Gate code 4417. Please leave the side gate shut — the dog gets out.";

// ---------------------------------------------------------------------------
// Where the notes have to render.
// ---------------------------------------------------------------------------

describe("the shared notes block", () => {
  const shared = read(ADMIN_DIR, "adminShared.tsx");
  const block = shared.slice(shared.indexOf("export function NotesBlock"));

  it("exists as one component, so every surface renders notes the same way", () => {
    expect(shared).toContain("export function NotesBlock");
  });

  it("quotes the customer, the way the staff job card does", () => {
    // The staff card is the reference: “…” around the customer's own words.
    expect(read(STAFF_DIR, "StaffRoutes.tsx")).toContain("“{booking.notes}”");
    expect(block).toContain("“{notes}”");
    expect(block).toContain("italic");
  });

  it("stands out from the fields around it rather than blending in", () => {
    // Access instructions that read like another grey label get skimmed past.
    expect(block).toMatch(/bg-amber-\d+/);
    expect(block).toMatch(/ring-amber-\d+/);
    expect(block).toContain("Customer notes");
  });

  it("wraps long notes and keeps the customer's own line breaks", () => {
    expect(block).toContain("whitespace-pre-wrap");
    expect(block).toContain("break-words");
  });
});

describe("Admin → Appointments shows the notes", () => {
  const source = read(ADMIN_DIR, "AdminAppointments.tsx");
  const table = source.slice(source.indexOf("<table"), source.indexOf("cards={"));
  const cards = source.slice(source.indexOf("cards={"));

  it("gives the desktop table its own notes column", () => {
    expect(table).toContain("Customer notes");
    expect(table).toMatch(/<NotesBlock notes=\{b\.notes\}/);
  });

  it("caps the notes column on the block rather than the cell", () => {
    // max-width on a <td> is advisory under auto table layout; a long note put
    // there would widen the column and squeeze the others.
    expect(table).toContain('<NotesBlock notes={b.notes} className="max-w-64" />');
    expect(table).not.toMatch(/<td className="max-w-\d+ [^"]*">\s*\{b\.notes/);
  });

  it("puts them in the mobile card's details disclosure", () => {
    expect(cards).toContain("note={b.notes ? <NotesBlock notes={b.notes} /> : undefined}");
  });

  it("says so plainly when a booking has none", () => {
    expect(table).toContain("—");
  });
});

describe("the invoice approval dialog shows the notes", () => {
  const source = read(ADMIN_DIR, "AdminInvoices.tsx");

  it("renders them in Review & send, above the amount being approved", () => {
    const dialog = source.slice(
      source.indexOf("function ReviewAndSendDialog"),
      source.indexOf("export default function AdminInvoices")
    );
    expect(dialog).toContain("invoice.bookingNotes");
    expect(dialog).toContain("<NotesBlock notes={invoice.bookingNotes} />");
    expect(dialog.indexOf("bookingNotes")).toBeLessThan(dialog.indexOf("Final amount to charge"));
  });

  it("types the field the server now sends", () => {
    expect(source).toContain("bookingNotes: string | null");
  });
});

describe("RowCard's note slot", () => {
  const shared = read(ADMIN_DIR, "adminShared.tsx");
  const block = shared.slice(shared.indexOf("export function RowCard"), shared.indexOf("export function NotesBlock"));

  it("opens the disclosure for a card that has only a note", () => {
    // Without this, a booking whose sole extra field is its notes would render
    // no Details toggle at all — the exact record where they matter most.
    expect(block).toContain("(details && details.length > 0) || note");
  });

  it("renders the note full width instead of squashed into the label grid", () => {
    expect(block).toMatch(/\{note\}/);
  });
});

// ---------------------------------------------------------------------------
// Where the notes have to travel.
// ---------------------------------------------------------------------------

const baseEmail: BookingEmailData = {
  reference: "GFC-NOTE01",
  serviceName: "Residential Cleaning",
  date: "2026-08-19",
  time: "10:00",
  frequencyLabel: "One-time",
  extras: [],
  total: 250,
  deposit: 50,
  customerName: "Ana",
  customerEmail: "ana@example.com",
  customerPhone: "2105550000",
  address: "123 Main St, San Antonio, 78201",
  locale: "en",
};

describe("the owner's new-booking notification carries the notes", () => {
  it("includes them under their own heading", () => {
    const { content } = buildOwnerNotification({ ...baseEmail, notes: NOTE });
    expect(content).toContain("CUSTOMER NOTES");
    expect(content).toContain(NOTE);
  });

  it("leaves the section out entirely when there are none", () => {
    const { content } = buildOwnerNotification(baseEmail);
    expect(content).not.toContain("CUSTOMER NOTES");
  });

  it("keeps them near the customer's contact details, not buried under the money", () => {
    const { content } = buildOwnerNotification({ ...baseEmail, notes: NOTE });
    expect(content.indexOf(NOTE)).toBeLessThan(content.indexOf("Balance due"));
  });
});

describe("finalizeBooking hands the notes to the owner notification", () => {
  beforeEach(() => {
    __resetTransporter();
    mockNotifyOwner.mockReset().mockResolvedValue(undefined);
    mockSendMail.mockReset().mockResolvedValue({ messageId: "1" });
    mockGetCustomerById.mockReset().mockResolvedValue({
      id: 7,
      firstName: "Ana",
      lastName: "Lopez",
      email: "ana@example.com",
      phone: "2105550000",
    });
  });

  afterEach(() => {
    __resetTransporter();
  });

  const booking = {
    id: 42,
    reference: "GFC-NOTE01",
    customerId: 7,
    serviceType: "residential" as const,
    frequency: "onetime" as const,
    scheduledDate: "2026-08-19",
    scheduledTime: "10:00",
    locale: "en" as const,
    status: "pending_deposit" as const,
    totalAmount: 250,
    depositAmount: 50,
    addressLine: "123 Main St",
    city: "San Antonio",
    zip: "78201",
    extras: "[]",
    couponCode: null,
    createdAt: new Date(),
  };

  it("puts what the customer wrote in front of the owner", async () => {
    mockGetBookingById.mockResolvedValue({ ...booking, notes: NOTE });
    await finalizeBooking(42, "pi_1");
    expect(mockNotifyOwner).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(NOTE) }));
  });

  it("sends a clean notification for a booking with no notes", async () => {
    mockGetBookingById.mockResolvedValue({ ...booking, notes: null });
    await finalizeBooking(42, "pi_1");
    const note = mockNotifyOwner.mock.calls[0]![0] as { content: string };
    expect(note.content).not.toContain("CUSTOMER NOTES");
  });
});

describe("the balance approval queue carries the notes", () => {
  const caller = () =>
    adminRouter.createCaller({
      user: { id: 1, role: "admin" },
      req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
    } as unknown as TrpcContext);

  beforeEach(() => {
    mockListAwaitingApproval.mockReset().mockResolvedValue([
      { id: 501, number: "INV-1", bookingId: 42, customerId: 7, amount: 200, payToken: "tok_secret" },
    ]);
    mockGetCustomerById.mockReset().mockResolvedValue({
      id: 7,
      firstName: "Ana",
      lastName: "Lopez",
      email: "ana@example.com",
    });
  });

  it("returns the booking's notes alongside the amount to approve", async () => {
    mockGetBookingById.mockResolvedValue({
      id: 42,
      reference: "GFC-NOTE01",
      serviceType: "residential",
      scheduledDate: "2026-08-19",
      totalAmount: 250,
      depositAmount: 50,
      stripePaymentIntentId: "pi_1",
      notes: NOTE,
    });
    const [invoice] = await caller().awaitingApprovalInvoices();
    expect(invoice!.bookingNotes).toBe(NOTE);
  });

  it("returns null, not undefined, for a booking without notes", async () => {
    mockGetBookingById.mockResolvedValue({
      id: 42,
      reference: "GFC-NOTE01",
      serviceType: "residential",
      scheduledDate: "2026-08-19",
      totalAmount: 250,
      depositAmount: 50,
      stripePaymentIntentId: "pi_1",
      notes: null,
    });
    const [invoice] = await caller().awaitingApprovalInvoices();
    expect(invoice!.bookingNotes).toBeNull();
  });

  it("still never exposes the payment token next to them", async () => {
    mockGetBookingById.mockResolvedValue({
      id: 42,
      reference: "GFC-NOTE01",
      serviceType: "residential",
      scheduledDate: "2026-08-19",
      totalAmount: 250,
      depositAmount: 50,
      stripePaymentIntentId: "pi_1",
      notes: NOTE,
    });
    const [invoice] = await caller().awaitingApprovalInvoices();
    expect(invoice).not.toHaveProperty("payToken");
  });
});
