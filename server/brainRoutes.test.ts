/**
 * The brain read API's contract tests. PRIMARY's grapefruit adapter is
 * fixture-tested against exactly the shapes pinned here (see
 * lifestyle-brain/docs/grapefruit-read-api.md), so these assert exact key
 * sets, not just presence: a field added to a response is as much a break as
 * one removed, and a leaked secret is worse than either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";

const mockPageCustomers = vi.fn();
const mockGetCustomerById = vi.fn();
const mockPageBookings = vi.fn();
const mockPageContactMessages = vi.fn();
const mockPagePayments = vi.fn();

vi.mock("./db", () => ({
  pageCustomersForBrain: (...args: unknown[]) => mockPageCustomers(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  pageBookingsForBrain: (...args: unknown[]) => mockPageBookings(...args),
  pageContactMessagesForBrain: (...args: unknown[]) => mockPageContactMessages(...args),
  pagePaymentsForBrain: (...args: unknown[]) => mockPagePayments(...args),
}));

import { _resetRateLimits } from "./antiSpam";
import { registerBrainRoutes } from "./brainRoutes";

const TOKEN = "0b7f3a".repeat(11); // 66 hex chars, like a real 32-byte token

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Registers the routes against a stub app that records every registration.
 * Anything registered through a mutating verb lands in `mutating` — the
 * read-only-by-construction claim is that it stays empty. `app.all` is captured
 * separately: it is how the method guard is installed, and installing a guard
 * is not the same as registering a write handler.
 */
function captureRoutes() {
  const routes = new Map<string, Handler>();
  const mutating: string[] = [];
  const guards: { path: unknown; handler: unknown }[] = [];
  const record =
    (method: string) =>
    (path: string, ...rest: unknown[]) => {
      if (method === "get") {
        routes.set(path, rest[rest.length - 1] as Handler);
      } else if (method === "all") {
        guards.push({ path, handler: rest[rest.length - 1] });
      } else {
        mutating.push(`${method} ${path}`);
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
  registerBrainRoutes(app);
  return { routes, mutating, guards };
}

function fakeReq(over: { authorization?: string | null; params?: object; query?: object } = {}) {
  const headers: Record<string, string> = {};
  if (over.authorization !== null) headers.authorization = over.authorization ?? `Bearer ${TOKEN}`;
  return {
    headers,
    params: over.params ?? {},
    query: over.query ?? {},
    socket: { remoteAddress: "10.1.2.3" },
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

const ALL_PATHS = [
  "/api/brain/ping",
  "/api/brain/customers",
  "/api/brain/customers/:id",
  "/api/brain/bookings",
  "/api/brain/inquiries",
  "/api/brain/payments",
];

/** A full customers row, secrets and all — what must never leave the building. */
const CUSTOMER_ROW = {
  id: 12,
  firstName: "Rosa",
  lastName: "Marquez",
  email: "rosa@example.com",
  phone: "+1 210 555 0100",
  address: "4411 Hidden Gate Rd",
  city: "San Antonio",
  zip: "78201",
  preferredLocale: "en",
  notes: "gate code 4411, dog in yard",
  marketingUnsubscribedAt: null,
  marketingToken: "mkt_secret_token",
  lastMarketingEmailAt: null,
  marketingEmailCount: 2,
  createdAt: new Date("2026-01-05T12:00:00Z"),
  updatedAt: new Date("2026-02-01T09:00:00Z"),
};

const BOOKING_ROW = {
  id: 88,
  reference: "GC-2041",
  customerId: 12,
  serviceType: "residential",
  frequency: "onetime",
  scheduledDate: "2026-08-22",
  scheduledTime: "10:00",
  bedrooms: 3,
  bathrooms: 2,
  sqft: 1800,
  extras: null,
  addressLine: "4411 Hidden Gate Rd",
  unitNumber: "5B",
  city: "San Antonio",
  zip: "78201",
  notes: "key under mat",
  locale: "en",
  totalAmount: 180,
  depositAmount: 90,
  status: "confirmed",
  payToken: "pay_secret_token",
  payTokenExpiresAt: null,
  tipToken: "tip_secret_token",
  tipAmount: null,
  stripeSessionId: "cs_test_secret",
  stripePaymentIntentId: "pi_test_secret",
  tipStripePaymentIntentId: null,
  createdAt: new Date("2026-08-10T16:00:00Z"),
};

const INQUIRY_ROW = {
  id: 7,
  name: "Dana Fields",
  email: "dana@example.com",
  phone: "+1 210 555 0199",
  subject: "Move-out clean quote",
  message: "We are leaving apartment 12 at 900 Main St and need a full clean.",
  locale: "en",
  status: "new",
  createdAt: new Date("2026-08-18T15:00:00Z"),
};

const PAYMENT_ROW = {
  id: 3,
  bookingId: 88,
  invoiceId: 501,
  customerId: 12,
  amount: 90,
  kind: "deposit",
  method: "card",
  stripePaymentIntentId: "pi_test_secret",
  status: "succeeded",
  createdAt: new Date("2026-08-10T16:05:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("BRAIN_READ_TOKEN", TOKEN);
  _resetRateLimits();
  mockPageCustomers.mockResolvedValue({ rows: [], total: 0 });
  mockPageBookings.mockResolvedValue({ rows: [], total: 0 });
  mockPageContactMessages.mockResolvedValue({ rows: [], total: 0 });
  mockPagePayments.mockResolvedValue({ rows: [], total: 0 });
});

describe("read-only by construction", () => {
  it("registers exactly the six spec routes, all through GET", () => {
    const { routes, mutating } = captureRoutes();
    expect(mutating).toEqual([]);
    // The regex entry is the unknown-path fallback, not a seventh endpoint.
    const literal = Array.from(routes.keys()).filter((k) => typeof k === "string");
    expect(literal.sort()).toEqual([...ALL_PATHS].sort());
  });

  /**
   * Without this guard a POST falls through every GET registration to the SPA
   * catch-all and answers 200 with the marketing site's HTML — telling PRIMARY's
   * adapter the write was accepted. Nothing is ever written either way; the
   * point is that the protocol should say so.
   */
  describe("write methods are refused with 405", () => {
    const guard = () => {
      const { guards } = captureRoutes();
      expect(guards).toHaveLength(1);
      return guards[0]!;
    };

    const runGuard = (method: string) => {
      const { handler } = guard();
      const res = fakeRes();
      const headers: Record<string, string> = {};
      let nextCalled = false;
      (handler as (req: Request, res: Response, next: () => void) => unknown)(
        { method, headers: {}, params: {}, query: {}, socket: { remoteAddress: "10.1.2.3" } } as unknown as Request,
        {
          ...res,
          status: res.status,
          json: res.json,
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
        } as unknown as Response,
        () => {
          nextCalled = true;
        }
      );
      return { res, headers, nextCalled };
    };

    it("covers the whole /api/brain namespace, not one path at a time", () => {
      const { path } = guard();
      expect(path).toBeInstanceOf(RegExp);
      const re = path as RegExp;
      for (const p of ALL_PATHS) expect(re.test(p), p).toBe(true);
      expect(re.test("/api/brain")).toBe(true);
      // Must not swallow neighbouring APIs.
      expect(re.test("/api/version")).toBe(false);
      expect(re.test("/api/trpc/booking.pricingConfig")).toBe(false);
      expect(re.test("/api/brainstorm")).toBe(false);
    });

    it("answers 405 with Allow: GET, HEAD on every write verb", () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const { res, headers, nextCalled } = runGuard(method);
        expect(res.statusCode, method).toBe(405);
        expect(res.body, method).toEqual({ error: "method not allowed" });
        expect(headers.Allow, method).toBe("GET, HEAD");
        expect(nextCalled, method).toBe(false);
      }
    });

    it("lets GET and HEAD through to the real handlers", () => {
      for (const method of ["GET", "HEAD"]) {
        const { nextCalled, res } = runGuard(method);
        expect(nextCalled, method).toBe(true);
        expect(res.statusCode, method).toBe(200); // untouched by the guard
      }
    });

    it("refuses the verb without consulting the token, and touches no data", () => {
      // No BRAIN_READ_TOKEN in the environment here: a wrong verb is wrong
      // whether or not the caller is authenticated, and a caller fixing a verb
      // should not first have to fix a credential.
      const { res } = runGuard("POST");
      expect(res.statusCode).toBe(405);
      expect(mockPageCustomers).not.toHaveBeenCalled();
      expect(mockPageBookings).not.toHaveBeenCalled();
      expect(mockPagePayments).not.toHaveBeenCalled();
      expect(mockPageContactMessages).not.toHaveBeenCalled();
      expect(mockGetCustomerById).not.toHaveBeenCalled();
    });
  });
});

describe("authentication", () => {
  it("401s every route without an Authorization header, touching no data", async () => {
    for (const path of ALL_PATHS) {
      const res = await call(path, { authorization: null });
      expect(res.statusCode, path).toBe(401);
    }
    expect(mockPageCustomers).not.toHaveBeenCalled();
    expect(mockGetCustomerById).not.toHaveBeenCalled();
    expect(mockPageBookings).not.toHaveBeenCalled();
    expect(mockPageContactMessages).not.toHaveBeenCalled();
    expect(mockPagePayments).not.toHaveBeenCalled();
  });

  it("401s a wrong token and a non-Bearer scheme", async () => {
    expect((await call("/api/brain/ping", { authorization: `Bearer ${TOKEN}x` })).statusCode).toBe(401);
    expect((await call("/api/brain/ping", { authorization: "Bearer " })).statusCode).toBe(401);
    expect((await call("/api/brain/ping", { authorization: `Basic ${TOKEN}` })).statusCode).toBe(401);
  });

  it("503s every route while BRAIN_READ_TOKEN is unset — the feature is off", async () => {
    vi.stubEnv("BRAIN_READ_TOKEN", "");
    for (const path of ALL_PATHS) {
      const res = await call(path);
      expect(res.statusCode, path).toBe(503);
    }
    expect(mockPageCustomers).not.toHaveBeenCalled();
  });

  it("429s once a single client exceeds the per-minute budget", async () => {
    // The budget must clear the adapter's worst legal burst: 50 pages × 4
    // collections in one snapshot pass, since it reads a 429 as source-down.
    for (let i = 0; i < 240; i++) {
      expect((await call("/api/brain/ping")).statusCode).toBe(200);
    }
    expect((await call("/api/brain/ping")).statusCode).toBe(429);
  });
});

describe("GET /api/brain/ping", () => {
  it("answers with liveness and the business name, exactly", async () => {
    const res = await call("/api/brain/ping");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, business: "Grapefruit Cleaning Co." });
  });
});

describe("GET /api/brain/customers", () => {
  it("returns the bulk shape — no email, phone, notes or street address", async () => {
    mockPageCustomers.mockResolvedValue({ rows: [CUSTOMER_ROW], total: 37 });
    const res = await call("/api/brain/customers");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      customers: [
        {
          id: 12,
          firstName: "Rosa",
          lastName: "Marquez",
          city: "San Antonio",
          zip: "78201",
          createdAt: "2026-01-05T12:00:00.000Z",
          marketingUnsubscribedAt: null,
        },
      ],
      total: 37,
    });
    expect(mockPageCustomers).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("clamps limit to 200 and honours offset", async () => {
    await call("/api/brain/customers", { query: { limit: "999", offset: "40" } });
    expect(mockPageCustomers).toHaveBeenCalledWith({ limit: 200, offset: 40 });
  });

  it("400s malformed paging instead of guessing", async () => {
    expect((await call("/api/brain/customers", { query: { limit: "abc" } })).statusCode).toBe(400);
    expect((await call("/api/brain/customers", { query: { limit: "0" } })).statusCode).toBe(400);
    expect((await call("/api/brain/customers", { query: { offset: "-1" } })).statusCode).toBe(400);
    expect(mockPageCustomers).not.toHaveBeenCalled();
  });
});

describe("GET /api/brain/customers/:id", () => {
  it("returns the per-person shape — contact details, still no notes or address", async () => {
    mockGetCustomerById.mockResolvedValue(CUSTOMER_ROW);
    const res = await call("/api/brain/customers/:id", { params: { id: "12" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      id: 12,
      firstName: "Rosa",
      lastName: "Marquez",
      email: "rosa@example.com",
      phone: "+1 210 555 0100",
      city: "San Antonio",
      zip: "78201",
      createdAt: "2026-01-05T12:00:00.000Z",
      marketingUnsubscribedAt: null,
    });
    expect(mockGetCustomerById).toHaveBeenCalledWith(12);
  });

  it("404s an unknown or malformed id", async () => {
    mockGetCustomerById.mockResolvedValue(undefined);
    expect((await call("/api/brain/customers/:id", { params: { id: "9999" } })).statusCode).toBe(404);
    expect((await call("/api/brain/customers/:id", { params: { id: "abc" } })).statusCode).toBe(404);
    // The malformed id never reaches the database at all.
    expect(mockGetCustomerById).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/brain/bookings", () => {
  it("returns the spec row — no pay/tip tokens, Stripe ids, notes or address", async () => {
    mockPageBookings.mockResolvedValue({ rows: [BOOKING_ROW], total: 12 });
    const res = await call("/api/brain/bookings");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      bookings: [
        {
          id: 88,
          customerId: 12,
          reference: "GC-2041",
          serviceType: "residential",
          scheduledDate: "2026-08-22",
          scheduledTime: "10:00",
          status: "confirmed",
          totalAmount: 180,
          tipAmount: null,
          createdAt: "2026-08-10T16:00:00.000Z",
        },
      ],
      total: 12,
    });
  });

  it("keeps a slotless admin-created booking's nulls as nulls", async () => {
    mockPageBookings.mockResolvedValue({
      rows: [{ ...BOOKING_ROW, serviceType: null, scheduledDate: null, scheduledTime: null }],
      total: 1,
    });
    const res = await call("/api/brain/bookings");
    const row = (res.body as { bookings: Record<string, unknown>[] }).bookings[0]!;
    expect(row.serviceType).toBeNull();
    expect(row.scheduledDate).toBeNull();
    expect(row.scheduledTime).toBeNull();
  });

  it("passes since and customerId through to the query", async () => {
    await call("/api/brain/bookings", {
      query: { since: "2026-08-01T00:00:00Z", customerId: "12" },
    });
    expect(mockPageBookings).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      since: new Date("2026-08-01T00:00:00Z"),
      customerId: 12,
    });
  });

  it("400s an unparseable since or customerId instead of ignoring the filter", async () => {
    expect((await call("/api/brain/bookings", { query: { since: "not-a-date" } })).statusCode).toBe(400);
    expect((await call("/api/brain/bookings", { query: { customerId: "abc" } })).statusCode).toBe(400);
    expect(mockPageBookings).not.toHaveBeenCalled();
  });
});

describe("GET /api/brain/inquiries", () => {
  it("returns the spec row — the message body and phone stay home", async () => {
    mockPageContactMessages.mockResolvedValue({ rows: [INQUIRY_ROW], total: 4 });
    const res = await call("/api/brain/inquiries");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      inquiries: [
        {
          id: 7,
          name: "Dana Fields",
          email: "dana@example.com",
          subject: "Move-out clean quote",
          status: "new",
          createdAt: "2026-08-18T15:00:00.000Z",
        },
      ],
      total: 4,
    });
  });

  it("passes since through, and nothing else", async () => {
    await call("/api/brain/inquiries", { query: { since: "2026-08-01T00:00:00Z" } });
    expect(mockPageContactMessages).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      since: new Date("2026-08-01T00:00:00Z"),
    });
  });
});

describe("GET /api/brain/payments", () => {
  it("returns the spec row — no Stripe id, method or invoice linkage", async () => {
    mockPagePayments.mockResolvedValue({ rows: [PAYMENT_ROW], total: 9 });
    const res = await call("/api/brain/payments");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      payments: [
        {
          id: 3,
          customerId: 12,
          bookingId: 88,
          amount: 90,
          kind: "deposit",
          status: "succeeded",
          createdAt: "2026-08-10T16:05:00.000Z",
        },
      ],
      total: 9,
    });
  });

  it("passes since and customerId through to the query", async () => {
    await call("/api/brain/payments", {
      query: { since: "2026-08-01T00:00:00Z", customerId: "12" },
    });
    expect(mockPagePayments).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      since: new Date("2026-08-01T00:00:00Z"),
      customerId: 12,
    });
  });
});

describe("failure shield", () => {
  it("500s with a generic body when the database read throws", async () => {
    mockPageCustomers.mockRejectedValue(new Error("connection lost: mysql://user:pass@host"));
    const res = await call("/api/brain/customers");
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
  });
});

/**
 * An unknown brain path used to fall through to the SPA catch-all and answer
 * 200 with the marketing site's HTML, so a caller checking only status codes
 * read a typo'd URL as a healthy endpoint. That is exactly how a probe list
 * came to report /api/brain/invoices, /api/brain/properties and
 * /api/brain/summary as live when none of the three exist.
 */
describe("unknown paths 404 instead of reaching the SPA", () => {
  const fallback = () => {
    const { routes } = captureRoutes();
    const entry = Array.from(routes.entries()).find(([k]) => (k as unknown) instanceof RegExp);
    expect(entry, "a regex GET fallback should be registered").toBeDefined();
    return entry!;
  };

  it("is registered last, so the six real routes win", () => {
    const { routes } = captureRoutes();
    const keys = Array.from(routes.keys());
    const regexAt = keys.findIndex((k) => (k as unknown) instanceof RegExp);
    expect(regexAt).toBe(keys.length - 1);
  });

  it("matches the brain namespace without swallowing neighbours", () => {
    const [pattern] = fallback();
    const re = pattern as unknown as RegExp;
    expect(re.test("/api/brain/invoices")).toBe(true);
    expect(re.test("/api/brain/properties")).toBe(true);
    expect(re.test("/api/brain/summary")).toBe(true);
    expect(re.test("/api/brain/typo")).toBe(true);
    // Neighbouring APIs and the public site must stay untouched.
    expect(re.test("/api/version")).toBe(false);
    expect(re.test("/api/trpc/booking.pricingConfig")).toBe(false);
    expect(re.test("/api/brainstorm")).toBe(false);
    expect(re.test("/en/book")).toBe(false);
  });

  it("answers 404 JSON, never HTML, and reads no data", async () => {
    const [, handler] = fallback();
    const res = fakeRes();
    await (handler as Handler)(fakeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "unknown brain endpoint" });
    expect(mockPageCustomers).not.toHaveBeenCalled();
    expect(mockPageBookings).not.toHaveBeenCalled();
    expect(mockPagePayments).not.toHaveBeenCalled();
    expect(mockPageContactMessages).not.toHaveBeenCalled();
    expect(mockGetCustomerById).not.toHaveBeenCalled();
  });

  it("404s a wrong path without consulting the token", async () => {
    // A path is wrong whatever the credential is; a caller fixing a URL should
    // not first have to fix a token. Mirrors the 405 guard's ordering.
    const [, handler] = fallback();
    const res = fakeRes();
    await (handler as Handler)(fakeReq({ authorization: null }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "unknown brain endpoint" });
  });
});
