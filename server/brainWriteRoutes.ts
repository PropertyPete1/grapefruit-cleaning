/**
 * The Brain Write API: five POST routes for PRIMARY's grapefruit adapter.
 * Spec: lifestyle-brain/docs/grapefruit-write-api.md — the adapter is
 * fixture-tested against exactly these shapes and error strings, so any field
 * added or renamed here is a breaking change on the other side.
 *
 * Karyme takes bookings by text; "add a booking" should be one sentence to
 * the brain and one approval, not a walk through the admin panel. Each route
 * calls the same internal function the app's own UI already trusts —
 * createAdminBooking, issueManualInvoice, the reschedule building blocks —
 * never a raw insert, so every scheduling gate, pricing rule and email path
 * the panel enforces holds here too.
 *
 * Auth is `Authorization: Bearer <BRAIN_WRITE_TOKEN>` — a NEW env var,
 * deliberately independent of BRAIN_READ_TOKEN: a leaked reader must not
 * become a writer, so the read token is never accepted here (there is only
 * one comparison, and it is against the write token). Token unset means the
 * feature is off — 503 on every route — which is the activation switch: the
 * code deploys cold and turns on when the env pair is set on both sides.
 *
 * Every response is JSON, and every `error` string is written to be READ
 * ALOUD to the operator — PRIMARY relays it word for word. Every write body
 * carries an `actor` attribution tag ("[via PRIMARY — <operator>]"), stored
 * where each record's audit trail lives (booking/customer notes, the
 * invoice's issuedVia column) and never rendered to the customer.
 */
import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { CLEANING_TYPES, type CleaningType } from "@shared/pricing";
import { CUSTOM_ITEM_MAX } from "@shared/invoiceItems";
import { assertRateLimit } from "./antiSpam";
import * as db from "./db";
import { createAdminBooking, slotUnavailableError } from "./adminBooking";
import { requestIp, tokenMatches } from "./brainRoutes";
import { withAuditLine } from "./brainWriteRules";
import { issueManualInvoice } from "./balance";
import { publicOrigin } from "./publicOrigin";
import { sendDepositLinkEmail } from "./emails";
import { SERVICE_NAMES } from "./routers/booking";
import { moveConfirmedBooking, notifyEffectiveScheduleMove } from "./rescheduling";

/** What a handler resolved to; guardedWrite sends (and may replay) it. */
interface WriteResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A refusal whose message is the speakable sentence PRIMARY relays word for
 * word. Thrown from anywhere in a handler, sent as `{ error }` by the guard.
 */
class SpeakableRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function refuse(status: number, message: string): never {
  throw new SpeakableRefusal(status, message);
}

// ---------- Idempotency ----------

/**
 * Replay cache for the create routes: a repeated Idempotency-Key returns the
 * original response instead of double-writing. In-memory on purpose — v1
 * brain clients do not send the header yet (their timeout voice tells the
 * operator a write MAY have landed and to check before retrying), so this is
 * the SHOULD of the spec at the cost it deserves today. Only successes are
 * remembered: a refused write was not a write, and retrying it after fixing
 * the input must reach the handler.
 */
const idempotencyReplays = new Map<string, { at: number; result: WriteResult }>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_KEYS = 5000;

function replayFor(cacheKey: string): WriteResult | undefined {
  const hit = idempotencyReplays.get(cacheKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) {
    idempotencyReplays.delete(cacheKey);
    return undefined;
  }
  return hit.result;
}

function rememberReplay(cacheKey: string, result: WriteResult): void {
  idempotencyReplays.set(cacheKey, { at: Date.now(), result });
  if (idempotencyReplays.size > IDEMPOTENCY_MAX_KEYS) {
    // Map iterates in insertion order; dropping the front is dropping the oldest.
    const oldest = idempotencyReplays.keys().next().value;
    if (oldest !== undefined) idempotencyReplays.delete(oldest);
  }
}

/** Test hook, mirroring antiSpam's _resetRateLimits. */
export function _resetIdempotencyReplays(): void {
  idempotencyReplays.clear();
}

// ---------- The guard ----------

type WriteHandler = (req: Request) => Promise<WriteResult>;

/**
 * Auth + rate limit + refusal/error shield around every write route, in the
 * read guard's shape but against the WRITE token. Order matters: the replay
 * check sits after auth (an unauthenticated caller must not probe the cache)
 * and before the handler (a replay must not write twice).
 */
function guardedWrite(route: string, handler: WriteHandler, opts?: { idempotent?: boolean }) {
  return async (req: Request, res: Response) => {
    const expected = process.env.BRAIN_WRITE_TOKEN;
    if (!expected) {
      return res.status(503).json({ error: "brain write API is not configured" });
    }
    if (!tokenMatches(req.headers.authorization, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    // Tighter than reads on purpose: a write is one spoken approval, never a
    // page walk, so a burst here is a bug or an attack — not a workload.
    try {
      assertRateLimit("brainWrite", requestIp(req), 30, 60_000);
    } catch {
      return res.status(429).json({ error: "too many requests" });
    }
    const idempotencyKey = opts?.idempotent ? req.headers["idempotency-key"] : undefined;
    const cacheKey = typeof idempotencyKey === "string" && idempotencyKey !== "" ? `${route}:${idempotencyKey}` : undefined;
    if (cacheKey) {
      const replay = replayFor(cacheKey);
      if (replay) return res.status(replay.status).json(replay.body);
    }
    try {
      const result = await handler(req);
      if (cacheKey && result.status < 300) rememberReplay(cacheKey, result);
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof SpeakableRefusal) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error(`[BrainWriteAPI] ${route} error:`, error);
      return res.status(500).json({ error: "internal error" });
    }
  };
}

// ---------- Body validation ----------
// Hand-rolled like the read API's query validation, and just as strict: a
// malformed or unknown field is a 400 with a speakable sentence, never
// silently ignored — the brain confirming a write it believes carried a fact
// the CRM actually dropped would be worse than an error. Explicit nulls are
// accepted wherever a field is optional, because the adapter sends its empty
// facts as null rather than omitting the key.

type Body = Record<string, unknown>;

function bodyOf(req: Request): Body {
  const body = (req as { body?: unknown }).body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    refuse(400, "the request body must be a JSON object");
  }
  return body as Body;
}

function rejectUnknownFields(body: Body, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      refuse(400, `the write API does not know the field "${key}" — the two sides may have skewed`);
    }
  }
}

/** A required non-empty string, trimmed. `why` is the speakable refusal. */
function requiredString(body: Body, field: string, max: number, why: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") refuse(400, why);
  const trimmed = (value as string).trim();
  if (trimmed.length > max) refuse(400, `${field} is too long — ${max} characters at most`);
  return trimmed;
}

/** An optional string: null/undefined/"" all mean "not offered". */
function optionalString(body: Body, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") refuse(400, `${field} must be text`);
  const trimmed = (value as string).trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > max) refuse(400, `${field} is too long — ${max} characters at most`);
  return trimmed;
}

/** An optional positive integer id (null/undefined mean "not offered"). */
function optionalId(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    refuse(400, `${field} must be a positive whole number`);
  }
  return value as number;
}

/** The attribution tag every write carries. Stored, never customer-rendered. */
function actorOf(body: Body): string {
  return requiredString(body, "actor", 200, "actor is required — every brain write is attributed to the operator who approved it");
}

/** The :id path parameter. A non-number is a missing record, not a syntax lecture. */
function bookingIdOf(req: Request, notFound: string): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) refuse(404, notFound);
  return id;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{2}:\d{2}$/;

// ---------- POST /api/brain/customers ----------

const CUSTOMER_FIELDS = ["actor", "firstName", "lastName", "email", "phone", "address", "city", "zip"] as const;

/**
 * Create (or match) a customer through db.matchOrCreateCustomer — the same
 * email-first-then-phone matching findOrCreateCustomer does, minus its
 * overwrite: a matched row keeps every non-empty field and only fills blanks.
 */
async function createCustomerHandler(req: Request): Promise<WriteResult> {
  const body = bodyOf(req);
  rejectUnknownFields(body, CUSTOMER_FIELDS);
  const actor = actorOf(body);
  const firstName = requiredString(body, "firstName", 100, "a first name is required — the customer needs a name");
  const lastName = optionalString(body, "lastName", 100);
  const email = optionalString(body, "email", 320);
  if (email && !email.includes("@")) refuse(400, "that email address does not look right");
  const phone = optionalString(body, "phone", 40);
  if (!email && !phone) {
    refuse(400, "an email or a phone number is required — a customer with neither cannot be reached");
  }
  const { customerId, existed } = await db.matchOrCreateCustomer({
    firstName,
    lastName,
    email,
    phone,
    address: optionalString(body, "address", 255),
    city: optionalString(body, "city", 100),
    zip: optionalString(body, "zip", 20),
    note: actor,
  });
  return { status: 200, body: { customerId, existed } };
}

// ---------- POST /api/brain/bookings ----------

const BOOKING_FIELDS = [
  "actor",
  "customerId",
  "firstName",
  "lastName",
  "email",
  "phone",
  "serviceType",
  "serviceRequested",
  "date",
  "time",
  "notes",
  "sendEmail",
] as const;

/**
 * Create a booking through createAdminBooking — the one path that composes
 * find-or-create, every scheduling gate, county sqft verification,
 * server-side pricing, the deposit link and the hold window. Never raw
 * db.createBooking. With a customerId the booking lands on that exact row
 * and the matching is skipped entirely (the AdminBookingInput passthrough).
 */
async function createBookingHandler(req: Request): Promise<WriteResult> {
  const body = bodyOf(req);
  rejectUnknownFields(body, BOOKING_FIELDS);
  const actor = actorOf(body);
  const customerId = optionalId(body, "customerId");

  const serviceTypeRaw = optionalString(body, "serviceType", 40);
  if (serviceTypeRaw !== undefined && !(CLEANING_TYPES as readonly string[]).includes(serviceTypeRaw)) {
    refuse(400, `"${serviceTypeRaw}" is not a service this CRM knows — pass null and keep the spoken words in serviceRequested`);
  }
  const serviceType = serviceTypeRaw as CleaningType | undefined;
  const serviceRequested = optionalString(body, "serviceRequested", 300);

  const date = optionalString(body, "date", 10);
  if (date && !DATE_SHAPE.test(date)) refuse(400, "the date must look like 2026-09-01");
  const time = optionalString(body, "time", 5);
  if (time && !TIME_SHAPE.test(time)) refuse(400, "the time must look like 10:00, on a 24-hour clock");
  if (Boolean(date) !== Boolean(time)) {
    refuse(400, "A held time needs both a date and a time — or leave both blank and let them pick.");
  }

  const notes = optionalString(body, "notes", 2000);
  if (body.sendEmail !== undefined && body.sendEmail !== null && typeof body.sendEmail !== "boolean") {
    refuse(400, "sendEmail must be true or false");
  }
  const sendEmail = (body.sendEmail as boolean | undefined | null) ?? true;

  // Identity: the chosen row's own facts when a customerId came, the body's
  // otherwise — with the admin form's exact requirement and its exact words.
  let identity: { firstName: string; lastName?: string; email?: string; phone?: string };
  let locale: "en" | "es" = "en";
  if (customerId !== undefined) {
    const row = await db.getCustomerById(customerId);
    if (!row) refuse(404, "no such customer — nothing was booked");
    identity = {
      firstName: row.firstName,
      lastName: row.lastName || undefined,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
    };
    locale = (row.preferredLocale as "en" | "es") ?? "en";
  } else {
    identity = {
      firstName: requiredString(body, "firstName", 100, "a first name is required — the booking needs a customer"),
      lastName: optionalString(body, "lastName", 100),
      email: optionalString(body, "email", 320),
      phone: optionalString(body, "phone", 40),
    };
    if (!identity.email && !identity.phone) {
      refuse(400, "Enter an email or a phone number — the link needs a way to reach them.");
    }
  }

  // The audit trail rides the admin section of the notes: the operator's own
  // words first, then the spoken service when the enum could not hold it (so
  // nothing spoken is lost), then the attribution tag.
  const noteLines = [
    notes,
    serviceType === undefined && serviceRequested ? `Service requested: ${serviceRequested}` : undefined,
    actor,
  ]
    .filter(Boolean)
    .join("\n");

  let result;
  try {
    result = await createAdminBooking(
      {
        customerId,
        ...identity,
        serviceType,
        date,
        time,
        notes: noteLines,
        locale,
      },
      publicOrigin(req)
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      // The scheduling gates' refusal is a conflict (the slot is the problem);
      // everything else BAD_REQUEST-shaped is the input's problem. Both carry
      // the admin panel's own speakable sentence.
      refuse(error.message === slotUnavailableError().message ? 409 : 400, error.message);
    }
    throw error;
  }

  // The admin panel's deposit-link email, replicated: best-effort, and
  // `emailSent` reports the truth rather than the intent.
  let emailSent = false;
  if (sendEmail && identity.email) {
    const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
    try {
      emailSent = await sendDepositLinkEmail(
        {
          reference: result.reference,
          serviceName: serviceType ? SERVICE_NAMES[serviceType][locale] : undefined,
          date,
          time,
          customerName: identity.firstName,
          customerEmail: identity.email,
          basePrice: result.basePrice,
          deposit: result.depositEstimate,
          payUrl: result.payUrl,
          expiresOn: result.expiresAt.toISOString().slice(0, 10),
          locale,
          bizPhone,
        },
        { bookingId: result.bookingId }
      );
    } catch (error) {
      console.error("[BrainWriteAPI] Deposit link email failed:", error);
    }
  }

  // Exactly the pinned keys — the payToken rides only inside payUrl, and
  // basePrice is already null (never the 0 sentinel) while unpriceable.
  return {
    status: 200,
    body: {
      bookingId: result.bookingId,
      reference: result.reference,
      basePrice: result.basePrice,
      payUrl: result.payUrl,
      emailSent,
      customerWillChoose: result.customerWillChoose,
    },
  };
}

// ---------- POST /api/brain/bookings/:id/reschedule ----------

const RESCHEDULE_FIELDS = ["actor", "date", "time"] as const;

/** Uses the same atomic move, audit, reminder reset and notification path as Admin. */
async function rescheduleBookingHandler(req: Request): Promise<WriteResult> {
  const id = bookingIdOf(req, "no such booking — nothing was rescheduled");
  const body = bodyOf(req);
  rejectUnknownFields(body, RESCHEDULE_FIELDS);
  const actor = actorOf(body);
  const date = requiredString(body, "date", 10, "a date is required — say which day the job moves to");
  if (!DATE_SHAPE.test(date)) refuse(400, "the date must look like 2026-09-01");
  const time = requiredString(body, "time", 5, "a time is required — say when the job starts");
  if (!TIME_SHAPE.test(time)) refuse(400, "the time must look like 10:00, on a 24-hour clock");

  const booking = await db.getBookingById(id);
  if (!booking) refuse(404, "no such booking — nothing was rescheduled");
  if (booking.status === "cancelled") refuse(400, "that booking is cancelled — book it again instead of rescheduling it");
  if (booking.status === "expired") refuse(400, "that booking's hold expired — book it again instead of rescheduling it");

  try {
    const moved = await moveConfirmedBooking({
      bookingId: id,
      target: { date, time },
      actor: { type: "brain", label: actor },
      note: actor,
      action: "brain_moved",
    });
    await notifyEffectiveScheduleMove({ before: moved.before, after: moved.after, note: actor });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      refuse(404, "no such booking — nothing was rescheduled");
    }
    if (error instanceof TRPCError && error.code === "CONFLICT") {
      refuse(409, "Another booking already holds that date and time.");
    }
    if (error instanceof TRPCError) refuse(400, error.message);
    throw error;
  }
  return { status: 200, body: { ok: true } };
}

// ---------- POST /api/brain/bookings/:id/cancel ----------

const CANCEL_FIELDS = ["actor"] as const;

/**
 * Mirror of admin.updateBookingStatus with "cancelled": one status write; the
 * generated slotKey nulls itself and releases the slot. Sends NOTHING and
 * refunds NOTHING — the app's own behavior today — and the brain reads that
 * fact to the operator before the approval and repeats it after. Never
 * "completed" from this surface: that status auto-runs the balance pipeline.
 */
async function cancelBookingHandler(req: Request): Promise<WriteResult> {
  const id = bookingIdOf(req, "no such booking — nothing was cancelled");
  const body = bodyOf(req);
  rejectUnknownFields(body, CANCEL_FIELDS);
  const actor = actorOf(body);

  const booking = await db.getBookingById(id);
  if (!booking) refuse(404, "no such booking — nothing was cancelled");
  // Already cancelled is already done — repeating the write would only stack
  // audit lines onto the notes.
  if (booking.status === "cancelled") return { status: 200, body: { ok: true } };

  await db.updateBooking(id, {
    status: "cancelled",
    notes: withAuditLine(booking.notes, `${actor} cancelled this booking`),
  });
  return { status: 200, body: { ok: true } };
}

// ---------- POST /api/brain/invoices ----------

const INVOICE_FIELDS = ["actor", "customerId", "amount", "memo"] as const;

/**
 * issueManualInvoice verbatim: kind "manual", payToken minted, Stripe
 * checkout session created, the balance-due email sent on the spot. A memo
 * becomes the SINGLE custom line item's name carrying the whole amount (the
 * generic service line is skipped when the items already cover the total),
 * so the customer's email and checkout read the operator's words instead of
 * "Remaining balance". Balance APPROVAL stays off this surface deliberately:
 * it requires a real users.id for its audit trail, which a token-authed
 * server does not have.
 */
async function sendInvoiceHandler(req: Request): Promise<WriteResult> {
  const body = bodyOf(req);
  rejectUnknownFields(body, INVOICE_FIELDS);
  const actor = actorOf(body);
  const customerId = optionalId(body, "customerId");
  if (customerId === undefined) refuse(400, "customerId is required — say which customer this invoice is for");

  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 1) {
    refuse(400, "the amount must be at least a dollar");
  }
  if (amount > CUSTOM_ITEM_MAX) {
    refuse(400, `an invoice from this surface tops out at $${CUSTOM_ITEM_MAX.toLocaleString()}`);
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    refuse(400, "the amount can carry dollars and cents, nothing smaller");
  }
  const memo = optionalString(body, "memo", 120);
  if (memo && !Number.isInteger(amount)) {
    refuse(400, "with a memo the amount must be whole dollars — the memo becomes the line item, and line items are whole-dollar");
  }

  // Without Stripe there is no checkout session to mint: the feature is off,
  // not broken — answer 503, never a throw.
  if (!process.env.STRIPE_SECRET_KEY) {
    refuse(503, "payments are not configured on the CRM, so no invoice can be raised");
  }

  const result = await issueManualInvoice({
    customerId,
    // With a memo the whole amount rides the named line item and the generic
    // service line drops out (buildStripeLineItems skips a zero base);
    // without one, the amount is the service line exactly as the admin
    // panel's un-itemized invoice.
    amount: memo ? 0 : amount,
    customItems: memo ? [{ name: memo, amount }] : undefined,
    origin: publicOrigin(req),
  });
  if (result.outcome === "customer_not_found") refuse(404, "That customer no longer exists.");
  if (result.outcome === "customer_has_no_email") {
    refuse(
      400,
      "This customer has no email address on file, so there is nowhere to send the payment link. Add one on their profile first."
    );
  }

  // Attribution is best-effort AFTER the fact: the invoice is live and (maybe)
  // emailed, and a failed audit stamp must not make the brain report a
  // failure for a payment link the customer is already holding.
  try {
    await db.updateInvoice(result.invoiceId, { issuedVia: actor });
  } catch (error) {
    console.error("[BrainWriteAPI] invoice attribution failed:", error);
  }

  // Exactly the pinned keys. emailed:false is reported honestly — the invoice
  // is still live and payable, and the brain tells the operator the link
  // needs sending by hand. No payToken, no Stripe ids, no expiry here.
  return {
    status: 200,
    body: {
      invoiceId: result.invoiceId,
      number: result.number,
      amount: result.amount,
      emailed: result.emailed,
    },
  };
}

// ---------- Registration ----------

export function registerBrainWriteRoutes(app: Express): void {
  app.post("/api/brain/customers", guardedWrite("createCustomer", createCustomerHandler, { idempotent: true }));
  app.post("/api/brain/bookings", guardedWrite("createBooking", createBookingHandler, { idempotent: true }));
  app.post("/api/brain/bookings/:id/reschedule", guardedWrite("rescheduleBooking", rescheduleBookingHandler));
  app.post("/api/brain/bookings/:id/cancel", guardedWrite("cancelBooking", cancelBookingHandler));
  app.post("/api/brain/invoices", guardedWrite("sendInvoice", sendInvoiceHandler, { idempotent: true }));

  // Registered LAST, so it sees only POSTs that matched none of the five
  // routes above (the read module's guard waves every POST under the prefix
  // through to here). The body is PINNED: the brain client maps exactly
  // {"error":"unknown brain route"} to "the two sides' paths have skewed",
  // any other JSON error on a 404 to the CRM's own spoken refusal, and a bare
  // 404 or 405 to "the write API has not landed" — so a typo'd path is a loud
  // bridge fault instead of the SPA's HTML parsed as a success. Ahead of auth
  // for the read catch-all's reason: the path is wrong whatever the token is.
  app.post(/^\/api\/brain(\/|$)/, (_req, res) => {
    return res.status(404).json({ error: "unknown brain route" });
  });
}
