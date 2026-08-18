/**
 * What must never leave the server, and what must still work when it doesn't.
 *
 * The deposit token is a bearer credential: anyone holding it can open that
 * customer's pay page. The admin list queries select whole booking rows, so
 * without deliberate stripping the token would ride along into every
 * appointments table, staff schedule and month calendar — and those render in a
 * browser.
 *
 * The second half of the file follows an admin-created booking through payment,
 * to pin that it finishes in exactly the same finalize path as a self-serve
 * one: confirmed, payment recorded, confirmation email sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetBookingById = vi.fn();
const mockConfirmUnpaid = vi.fn();
const mockCreatePayment = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetOccupiedBookings = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", async () => ({
  // The real one: it is a pure function, and testing a copy of it would prove
  // nothing about the one the queries actually call.
  stripPayToken: (await vi.importActual<typeof import("./db")>("./db")).stripPayToken,
  getSetting: vi.fn().mockResolvedValue(null),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  confirmUnpaidBooking: (...a: unknown[]) => mockConfirmUnpaid(...a),
  createPayment: (...a: unknown[]) => mockCreatePayment(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getOccupiedBookings: (...a: unknown[]) => mockGetOccupiedBookings(...a),
  getCouponByCode: vi.fn().mockResolvedValue(undefined),
  incrementCouponRedemptions: vi.fn(),
  updateBooking: vi.fn(),
  createBooking: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  expireStaleBookingsForSlot: vi.fn().mockResolvedValue(0),
  isSlotTakenError: () => false,
}));

vi.mock("./property", () => ({
  lookupPropertySqft: vi.fn().mockResolvedValue({ verified: false, addressVerified: false }),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn() } } }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { stripPayToken } from "./db";
import { __resetTransporter } from "./emails";
import { finalizeBooking } from "./routers/booking";
import { OPEN_MONDAY } from "./testDates";

const DB_SOURCE = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf-8");
const ADMIN_ROUTER = readFileSync(fileURLToPath(new URL("./routers/admin.ts", import.meta.url)), "utf-8");
const DIALOG = fileURLToPath(new URL("../client/src/pages/admin/NewBookingDialog.tsx", import.meta.url));
const PAY_PAGE = fileURLToPath(new URL("../client/src/pages/PayDeposit.tsx", import.meta.url));

const TOKEN = "c".repeat(48);

describe("stripPayToken", () => {
  it("removes the token", () => {
    const stripped = stripPayToken({ id: 1, reference: "GFC-1", payToken: TOKEN });
    expect(stripped).not.toHaveProperty("payToken");
    expect(JSON.stringify(stripped)).not.toContain(TOKEN);
  });

  it("keeps whether a link exists, which the table does need", () => {
    expect(stripPayToken({ id: 1, payToken: TOKEN }).hasPayToken).toBe(true);
    expect(stripPayToken({ id: 1, payToken: null }).hasPayToken).toBe(false);
    expect(stripPayToken({ id: 1 }).hasPayToken).toBe(false);
  });

  it("leaves every other field alone", () => {
    const stripped = stripPayToken({ id: 1, reference: "GFC-1", totalAmount: 200, payToken: TOKEN });
    expect(stripped).toMatchObject({ id: 1, reference: "GFC-1", totalAmount: 200 });
  });
});

describe("every list query strips it", () => {
  /** The body of one exported db function. */
  const body = (name: string) => {
    const start = DB_SOURCE.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found in db.ts`).toBeGreaterThan(-1);
    const rest = DB_SOURCE.slice(start);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };

  it.each([
    ["listBookings", "stripPayToken"],
    ["listBookingsForCustomer", "stripPayToken"],
    ["listBookingsForStaff", "stripJoinedPayToken"],
    ["listBookingsForMonth", "stripJoinedPayToken"],
  ])("%s maps through %s", (fn, stripper) => {
    expect(body(fn)).toContain(stripper);
  });

  it("strips inside the query function, not at the router", () => {
    // So a list endpoint added later cannot forget to do it.
    expect(DB_SOURCE).toMatch(/export function stripPayToken/);
    // The bookings list hands out a derived status and never touches the
    // column. (The invoice pay token has its own strip further down the file,
    // which predates this and is not what is being checked here.)
    const start = ADMIN_ROUTER.indexOf("bookings: adminProcedure");
    const listProcedure = ADMIN_ROUTER.slice(start, ADMIN_ROUTER.indexOf("depositLink: adminProcedure"));
    // Comments stripped: prose about the token is fine, code touching it is not.
    const code = listProcedure.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("payToken");
  });

  it("sends a derived status to the appointments table rather than the token", () => {
    expect(ADMIN_ROUTER).toContain("depositLink: depositLinkStatus(row, now)");
  });

  it("hands out the URL only through a single-booking call", () => {
    const start = ADMIN_ROUTER.indexOf("depositLink: adminProcedure");
    expect(start).toBeGreaterThan(-1);
    const procedure = ADMIN_ROUTER.slice(start, start + 900);
    expect(procedure).toContain("z.object({ id: z.number().int() })");
    expect(procedure).toContain("depositPayUrl");
  });
});

describe("the admin form takes no money", () => {
  const source = readFileSync(DIALOG, "utf-8");

  it("has no price, total or deposit input", () => {
    expect(source).not.toMatch(/setTotal|setDeposit|setPrice|totalAmount:|depositAmount:/);
  });

  it("has no extras picker — those belong to the customer", () => {
    expect(source).not.toContain("EXTRA_IDS");
    expect(source).not.toMatch(/setExtras|extras:/);
  });

  it("offers the notice override explicitly rather than silently bypassing", () => {
    expect(source).toContain("overrideNotice");
    expect(source).toContain("Override notice period");
  });

  it("picks times from the same availability query the public calendar uses", () => {
    expect(source).toContain("trpc.booking.availability.useQuery");
  });

  it("lets the owner skip the email and copy the link instead", () => {
    expect(source).toContain("sendEmail");
    expect(source).toMatch(/clipboard\.writeText/);
  });
});

describe("the pay page sends ids, not prices", () => {
  const source = readFileSync(PAY_PAGE, "utf-8");

  it("posts only the token and the chosen extra ids", () => {
    expect(source).toMatch(/pay\.mutate\(\s*\{ token, extras: chosen \}/);
  });

  it("sends no computed amount with the payment", () => {
    const call = source.slice(source.indexOf("pay.mutate("), source.indexOf("pay.mutate(") + 400);
    expect(call).not.toMatch(/total:|deposit:|amount:/);
  });

  it("prices the preview with the shared engine, so it matches what is charged", () => {
    expect(source).toContain("calculateQuote");
    expect(source).toContain("applyCouponToTotal");
    expect(source).toContain("depositFor");
  });

  it("renders every extra with its price", () => {
    expect(source).toContain("EXTRA_IDS.map");
    expect(source).toMatch(/pricing\.extras\[id\]/);
  });

  it("shows the deposit updating alongside the total", () => {
    expect(source).toContain("preview.total");
    expect(source).toContain("preview.deposit");
  });

  it("is written in both languages", () => {
    expect(source).toMatch(/const COPY = \{\s*en:/);
    expect(source).toMatch(/\n {2}es: \{/);
  });
});

describe("payment finishes in the normal flow", () => {
  const adminBooking = {
    id: 99,
    reference: "GFC-ADMIN1",
    customerId: 7,
    serviceType: "residential",
    frequency: "onetime",
    scheduledDate: OPEN_MONDAY,
    scheduledTime: "10:00",
    sqft: 1200,
    extras: JSON.stringify(["oven"]),
    addressLine: "1 Main St",
    city: "San Antonio",
    zip: "78201",
    locale: "en",
    totalAmount: 145,
    depositAmount: 29,
    status: "pending_deposit",
    couponCode: null,
    estimatedHours: 3,
    kind: "admin",
    holdMinutes: 24 * 60,
    payToken: TOKEN,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTransporter();
    vi.stubEnv("GMAIL_USER", "biz@grapefruitclean.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
    mockGetBookingById.mockResolvedValue(adminBooking);
    mockConfirmUnpaid.mockResolvedValue(true);
    mockGetOccupiedBookings.mockResolvedValue([]);
    mockGetCustomerById.mockResolvedValue({
      id: 7,
      firstName: "Ana",
      email: "ana@example.com",
      phone: "2105550000",
    });
    mockSendMail.mockResolvedValue({ messageId: "1" });
  });

  it("confirms the booking through the same claim as a self-serve deposit", async () => {
    await finalizeBooking(99, "pi_admin_1");
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ stripePaymentIntentId: "pi_admin_1" }));
  });

  it("records the deposit payment", async () => {
    await finalizeBooking(99, "pi_admin_1");
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 99, amount: 29, kind: "deposit", status: "succeeded" })
    );
  });

  it("sends the customer the ordinary confirmation email", async () => {
    await finalizeBooking(99, "pi_admin_1");
    const recipients = mockSendMail.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(recipients).toContain("ana@example.com");
  });

  it("names the extras the customer chose on the pay page", async () => {
    await finalizeBooking(99, "pi_admin_1");
    const body = mockSendMail.mock.calls.map(c => (c[0] as { text: string }).text).join("\n");
    expect(body).toContain("Inside oven");
  });

  it("does not flag a slot conflict while the booking still holds its slot", async () => {
    // A two-hour-old phone booking is well inside its 24-hour hold. Judged by
    // the public one-hour window it would look released, and the owner would
    // get a reschedule warning about a slot nobody else has taken.
    mockGetBookingById.mockResolvedValue({
      ...adminBooking,
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    });
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 42, time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "confirmed", createdAt: new Date() },
    ]);
    await finalizeBooking(99, "pi_admin_1");
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ slotConflict: false }));
  });

  it("still flags one once the hold has genuinely lapsed and someone else took the slot", async () => {
    mockGetBookingById.mockResolvedValue({
      ...adminBooking,
      createdAt: new Date(Date.now() - 25 * 3_600_000),
    });
    mockGetOccupiedBookings.mockResolvedValue([
      { id: 42, time: "10:00", serviceType: "residential", sqft: 1200, estimatedHours: 3, status: "confirmed", createdAt: new Date() },
    ]);
    await finalizeBooking(99, "pi_admin_1");
    expect(mockConfirmUnpaid).toHaveBeenCalledWith(99, expect.objectContaining({ slotConflict: true }));
  });

  it("is idempotent — a second call after the claim does nothing", async () => {
    mockConfirmUnpaid.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await finalizeBooking(99, "pi_admin_1");
    await finalizeBooking(99, "pi_admin_1");
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
  });
});
