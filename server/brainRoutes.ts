/**
 * The Brain Read API: a tiny, read-only, token-authenticated REST surface for
 * PRIMARY's grapefruit adapter. Spec: lifestyle-brain/docs/grapefruit-read-api.md
 * — the adapter is fixture-tested against exactly these shapes, so any field
 * added or renamed here is a breaking change on the other side.
 *
 * Plain Express routes beside scheduledRoutes/seoRoutes, registered before the
 * tRPC middleware, so the Manus session machinery never touches the path. The
 * only credential is `Authorization: Bearer <BRAIN_READ_TOKEN>` — a
 * server-to-server secret that never reaches a browser on either side.
 *
 * Read-only by construction: this module registers GET handlers and nothing
 * else, and every response is built from an explicit field allowlist — street
 * addresses, notes, message bodies, Stripe ids and pay/tip tokens cannot leak
 * because they are never copied out of the row.
 *
 * The write surface (spec: lifestyle-brain/docs/grapefruit-write-api.md) is
 * brainWriteRoutes.ts, deliberately a separate module behind a separate
 * token, registered right after this one.
 */
import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "crypto";
import type { Booking, ContactMessage, Customer, Payment } from "../drizzle/schema";
import { assertRateLimit } from "./antiSpam";
import * as db from "./db";

/** Max rows per page; `?limit=` above this is clamped, per the spec. */
const PAGE_LIMIT_MAX = 200;
const PAGE_LIMIT_DEFAULT = 50;

/** Shared with brainWriteRoutes.ts — one definition of "the caller's IP". */
export function requestIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Hash both sides before comparing: timingSafeEqual demands equal-length
 * buffers, and hashing gets there without an early length check that would
 * itself leak the token's length. Shared with brainWriteRoutes.ts, which
 * compares against its own, independent token.
 */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  return timingSafeEqual(presented, createHash("sha256").update(expected).digest());
}

type BrainHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

/**
 * Auth + rate limit + error shield around every route. Token unset means the
 * feature is off — 503 on everything, so a misconfigured brain instance sees
 * "not available" rather than "forbidden" and nobody burns time on the wrong
 * diagnosis. Read at request time, not module load, so a token added to the
 * environment takes effect without a code change.
 */
function guarded(handler: BrainHandler): BrainHandler {
  return async (req, res) => {
    const expected = process.env.BRAIN_READ_TOKEN;
    if (!expected) {
      return res.status(503).json({ error: "brain read API is not configured" });
    }
    if (!tokenMatches(req.headers.authorization, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    // Nuisance guard only — the brain reads 200-row pages behind 15-minute
    // caches, so its real load is a handful of requests per refresh. The
    // budget is sized to its worst legal burst (its reader walks up to 50
    // pages across 4 collections in one pass, and a 429 reads as source-down
    // over there), not to the typical load.
    try {
      assertRateLimit("brainRead", requestIp(req), 240, 60_000);
    } catch {
      return res.status(429).json({ error: "too many requests" });
    }
    try {
      return await handler(req, res);
    } catch (error) {
      console.error("[BrainAPI] Handler error:", error);
      return res.status(500).json({ error: "internal error" });
    }
  };
}

/**
 * `?limit=` / `?offset=` / `?since=` / `?customerId=`, validated strictly: a
 * malformed filter is a 400, never silently ignored — the brain caching an
 * unfiltered read it believes is filtered would be worse than an error.
 */
function parseListQuery(
  req: Request,
  res: Response
): { limit: number; offset: number; since?: Date; customerId?: number } | undefined {
  const bad = (field: string) => {
    res.status(400).json({ error: `invalid ${field}` });
    return undefined;
  };

  let limit = PAGE_LIMIT_DEFAULT;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) return bad("limit");
    if (limit > PAGE_LIMIT_MAX) limit = PAGE_LIMIT_MAX;
  }

  let offset = 0;
  if (req.query.offset !== undefined) {
    offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) return bad("offset");
  }

  let since: Date | undefined;
  if (req.query.since !== undefined) {
    since = new Date(String(req.query.since));
    if (Number.isNaN(since.getTime())) return bad("since");
  }

  let customerId: number | undefined;
  if (req.query.customerId !== undefined) {
    customerId = Number(req.query.customerId);
    if (!Number.isInteger(customerId) || customerId < 1) return bad("customerId");
  }

  return { limit, offset, since, customerId };
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

// ---------- Serializers: the allowlists that ARE the contract ----------

/** Bulk row: no email, phone or notes — hundreds of addresses don't belong in a cached payload. */
function customerSummary(row: Customer) {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    city: row.city,
    zip: row.zip,
    createdAt: iso(row.createdAt),
    marketingUnsubscribedAt: iso(row.marketingUnsubscribedAt),
  };
}

/** The per-person read — contact details appear here and only here. */
function customerDetail(row: Customer) {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    city: row.city,
    zip: row.zip,
    createdAt: iso(row.createdAt),
    marketingUnsubscribedAt: iso(row.marketingUnsubscribedAt),
  };
}

function bookingRow(row: Booking) {
  return {
    id: row.id,
    customerId: row.customerId,
    reference: row.reference,
    serviceType: row.serviceType,
    scheduledDate: row.scheduledDate,
    scheduledTime: row.scheduledTime,
    status: row.status,
    totalAmount: row.totalAmount,
    tipAmount: row.tipAmount,
    createdAt: iso(row.createdAt),
  };
}

/** `subject` is enough for a ticker line; `message` bodies stay home. */
function inquiryRow(row: ContactMessage) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    subject: row.subject,
    status: row.status,
    createdAt: iso(row.createdAt),
  };
}

function paymentRow(row: Payment) {
  return {
    id: row.id,
    customerId: row.customerId,
    bookingId: row.bookingId,
    amount: row.amount,
    kind: row.kind,
    status: row.status,
    createdAt: iso(row.createdAt),
  };
}

// ---------- Handlers ----------

function pingHandler(_req: Request, res: Response) {
  return res.json({ ok: true, business: "Grapefruit Cleaning Co." });
}

async function listCustomersHandler(req: Request, res: Response) {
  const query = parseListQuery(req, res);
  if (!query) return;
  const { rows, total } = await db.pageCustomersForBrain({ limit: query.limit, offset: query.offset });
  return res.json({ customers: rows.map(customerSummary), total });
}

async function getCustomerHandler(req: Request, res: Response) {
  const id = Number(req.params.id);
  const customer = Number.isInteger(id) && id > 0 ? await db.getCustomerById(id) : undefined;
  if (!customer) return res.status(404).json({ error: "customer not found" });
  return res.json(customerDetail(customer));
}

async function listBookingsHandler(req: Request, res: Response) {
  const query = parseListQuery(req, res);
  if (!query) return;
  const { rows, total } = await db.pageBookingsForBrain(query);
  return res.json({ bookings: rows.map(bookingRow), total });
}

async function listInquiriesHandler(req: Request, res: Response) {
  const query = parseListQuery(req, res);
  if (!query) return;
  const { rows, total } = await db.pageContactMessagesForBrain({
    limit: query.limit,
    offset: query.offset,
    since: query.since,
  });
  return res.json({ inquiries: rows.map(inquiryRow), total });
}

async function listPaymentsHandler(req: Request, res: Response) {
  const query = parseListQuery(req, res);
  if (!query) return;
  const { rows, total } = await db.pagePaymentsForBrain(query);
  return res.json({ payments: rows.map(paymentRow), total });
}

export function registerBrainRoutes(app: Express): void {
  // A PUT/PATCH/DELETE to a brain path would otherwise fall through every
  // registration and land on the SPA catch-all, answering 200 with the
  // marketing site's HTML. Nothing is written either way, but a 200 tells
  // PRIMARY's adapter the method was accepted, which is the opposite of the
  // truth. Answer 405 with an Allow header so the contract is stated in the
  // protocol rather than merely implied by what is absent.
  //
  // POST passes through: the write API (brainWriteRoutes.ts, registered right
  // after this module) owns those, behind its own separate token — and its
  // POST JSON-404 catch-all guarantees no POST under the prefix ever reaches
  // the SPA either. This module still registers GET handlers and nothing else.
  //
  // Deliberately ahead of auth: the method is wrong regardless of the token, and
  // a caller fixing a verb should not first have to fix a credential. This
  // leaks only the fact that /api/brain/* exists, which the 503/401 already do.
  app.all(/^\/api\/brain(\/|$)/, (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "POST") return next();
    res.setHeader("Allow", "GET, HEAD, POST");
    return res.status(405).json({ error: "method not allowed" });
  });
  app.get("/api/brain/ping", guarded(pingHandler));
  app.get("/api/brain/customers", guarded(listCustomersHandler));
  app.get("/api/brain/customers/:id", guarded(getCustomerHandler));
  app.get("/api/brain/bookings", guarded(listBookingsHandler));
  app.get("/api/brain/inquiries", guarded(listInquiriesHandler));
  app.get("/api/brain/payments", guarded(listPaymentsHandler));

  // Registered LAST, so it only sees GETs that matched none of the six routes
  // above. Without it an unknown path (a typo, or a route an adapter assumes
  // exists) falls through to the SPA catch-all and answers 200 with the
  // marketing site's HTML — a caller checking status codes alone reads that as
  // a healthy endpoint and only discovers the truth when JSON parsing fails on
  // "<!doctype html>". This turns a silent wrong-shape success into a loud 404.
  //
  // Ahead of the auth guard for the same reason as the 405 above: the path is
  // wrong whatever the token is, and a caller fixing a URL should not first
  // have to fix a credential. It reveals only that /api/brain/* exists, which
  // the existing 503/401/405 responses already do.
  app.get(/^\/api\/brain(\/|$)/, (_req, res) => {
    return res.status(404).json({ error: "unknown brain endpoint" });
  });
}
