/**
 * What an Admin → Invoices row shows when it is opened.
 *
 * Opening a row used to reveal "Due date —" and "Payment link —" and nothing
 * else, whatever the invoice. The data was never the problem for a balance
 * invoice — its booking holds the address, size, type and service — the list
 * simply never looked past the invoice table. A manual invoice is different: it
 * is raised by hand with no booking behind it, so there is genuinely no property
 * to show, and the row has to say that rather than render blanks.
 *
 * This file pins:
 *   - the list query joins the booking and customer by explicit column, with no
 *     booking bearer token anywhere in the selection, and batches add-ons;
 *   - the router hands out that context and still never the invoice's token;
 *   - the details wording: property, service and customer for a booking, a plain
 *     "no property linked" plus the customer on file for a manual invoice, and a
 *     fallback for every booking field that can be empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockListInvoices = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual, listInvoices: (...a: unknown[]) => mockListInvoices(...a) };
});

import { adminRouter } from "./routers/admin";
import {
  describeInvoiceContext,
  type InvoiceBookingContext,
  type InvoiceCustomerContext,
} from "../client/src/pages/admin/invoiceContext";

const DB_SOURCE = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf-8");
const PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL("../client/src/pages/admin/AdminInvoices.tsx", import.meta.url)),
  "utf-8"
);
const TOKEN = "f".repeat(48);

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: "https://grapeclean.example" } },
  } as never);

const booking = (overrides: Partial<InvoiceBookingContext> = {}): InvoiceBookingContext => ({
  id: 41,
  reference: "GFC-WH33YS",
  status: "completed",
  serviceType: "deep",
  frequency: "biweekly",
  scheduledDate: "2026-09-02",
  scheduledTime: "09:00",
  propertyType: "apartment",
  addressLine: "2208 Schriber Rd",
  unitNumber: "204",
  city: "San Antonio",
  zip: "78204",
  sqft: 1200,
  verifiedSqft: 1850,
  bedrooms: 3,
  bathrooms: 2,
  extras: null,
  notes: "Gate code 1234",
  addons: [],
  ...overrides,
});

const customer = (overrides: Partial<InvoiceCustomerContext> = {}): InvoiceCustomerContext => ({
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  address: "15 Oak St",
  city: "San Antonio",
  zip: "78209",
  ...overrides,
});

const invoiceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  number: "INV-MT0LDYJ6-7D0D",
  bookingId: 41,
  customerId: 3,
  amount: 170,
  amountCents: 17000,
  status: "sent",
  kind: "balance",
  dueDate: null,
  payToken: TOKEN,
  linkExpiresAt: new Date(Date.now() + 86_400_000),
  lineItems: null,
  reminderCount: 0,
  refundNeeded: false,
  ...overrides,
});

/** Every rendered row must read as words: no blank, no "null", no "undefined". */
function expectReadableRows(view: ReturnType<typeof describeInvoiceContext>) {
  const rows = [...(view.kind === "booking" ? [...view.property, ...view.service] : []), ...view.customer];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(typeof row.value, row.label).toBe("string");
    expect(row.value.trim(), row.label).not.toBe("");
    expect(row.value, row.label).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
  }
}

const rowOf = (view: ReturnType<typeof describeInvoiceContext>, section: "property" | "service" | "customer", label: string) => {
  const rows = (view as Record<string, unknown>)[section] as { label: string; value: string }[];
  return rows.find(row => row.label === label)?.value;
};

describe("the invoice list query", () => {
  const start = DB_SOURCE.indexOf("export async function listInvoices(");
  const body = DB_SOURCE.slice(start, DB_SOURCE.indexOf("\n}\n", start) + 2);

  it("joins the booking and the customer behind each invoice", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain(".leftJoin(bookings, eq(invoices.bookingId, bookings.id))");
    expect(body).toContain(".leftJoin(customers, eq(invoices.customerId, customers.id))");
  });

  it("selects booking columns one by one, never a token", () => {
    expect(body).not.toMatch(/booking:\s*bookings\b/);
    const start = body.indexOf("booking: {");
    expect(start).toBeGreaterThan(-1);
    const selection = body.slice(start, body.indexOf("customer: {", start));
    expect(selection).toContain("addressLine: bookings.addressLine");
    // payToken, tipToken, rescheduleTokenHash, and anything named like them later.
    expect(selection).not.toMatch(/token|hash|stripe/i);
  });

  it("selects customer columns one by one, never the unsubscribe token", () => {
    // customers.marketingToken is the bearer credential behind every unsubscribe
    // link, and the router passes this object to the page as it is.
    expect(body).not.toMatch(/customer:\s*customers\b/);
    const start = body.indexOf("customer: {");
    expect(start).toBeGreaterThan(-1);
    const selection = body.slice(start, body.indexOf(".from(invoices)", start));
    expect(selection).toContain("phone: customers.phone");
    expect(selection).not.toMatch(/token|hash|stripe|marketing/i);
  });

  it("loads add-ons for the whole page in one query, not one per invoice", () => {
    expect(body).toContain("inArray(bookingAddons.bookingId, bookingIds)");
    expect(body).not.toContain("listBookingAddonsByBooking");
  });

  it("keeps the 300-row page cap", () => {
    expect(body).toContain(".limit(300)");
  });
});

describe("admin.invoices", () => {
  beforeEach(() => mockListInvoices.mockReset());

  it("sends the booking and customer context with each invoice", async () => {
    mockListInvoices.mockResolvedValue([
      { invoice: invoiceRow(), booking: booking({ addons: [{ nameEn: "Inside oven", quantity: 1 }] }), customer: customer() },
    ]);
    const [row] = await adminCaller().invoices();
    expect(row.booking).toMatchObject({ reference: "GFC-WH33YS", addressLine: "2208 Schriber Rd", verifiedSqft: 1850 });
    expect(row.booking?.addons).toEqual([{ nameEn: "Inside oven", quantity: 1 }]);
    expect(row.customer).toMatchObject({ phone: "2105550000" });
    expect(row.customerName).toBe("Ana Lopez");
    expect(row.linkStatus).toBe("sent");
  });

  it("still never hands out the invoice's pay token", async () => {
    mockListInvoices.mockResolvedValue([{ invoice: invoiceRow(), booking: booking(), customer: customer() }]);
    const rows = await adminCaller().invoices();
    expect(rows[0]).not.toHaveProperty("payToken");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("passes a manual invoice through with no booking rather than failing on it", async () => {
    mockListInvoices.mockResolvedValue([
      { invoice: invoiceRow({ kind: "manual", bookingId: null }), booking: null, customer: customer() },
      { invoice: invoiceRow({ id: 8, customerId: 99 }), booking: null, customer: null },
    ]);
    const [manual, orphan] = await adminCaller().invoices();
    expect(manual.booking).toBeNull();
    expect(manual.customerName).toBe("Ana Lopez");
    expect(orphan.customerName).toBeNull();
  });
});

describe("the opened row, for an invoice with a booking", () => {
  const view = describeInvoiceContext({ kind: "balance", booking: booking(), customer: customer() });

  it("shows the house: address with its unit, type, size and rooms", () => {
    expect(view.kind).toBe("booking");
    expect(rowOf(view, "property", "Address")).toBe("2208 Schriber Rd, Apt 204, San Antonio, 78204");
    expect(rowOf(view, "property", "Type")).toBe("Apartment / Condo");
    expect(rowOf(view, "property", "Size")).toBe("1,850 ft² verified");
    expect(rowOf(view, "property", "Rooms")).toBe("3 bed · 2 bath");
  });

  it("shows the job: service, frequency, when, and the booking itself", () => {
    expect(rowOf(view, "service", "Service")).toBe("Deep Clean");
    expect(rowOf(view, "service", "Frequency")).toBe("Bi-weekly");
    expect(rowOf(view, "service", "Scheduled")).toBe("Sep 2, 2026 · 09:00");
    expect(rowOf(view, "service", "Booking")).toBe("GFC-WH33YS · completed");
  });

  it("reads as words on every row", () => {
    expectReadableRows(view);
  });

  it("shows who it bills and what they asked for", () => {
    expect(rowOf(view, "customer", "Name")).toBe("Ana Lopez");
    expect(rowOf(view, "customer", "Phone")).toBe("2105550000");
    expect(view.kind === "booking" && view.notes).toBe("Gate code 1234");
  });

  it("names add-ons from the booked snapshots, and falls back to legacy extras", () => {
    const snap = describeInvoiceContext({
      kind: "balance",
      booking: booking({ addons: [{ nameEn: "Inside oven", quantity: 1 }, { nameEn: "Chair Steam Cleaning", quantity: 2 }], extras: '["fridge"]' }),
      customer: customer(),
    });
    expect(rowOf(snap, "service", "Add-ons")).toBe("Inside oven, Chair Steam Cleaning ×2");

    const legacy = describeInvoiceContext({ kind: "balance", booking: booking({ extras: '["oven"]' }), customer: customer() });
    expect(rowOf(legacy, "service", "Add-ons")).not.toBe("None");
    expect(rowOf(legacy, "service", "Add-ons")).not.toContain("[");

    const none = describeInvoiceContext({ kind: "balance", booking: booking({ extras: "not json" }), customer: customer() });
    expect(rowOf(none, "service", "Add-ons")).toBe("None");
  });

  it("says what's missing, field by field, on a booking that never got the facts", () => {
    // An admin-created phone lead: a name and a number, everything else blank.
    const sparse = describeInvoiceContext({
      kind: "balance",
      booking: booking({
        serviceType: null,
        scheduledDate: null,
        scheduledTime: null,
        propertyType: "house",
        addressLine: null,
        unitNumber: null,
        city: null,
        zip: null,
        sqft: null,
        verifiedSqft: null,
        notes: "   ",
      }),
      customer: customer({ phone: null, email: "" }),
    });
    expect(rowOf(sparse, "property", "Address")).toBe("No address on the booking");
    expect(rowOf(sparse, "property", "Size")).toBe("Not recorded");
    expect(rowOf(sparse, "service", "Service")).toBe("Not chosen");
    expect(rowOf(sparse, "service", "Scheduled")).toBe("Not scheduled");
    expect(rowOf(sparse, "customer", "Phone")).toBe("Not on file");
    expect(rowOf(sparse, "customer", "Email")).toBe("Not on file");
    expect(sparse.kind === "booking" && sparse.notes).toBeNull();
    expectReadableRows(sparse);
  });

  it("shows a date on its own while the start time is still pending", () => {
    const pending = describeInvoiceContext({ kind: "balance", booking: booking({ scheduledTime: null }), customer: customer() });
    expect(rowOf(pending, "service", "Scheduled")).toBe("Sep 2, 2026");
    expectReadableRows(pending);
  });

  it("uses the entered size when nothing verified it", () => {
    const entered = describeInvoiceContext({ kind: "balance", booking: booking({ verifiedSqft: null }), customer: customer() });
    expect(rowOf(entered, "property", "Size")).toBe("1,200 ft²");
  });
});

describe("the opened row, for an invoice with no booking", () => {
  it("says a manual invoice has no property linked, and shows the customer on file", () => {
    const view = describeInvoiceContext({ kind: "manual", booking: null, customer: customer() });
    expect(view.kind).toBe("no_booking");
    if (view.kind !== "no_booking") return;
    expect(view.heading).toBe("No property linked to this invoice");
    expect(view.explanation).toContain("manual invoice");
    expect(rowOf(view, "customer", "Name")).toBe("Ana Lopez");
    expect(rowOf(view, "customer", "Address")).toBe("15 Oak St, San Antonio, 78209");
  });

  it("says so when the customer has no address either", () => {
    const view = describeInvoiceContext({
      kind: "manual",
      booking: null,
      customer: customer({ address: null, city: null, zip: " " }),
    });
    expect(rowOf(view, "customer", "Address")).toBe("No address on file");
    expectReadableRows(view);
  });

  it("tells a deleted booking apart from a manual invoice", () => {
    const view = describeInvoiceContext({ kind: "balance", booking: null, customer: null });
    expect(view.kind === "no_booking" && view.heading).toBe("Booking no longer available");
    expect(rowOf(view, "customer", "Customer")).toBe("No customer record found");
  });

  it("keys on the booking, not the kind: an older manual invoice with one still shows its house", () => {
    const view = describeInvoiceContext({ kind: "manual", booking: booking(), customer: customer() });
    expect(view.kind).toBe("booking");
  });
});

describe("where the panel renders", () => {
  it("opens behind a phone card's Details toggle", () => {
    expect(PAGE_SOURCE).toContain("note={<InvoiceContextPanel invoice={inv} />}");
  });

  it("opens from an arrow on the desktop row, in a full-width row beneath it", () => {
    // The arrow toggles this row and says whether it is open.
    expect(PAGE_SOURCE).toMatch(
      /onClick=\{\(\) => toggleExpanded\(inv\.id\)\}\s*aria-expanded=\{expandedIds\.includes\(inv\.id\)\}\s*aria-controls=\{`invoice-details-\$\{inv\.id\}`\}/
    );
    // The details row exists only while expanded — never all 300 rows at once —
    // and carries the id the arrow points at.
    const detail = PAGE_SOURCE.match(
      /\{expandedIds\.includes\(inv\.id\) && \(\s*<tr id=\{`invoice-details-\$\{inv\.id\}`\}[^>]*>\s*<td colSpan=\{(\d+)\}[^>]*>\s*<InvoiceContextPanel invoice=\{inv\} \/>/
    );
    expect(detail, "details row must be guarded by the expanded state").toBeTruthy();
    // Full width: it spans exactly the table's columns.
    const thead = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf("<thead>"), PAGE_SOURCE.indexOf("</thead>"));
    expect(Number(detail![1])).toBe((thead.match(/<th\b/g) ?? []).length);
  });
});
