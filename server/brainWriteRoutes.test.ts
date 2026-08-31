/**
 * The brain write API's contract tests. PRIMARY's grapefruit adapter is
 * fixture-tested against exactly the shapes and error strings pinned here
 * (see lifestyle-brain/docs/grapefruit-write-api.md), so these assert exact
 * key sets, not just presence — and they assert which internal function each
 * route calls, because "the same path the admin panel trusts" is the whole
 * safety argument for this surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { DEFAULT_DURATIONS, durationHoursFor } from "@shared/duration";

const SLOT_REFUSAL = "That date and time is not bookable — the hours, the notice period, or another booking rules it out.";

const {
  mockMatchOrCreateCustomer,
  mockGetCustomerById,
  mockGetBookingById,
  mockUpdateBooking,
  mockCreateBookingRaw,
  mockExpireStale,
  mockGetSetting,
  mockUpdateInvoice,
  mockIsSlotTaken,
  mockCreateAdminBooking,
  mockAdminSlotBookable,
  mockLoadSchedulingRules,
  mockIssueManualInvoice,
  mockSendDepositLinkEmail,
} = vi.hoisted(() => ({
  mockMatchOrCreateCustomer: vi.fn(),
  mockGetCustomerById: vi.fn(),
  mockGetBookingById: vi.fn(),
  mockUpdateBooking: vi.fn(),
  mockCreateBookingRaw: vi.fn(),
  mockExpireStale: vi.fn(),
  mockGetSetting: vi.fn(),
  mockUpdateInvoice: vi.fn(),
  mockIsSlotTaken: vi.fn(),
  mockCreateAdminBooking: vi.fn(),
  mockAdminSlotBookable: vi.fn(),
  mockLoadSchedulingRules: vi.fn(),
  mockIssueManualInvoice: vi.fn(),
  mockSendDepositLinkEmail: vi.fn(),
}));

vi.mock("./db", () => ({
  matchOrCreateCustomer: mockMatchOrCreateCustomer,
  getCustomerById: mockGetCustomerById,
  getBookingById: mockGetBookingById,
  updateBooking: mockUpdateBooking,
  // Present only to prove it is NEVER the path a brain booking takes.
  createBooking: mockCreateBookingRaw,
  expireStaleBookingsForSlot: mockExpireStale,
  getSetting: mockGetSetting,
  updateInvoice: mockUpdateInvoice,
  isSlotTakenError: mockIsSlotTaken,
}));

vi.mock("./adminBooking", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    createAdminBooking: mockCreateAdminBooking,
    adminSlotBookable: mockAdminSlotBookable,
    slotUnavailableError: () => new TRPCError({ code: "BAD_REQUEST", message: SLOT_REFUSAL }),
  };
});

vi.mock("./routers/booking", () => ({
  loadSchedulingRules: mockLoadSchedulingRules,
  SERVICE_NAMES: {
    deep: { en: "Deep Cleaning", es: "Limpieza Profunda" },
    residential: { en: "Residential Cleaning", es: "Limpieza Residencial" },
  },
}));

vi.mock("./balance", () => ({ issueManualInvoice: mockIssueManualInvoice }));
vi.mock("./emails", () => ({ sendDepositLinkEmail: mockSendDepositLinkEmail }));

import { _resetRateLimits } from "./antiSpam";
import { _resetIdempotencyReplays, registerBrainWriteRoutes } from "./brainWriteRoutes";

const WRITE_TOKEN = "1f9c4e".repeat(11); // 66 hex chars, like a real 32-byte token
const READ_TOKEN = "0b7f3a".repeat(11); // the OTHER secret — must never authenticate here
const ACTOR = "[via PRIMARY — Karyme]";

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Registers the routes against a stub app that records every registration:
 * the five write paths land in `routes`, the trailing regex catch-all in
 * `catchAll`, and anything on any other verb in `nonPost` — which the
 * write-only-by-construction claim says stays empty.
 */
function captureRoutes() {
  const routes = new Map<string, Handler>();
  const nonPost: string[] = [];
  let catchAll: { path: RegExp; handler: Handler } | undefined;
  const record =
    (method: string) =>
    (path: string | RegExp, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as Handler;
      if (method !== "post") {
        nonPost.push(`${method} ${String(path)}`);
      } else if (path instanceof RegExp) {
        catchAll = { path, handler };
      } else {
        routes.set(path, handler);
      }
    };
  const app = {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    patch: record("patch"),
    delete: record("delete"),
    all: record("all"),
    use: record("use"),
  } as unknown as Express;
  registerBrainWriteRoutes(app);
  return { routes, nonPost, catchAll };
}

function fakeReq(
  over: { authorization?: string | null; body?: unknown; params?: object; idempotencyKey?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (over.authorization !== null) headers.authorization = over.authorization ?? `Bearer ${WRITE_TOKEN}`;
  if (over.idempotencyKey) headers["idempotency-key"] = over.idempotencyKey;
  return {
    headers,
    params: over.params ?? {},
    query: {},
    body: over.body ?? {},
    socket: { remoteAddress: "10.9.8.7" },
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function call(path: string, over: Parameters<typeof fakeReq>[0] = {}) {
  const { routes } = captureRoutes();
  const handler = routes.get(path);
  if (!handler) throw new Error(`no handler for ${path}`);
  const res = fakeRes();
  await handler(fakeReq(over), res as unknown as Response);
  return res;
}

/** Vitest 2 has no toHaveBeenCalledExactlyOnceWith; this is that assertion. */
function expectCalledOnceWith(fn: ReturnType<typeof vi.fn>, ...args: unknown[]) {
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(...args);
}

const WRITE_PATHS = [
  "/api/brain/customers",
  "/api/brain/bookings",
  "/api/brain/bookings/:id/reschedule",
  "/api/brain/bookings/:id/cancel",
  "/api/brain/invoices",
];

/** A body that satisfies each route's validation, to reach the layer under test. */
function validBodyFor(path: string): { body: object; params?: object } {
  switch (path) {
    case "/api/brain/customers":
      return { body: { actor: ACTOR, firstName: "Dana", email: "dana@example.com" } };
    case "/api/brain/bookings":
      return { body: { actor: ACTOR, firstName: "Rosa", phone: "+1 210 555 0100" } };
    case "/api/brain/invoices":
      return { body: { actor: ACTOR, customerId: 12, amount: 180 } };
    case "/api/brain/bookings/:id/cancel":
      return { body: { actor: ACTOR }, params: { id: "88" } };
    default:
      return { body: { actor: ACTOR, date: "2026-09-02", time: "14:00" }, params: { id: "88" } };
  }
}

const RULES = {
  schedule: { monday: { open: "08:00", close: "18:00" } },
  lunchBreak: true,
  leadTimeHours: 72,
  durations: DEFAULT_DURATIONS,
};

const CUSTOMER_ROW = {
  id: 12,
  firstName: "Rosa",
  lastName: "Marquez",
  email: "rosa@example.com",
  phone: "+1 210 555 0100",
  address: "4411 Hidden Gate Rd",
  city: "San Antonio",
  zip: "78201",
  preferredLocale: "es",
  notes: "gate code 4411",
};

const BOOKING_ROW = {
  id: 88,
  reference: "GC-2041",
  customerId: 12,
  serviceType: "deep",
  status: "confirmed",
  scheduledDate: "2026-09-01",
  scheduledTime: "10:00",
  estimatedHours: 4,
  sqft: 1800,
  notes: "gate code 4411",
};

/** What the mocked createAdminBooking hands back — payToken and all. */
const ADMIN_RESULT = {
  bookingId: 88,
  reference: "GC-2041",
  payToken: "secret_pay_token_value",
  payUrl: "https://grapefruitcleaning.example/pay/deposit/secret_pay_token_value",
  basePrice: 180,
  depositEstimate: 45,
  expiresAt: new Date("2026-09-01T18:00:00Z"),
  sqftCorrected: false,
  sqft: 1800,
  customerWillChoose: [] as string[],
};

const ISSUED = {
  outcome: "issued" as const,
  invoiceId: 7,
  number: "INV-0007",
  amount: 180,
  emailed: true,
  expiresOn: "2026-09-06",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("BRAIN_WRITE_TOKEN", WRITE_TOKEN);
  _resetRateLimits();
  _resetIdempotencyReplays();
  mockIsSlotTaken.mockReturnValue(false);
  mockGetSetting.mockResolvedValue(undefined);
  mockLoadSchedulingRules.mockResolvedValue(RULES);
  mockExpireStale.mockResolvedValue(0);
  mockAdminSlotBookable.mockResolvedValue(true);
  mockSendDepositLinkEmail.mockResolvedValue(true);
  mockUpdateBooking.mockResolvedValue(undefined);
  mockUpdateInvoice.mockResolvedValue(undefined);
  mockCreateAdminBooking.mockResolvedValue({ ...ADMIN_RESULT });
  mockMatchOrCreateCustomer.mockResolvedValue({ customerId: 41, existed: false });
  mockGetCustomerById.mockResolvedValue({ ...CUSTOMER_ROW });
  mockGetBookingById.mockResolvedValue({ ...BOOKING_ROW });
  mockIssueManualInvoice.mockResolvedValue({ ...ISSUED });
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_configured");
});

const writeFns = () => [
  mockMatchOrCreateCustomer,
  mockCreateAdminBooking,
  mockCreateBookingRaw,
  mockUpdateBooking,
  mockIssueManualInvoice,
  mockUpdateInvoice,
];

describe("registration", () => {
  it("registers exactly the five spec'd POST routes and nothing on any other verb", () => {
    const { routes, nonPost } = captureRoutes();
    expect([...routes.keys()].sort()).toEqual([...WRITE_PATHS].sort());
    expect(nonPost).toEqual([]);
  });

  it("ends with a POST catch-all whose 404 body is the PINNED unknown-route string", async () => {
    const { catchAll } = captureRoutes();
    expect(catchAll).toBeDefined();
    expect(catchAll!.path.test("/api/brain/bookings/88/resched")).toBe(true);
    expect(catchAll!.path.test("/api/brain")).toBe(true);
    // Must not swallow neighbouring APIs.
    expect(catchAll!.path.test("/api/brainstorm")).toBe(false);
    expect(catchAll!.path.test("/api/version")).toBe(false);
    const res = fakeRes();
    await catchAll!.handler(fakeReq({ authorization: null }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    // The brain client maps THIS EXACT body to "the two sides' paths have
    // skewed"; any other wording reads as the CRM refusing a real record.
    expect(res.body).toEqual({ error: "unknown brain route" });
  });
});

describe("authentication", () => {
  it("answers 503 on every route while BRAIN_WRITE_TOKEN is unset — the feature is off", async () => {
    vi.stubEnv("BRAIN_WRITE_TOKEN", "");
    for (const path of WRITE_PATHS) {
      const res = await call(path, validBodyFor(path));
      expect(res.statusCode, path).toBe(503);
      expect(res.body, path).toEqual({ error: "brain write API is not configured" });
    }
    for (const fn of writeFns()) expect(fn).not.toHaveBeenCalled();
  });

  it("401s every route without an Authorization header, touching nothing", async () => {
    for (const path of WRITE_PATHS) {
      const res = await call(path, { ...validBodyFor(path), authorization: null });
      expect(res.statusCode, path).toBe(401);
      expect(res.body, path).toEqual({ error: "unauthorized" });
    }
    for (const fn of writeFns()) expect(fn).not.toHaveBeenCalled();
  });

  it("401s a wrong token", async () => {
    for (const path of WRITE_PATHS) {
      const res = await call(path, { ...validBodyFor(path), authorization: `Bearer ${WRITE_TOKEN}x` });
      expect(res.statusCode, path).toBe(401);
    }
  });

  it("REFUSES the read token — a leaked reader must not become a writer", async () => {
    vi.stubEnv("BRAIN_READ_TOKEN", READ_TOKEN);
    for (const path of WRITE_PATHS) {
      const res = await call(path, { ...validBodyFor(path), authorization: `Bearer ${READ_TOKEN}` });
      expect(res.statusCode, path).toBe(401);
    }
    for (const fn of writeFns()) expect(fn).not.toHaveBeenCalled();
  });

  it("rate limits at 30 writes a minute per IP", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await call("/api/brain/customers", validBodyFor("/api/brain/customers"));
      expect(res.statusCode).toBe(200);
    }
    const res = await call("/api/brain/customers", validBodyFor("/api/brain/customers"));
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "too many requests" });
  });

  it("requires actor on every route — each write is attributed", async () => {
    for (const path of WRITE_PATHS) {
      const { body, params } = validBodyFor(path);
      const rest = { ...(body as Record<string, unknown>) };
      delete rest.actor;
      const res = await call(path, { body: rest, params });
      expect(res.statusCode, path).toBe(400);
      expect((res.body as { error: string }).error, path).toContain("actor is required");
    }
    for (const fn of writeFns()) expect(fn).not.toHaveBeenCalled();
  });

  it("400s an unknown field instead of silently dropping a fact", async () => {
    const res = await call("/api/brain/customers", {
      body: { actor: ACTOR, firstName: "Dana", email: "dana@example.com", vip: true },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('"vip"');
  });
});

describe("POST /api/brain/customers", () => {
  it("executes db.matchOrCreateCustomer with the facts and the attribution note", async () => {
    const res = await call("/api/brain/customers", {
      body: {
        actor: ACTOR,
        firstName: "Dana",
        lastName: "Fields",
        email: "dana@example.com",
        phone: "+1 210 555 0188",
        address: null,
        city: null,
        zip: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ customerId: 41, existed: false });
    expect(Object.keys(res.body as object).sort()).toEqual(["customerId", "existed"]);
    expectCalledOnceWith(mockMatchOrCreateCustomer, {
      firstName: "Dana",
      lastName: "Fields",
      email: "dana@example.com",
      phone: "+1 210 555 0188",
      address: undefined,
      city: undefined,
      zip: undefined,
      note: ACTOR,
    });
  });

  it("reports a match as existed:true", async () => {
    mockMatchOrCreateCustomer.mockResolvedValue({ customerId: 12, existed: true });
    const res = await call("/api/brain/customers", validBodyFor("/api/brain/customers"));
    expect(res.body).toEqual({ customerId: 12, existed: true });
  });

  it("refuses a customer with no way to be reached", async () => {
    const res = await call("/api/brain/customers", {
      body: { actor: ACTOR, firstName: "Dana", email: null, phone: null },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "an email or a phone number is required — a customer with neither cannot be reached"
    );
    expect(mockMatchOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("refuses a nameless customer", async () => {
    const res = await call("/api/brain/customers", { body: { actor: ACTOR, email: "dana@example.com" } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("first name is required");
  });
});

describe("POST /api/brain/bookings", () => {
  const FULL_BODY = {
    actor: ACTOR,
    customerId: null,
    firstName: "Rosa",
    lastName: "Marquez",
    email: "rosa@example.com",
    phone: "+1 210 555 0100",
    serviceType: "deep",
    serviceRequested: "deep clean",
    date: "2026-09-01",
    time: "10:00",
    notes: null,
    sendEmail: true,
  };

  it("executes createAdminBooking — never raw db.createBooking — with the attribution in the notes", async () => {
    const res = await call("/api/brain/bookings", { body: FULL_BODY });
    expect(res.statusCode).toBe(200);
    expectCalledOnceWith(mockCreateAdminBooking, 
      {
        customerId: undefined,
        firstName: "Rosa",
        lastName: "Marquez",
        email: "rosa@example.com",
        phone: "+1 210 555 0100",
        serviceType: "deep",
        date: "2026-09-01",
        time: "10:00",
        notes: ACTOR,
        locale: "en",
      },
      expect.any(String)
    );
    expect(mockCreateBookingRaw).not.toHaveBeenCalled();
    expect(mockMatchOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("answers exactly the pinned keys — the payToken rides only inside payUrl", async () => {
    const res = await call("/api/brain/bookings", { body: FULL_BODY });
    expect(res.body).toEqual({
      bookingId: 88,
      reference: "GC-2041",
      basePrice: 180,
      payUrl: "https://grapefruitcleaning.example/pay/deposit/secret_pay_token_value",
      emailSent: true,
      customerWillChoose: [],
    });
    expect((res.body as Record<string, unknown>).payToken).toBeUndefined();
    expect(Object.keys(res.body as object).sort()).toEqual(
      ["basePrice", "bookingId", "customerWillChoose", "emailSent", "payUrl", "reference"].sort()
    );
  });

  it("books for the exact row when customerId is given, skipping matching entirely", async () => {
    const res = await call("/api/brain/bookings", {
      body: { actor: ACTOR, customerId: 12, serviceType: "deep", date: "2026-09-01", time: "10:00" },
    });
    expect(res.statusCode).toBe(200);
    expectCalledOnceWith(mockGetCustomerById, 12);
    expect(mockMatchOrCreateCustomer).not.toHaveBeenCalled();
    expectCalledOnceWith(mockCreateAdminBooking, 
      expect.objectContaining({
        customerId: 12,
        firstName: "Rosa",
        lastName: "Marquez",
        email: "rosa@example.com",
        phone: "+1 210 555 0100",
        locale: "es",
      }),
      expect.any(String)
    );
  });

  it("404s an unknown customerId before anything is booked", async () => {
    mockGetCustomerById.mockResolvedValue(undefined);
    const res = await call("/api/brain/bookings", { body: { actor: ACTOR, customerId: 999 } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "no such customer — nothing was booked" });
    expect(mockCreateAdminBooking).not.toHaveBeenCalled();
  });

  it("keeps the spoken words in the notes when the service could not be folded", async () => {
    await call("/api/brain/bookings", {
      body: {
        actor: ACTOR,
        firstName: "Rosa",
        phone: "+1 210 555 0100",
        serviceType: null,
        serviceRequested: "the big spring scrub with the oven",
        notes: "call before arriving",
      },
    });
    const input = mockCreateAdminBooking.mock.calls[0]![0] as { notes: string; serviceType?: string };
    expect(input.serviceType).toBeUndefined();
    expect(input.notes).toBe(
      `call before arriving\nService requested: the big spring scrub with the oven\n${ACTOR}`
    );
  });

  it("refuses a serviceType outside the CRM's own enum, speakably", async () => {
    const res = await call("/api/brain/bookings", {
      body: { actor: ACTOR, firstName: "Rosa", phone: "+1 210 555 0100", serviceType: "spring scrub" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain('"spring scrub" is not a service this CRM knows');
    expect(mockCreateAdminBooking).not.toHaveBeenCalled();
  });

  it("refuses a date without a time in the admin form's own words", async () => {
    const res = await call("/api/brain/bookings", {
      body: { actor: ACTOR, firstName: "Rosa", phone: "+1 210 555 0100", date: "2026-09-01" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "A held time needs both a date and a time — or leave both blank and let them pick.",
    });
  });

  it("requires a reachable customer when no customerId picked the row", async () => {
    const res = await call("/api/brain/bookings", { body: { actor: ACTOR, firstName: "Rosa" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Enter an email or a phone number — the link needs a way to reach them." });
  });

  it("maps the scheduling gates' refusal to a 409 with the speakable reason", async () => {
    mockCreateAdminBooking.mockRejectedValue(new TRPCError({ code: "BAD_REQUEST", message: SLOT_REFUSAL }));
    const res = await call("/api/brain/bookings", { body: FULL_BODY });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: SLOT_REFUSAL });
  });

  it("maps any other refusal from the booking path to a 400 with its own words", async () => {
    mockCreateAdminBooking.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "Enter an email or a phone number — the link needs a way to reach them." })
    );
    const res = await call("/api/brain/bookings", { body: FULL_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Enter an email or a phone number — the link needs a way to reach them." });
  });

  it("replicates the admin panel's deposit-link email", async () => {
    await call("/api/brain/bookings", { body: FULL_BODY });
    expectCalledOnceWith(mockSendDepositLinkEmail, 
      {
        reference: "GC-2041",
        serviceName: "Deep Cleaning",
        date: "2026-09-01",
        time: "10:00",
        customerName: "Rosa",
        customerEmail: "rosa@example.com",
        basePrice: 180,
        deposit: 45,
        payUrl: ADMIN_RESULT.payUrl,
        expiresOn: "2026-09-01",
        locale: "en",
        bizPhone: undefined,
      },
      { bookingId: 88 }
    );
  });

  it("reports emailSent:false honestly when the mail server fails", async () => {
    mockSendDepositLinkEmail.mockRejectedValue(new Error("SMTP down"));
    const res = await call("/api/brain/bookings", { body: FULL_BODY });
    expect(res.statusCode).toBe(200);
    expect((res.body as { emailSent: boolean }).emailSent).toBe(false);
  });

  it("sends nothing when sendEmail is false or there is no email", async () => {
    await call("/api/brain/bookings", { body: { ...FULL_BODY, sendEmail: false } });
    await call("/api/brain/bookings", { body: { ...FULL_BODY, email: null, sendEmail: true } });
    expect(mockSendDepositLinkEmail).not.toHaveBeenCalled();
  });

  it("passes through a null basePrice and the customer's remaining choices", async () => {
    mockCreateAdminBooking.mockResolvedValue({
      ...ADMIN_RESULT,
      basePrice: null,
      depositEstimate: null,
      customerWillChoose: ["service", "size", "time"],
    });
    const res = await call("/api/brain/bookings", {
      body: { actor: ACTOR, firstName: "Rosa", phone: "+1 210 555 0100" },
    });
    const body = res.body as { basePrice: unknown; customerWillChoose: string[] };
    expect(body.basePrice).toBeNull();
    expect(body.customerWillChoose).toEqual(["service", "size", "time"]);
  });
});

describe("POST /api/brain/bookings/:id/reschedule", () => {
  const RESCHEDULE = { body: { actor: ACTOR, date: "2026-09-02", time: "14:00" }, params: { id: "88" } };

  it("composes the admin building blocks exactly and answers { ok: true }", async () => {
    const res = await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expectCalledOnceWith(mockGetBookingById, 88);
    expectCalledOnceWith(mockExpireStale, "2026-09-02", "14:00");
    expectCalledOnceWith(mockAdminSlotBookable, {
      date: "2026-09-02",
      time: "14:00",
      jobHours: 4,
      overrideNotice: false,
      schedule: RULES.schedule,
      lunchBreak: true,
      leadTimeHours: 72,
      durations: DEFAULT_DURATIONS,
      excludeBookingId: 88,
    });
    expectCalledOnceWith(mockUpdateBooking, 88, {
      scheduledDate: "2026-09-02",
      scheduledTime: "14:00",
      estimatedHours: 4,
      notes: `gate code 4411\n${ACTOR} rescheduled to 2026-09-02 14:00`,
    });
  });

  it("falls back to the duration ladder when the booking pinned no hours", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING_ROW, estimatedHours: null });
    await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
    const expected = durationHoursFor("deep", 1800, DEFAULT_DURATIONS);
    expect(mockAdminSlotBookable).toHaveBeenCalledWith(expect.objectContaining({ jobHours: expected }));
    expect(mockUpdateBooking).toHaveBeenCalledWith(88, expect.objectContaining({ estimatedHours: expected }));
  });

  it("404s a missing booking", async () => {
    mockGetBookingById.mockResolvedValue(undefined);
    const res = await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "no such booking — nothing was rescheduled" });
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("refuses the dead states with a speakable reason", async () => {
    for (const status of ["cancelled", "expired"] as const) {
      mockGetBookingById.mockResolvedValue({ ...BOOKING_ROW, status });
      const res = await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
      expect(res.statusCode, status).toBe(400);
      expect((res.body as { error: string }).error, status).toContain("book it again");
    }
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("400s a slot the scheduling gates refuse, in the admin panel's words", async () => {
    mockAdminSlotBookable.mockResolvedValue(false);
    const res = await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: SLOT_REFUSAL });
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("409s the unique-index race — the slot was taken between check and write", async () => {
    mockUpdateBooking.mockRejectedValue(new Error("ER_DUP_ENTRY slotKey"));
    mockIsSlotTaken.mockReturnValue(true);
    const res = await call("/api/brain/bookings/:id/reschedule", RESCHEDULE);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "Another booking already holds that date and time." });
  });

  it("requires a well-formed date and time", async () => {
    for (const body of [
      { actor: ACTOR, time: "14:00" },
      { actor: ACTOR, date: "2026-09-02" },
      { actor: ACTOR, date: "Sep 2", time: "14:00" },
      { actor: ACTOR, date: "2026-09-02", time: "2pm" },
    ]) {
      const res = await call("/api/brain/bookings/:id/reschedule", { body, params: { id: "88" } });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });
});

describe("POST /api/brain/bookings/:id/cancel", () => {
  const CANCEL = { body: { actor: ACTOR }, params: { id: "88" } };

  it("mirrors admin.updateBookingStatus('cancelled'): one status write, no email, no refund", async () => {
    const res = await call("/api/brain/bookings/:id/cancel", CANCEL);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expectCalledOnceWith(mockUpdateBooking, 88, {
      status: "cancelled",
      notes: `gate code 4411\n${ACTOR} cancelled this booking`,
    });
    // Side-effect honesty is structural: nothing here CAN email or refund.
    expect(mockSendDepositLinkEmail).not.toHaveBeenCalled();
    expect(mockIssueManualInvoice).not.toHaveBeenCalled();
  });

  it("treats an already-cancelled booking as done rather than stacking audit lines", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING_ROW, status: "cancelled" });
    const res = await call("/api/brain/bookings/:id/cancel", CANCEL);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });

  it("404s a missing booking", async () => {
    mockGetBookingById.mockResolvedValue(undefined);
    const res = await call("/api/brain/bookings/:id/cancel", CANCEL);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "no such booking — nothing was cancelled" });
  });
});

describe("POST /api/brain/invoices", () => {
  const INVOICE = { body: { actor: ACTOR, customerId: 12, amount: 180 } };

  it("executes issueManualInvoice verbatim and answers exactly the pinned keys", async () => {
    const res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(200);
    expectCalledOnceWith(mockIssueManualInvoice, {
      customerId: 12,
      amount: 180,
      customItems: undefined,
      origin: expect.any(String),
    });
    // Exactly four keys: no expiry, no emailError, no payToken, no Stripe ids.
    expect(res.body).toEqual({ invoiceId: 7, number: "INV-0007", amount: 180, emailed: true });
    expect(Object.keys(res.body as object).sort()).toEqual(["amount", "emailed", "invoiceId", "number"]);
  });

  it("makes the memo the single custom line item carrying the whole amount", async () => {
    await call("/api/brain/invoices", {
      body: { actor: ACTOR, customerId: 12, amount: 180, memo: "deep clean, August 30" },
    });
    expectCalledOnceWith(mockIssueManualInvoice, {
      customerId: 12,
      amount: 0,
      customItems: [{ name: "deep clean, August 30", amount: 180 }],
      origin: expect.any(String),
    });
  });

  it("stamps the attribution into the invoice's issuedVia column", async () => {
    await call("/api/brain/invoices", INVOICE);
    expectCalledOnceWith(mockUpdateInvoice, 7, { issuedVia: ACTOR });
  });

  it("still answers 200 when the attribution stamp fails — the invoice is already live", async () => {
    mockUpdateInvoice.mockRejectedValue(new Error("column vanished"));
    const res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ invoiceId: 7, number: "INV-0007", amount: 180, emailed: true });
  });

  it("503s without Stripe configured — off, not broken", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "payments are not configured on the CRM, so no invoice can be raised" });
    expect(mockIssueManualInvoice).not.toHaveBeenCalled();
  });

  it("maps the outcome union to the admin panel's own refusals", async () => {
    mockIssueManualInvoice.mockResolvedValue({ outcome: "customer_not_found" });
    let res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "That customer no longer exists." });

    mockIssueManualInvoice.mockResolvedValue({ outcome: "customer_has_no_email" });
    res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "This customer has no email address on file, so there is nowhere to send the payment link. Add one on their profile first.",
    });
  });

  it("reports emailed:false honestly, with the invoice still live", async () => {
    mockIssueManualInvoice.mockResolvedValue({ ...ISSUED, emailed: false, emailError: "SMTP down" });
    const res = await call("/api/brain/invoices", INVOICE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ invoiceId: 7, number: "INV-0007", amount: 180, emailed: false });
  });

  it("refuses malformed amounts speakably", async () => {
    for (const [amount, memo] of [
      [0.5, undefined],
      [-20, undefined],
      [30000, undefined],
      [180.005, undefined],
      [180.5, "with a memo"],
    ] as const) {
      const res = await call("/api/brain/invoices", { body: { actor: ACTOR, customerId: 12, amount, memo } });
      expect(res.statusCode, String(amount)).toBe(400);
      expect(mockIssueManualInvoice).not.toHaveBeenCalled();
    }
  });
});

describe("idempotency", () => {
  it("replays the original response for a repeated Idempotency-Key instead of writing twice", async () => {
    const first = await call("/api/brain/customers", {
      ...validBodyFor("/api/brain/customers"),
      idempotencyKey: "key-1",
    });
    mockMatchOrCreateCustomer.mockResolvedValue({ customerId: 999, existed: true });
    const second = await call("/api/brain/customers", {
      ...validBodyFor("/api/brain/customers"),
      idempotencyKey: "key-1",
    });
    expect(first.body).toEqual({ customerId: 41, existed: false });
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({ customerId: 41, existed: false });
    expect(mockMatchOrCreateCustomer).toHaveBeenCalledTimes(1);
  });

  it("a different key writes again", async () => {
    await call("/api/brain/customers", { ...validBodyFor("/api/brain/customers"), idempotencyKey: "key-1" });
    await call("/api/brain/customers", { ...validBodyFor("/api/brain/customers"), idempotencyKey: "key-2" });
    expect(mockMatchOrCreateCustomer).toHaveBeenCalledTimes(2);
  });

  it("never replays a refusal — a fixed retry must reach the handler", async () => {
    const bad = { body: { actor: ACTOR, firstName: "Dana" }, idempotencyKey: "key-3" };
    const first = await call("/api/brain/customers", bad);
    expect(first.statusCode).toBe(400);
    const second = await call("/api/brain/customers", {
      ...validBodyFor("/api/brain/customers"),
      idempotencyKey: "key-3",
    });
    expect(second.statusCode).toBe(200);
    expect(mockMatchOrCreateCustomer).toHaveBeenCalledTimes(1);
  });
});
