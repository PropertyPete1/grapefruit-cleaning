/**
 * Test kit: stateful stand-ins for the invoice rows and the Stripe objects
 * behind an invoice payment — enough to replay the ACH double charge end to
 * end through the REAL pay route, webhook, settlement and checkout code.
 *
 * Imported only by tests (vi.mock factories load it so the test and the mock
 * share one store). Nothing in the app imports it, so it never reaches the
 * build. Each fake db function mirrors the WHERE clause of its db.ts namesake;
 * invoiceClaimsSql.test.ts pins those real WHERE clauses separately, so the two
 * cannot drift apart unnoticed.
 */
import type { Invoice, Payment } from "../drizzle/schema";

type SessionLogRow = {
  invoiceId: number;
  invoiceNumber: string | null;
  stripeSessionId: string;
  attempt: number;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
};

export const kit = {
  invoices: new Map<number, Invoice>(),
  payments: [] as Payment[],
  sessionLog: [] as SessionLogRow[],
  bookings: new Map<number, Record<string, unknown>>(),
  customers: new Map<number, Record<string, unknown>>(),
};

export function resetKit(): void {
  kit.invoices.clear();
  kit.payments = [];
  kit.sessionLog = [];
  kit.bookings.clear();
  kit.customers.clear();
  resetFakeStripe();
}

const INVOICE_DEFAULTS: Omit<Invoice, "id" | "number" | "customerId" | "amount"> = {
  bookingId: null,
  amountCents: null,
  status: "sent",
  dueDate: null,
  paidAt: null,
  computedAmount: null,
  computedAmountCents: null,
  approvedAt: null,
  approvedByUserId: null,
  issuedVia: null,
  kind: "balance",
  serviceType: null,
  serviceDate: null,
  paymentPreference: null,
  cashChosenAt: null,
  payToken: null,
  stripeSessionId: null,
  stripeSessionExpiresAt: null,
  checkoutAttempt: 0,
  checkoutClaimedAt: null,
  paymentProcessingAt: null,
  paymentProcessingIntentId: null,
  stripePaymentIntentId: null,
  lastDuplicateIntentId: null,
  linkSentAt: null,
  linkExpiresAt: null,
  lineItems: null,
  paidVia: null,
  paidMethod: null,
  reminderCount: 0,
  lastReminderAt: null,
  reminderExhaustedAlertAt: null,
  refundNeeded: false,
  repairNote: null,
  createdAt: new Date("2026-09-27T12:00:00Z"),
};

export function seedInvoice(row: Pick<Invoice, "id" | "number" | "customerId" | "amount"> & Partial<Invoice>): Invoice {
  const invoice = { ...INVOICE_DEFAULTS, ...row } as Invoice;
  kit.invoices.set(invoice.id, invoice);
  return invoice;
}

const copy = <T>(row: T | undefined): T | undefined => (row ? { ...row } : undefined);
const settled = (invoice: Invoice) => invoice.status === "paid" || invoice.status === "void";
const affected = (changed: boolean) => changed;

/** The ./db surface the payment paths touch, with db.ts's WHERE semantics. */
export const fakeDb = {
  getSetting: async () => null,
  getInvoiceById: async (id: number) => copy(kit.invoices.get(id)),
  getInvoiceByPayToken: async (token: string) => copy(Array.from(kit.invoices.values()).find(i => i.payToken === token)),
  getBookingById: async (id: number) => copy(kit.bookings.get(id)),
  getCustomerById: async (id: number) => copy(kit.customers.get(id)),
  updateInvoice: async (id: number, patch: Partial<Invoice>) => {
    const invoice = kit.invoices.get(id);
    if (invoice) Object.assign(invoice, patch);
  },
  createPayment: async (row: Partial<Payment>) => {
    const payment = {
      id: kit.payments.length + 1,
      duplicate: false,
      amountCents: row.amountCents ?? (row.amount != null ? row.amount * 100 : null),
      createdAt: new Date(),
      ...row,
    } as Payment;
    kit.payments.push(payment);
    return payment.id;
  },
  // WHERE id AND status NOT IN (paid, void) AND (processing IS NULL OR processing = intent)
  settleUnpaidInvoice: async (
    id: number,
    data: { paidAt: Date; paidVia: "stripe"; paidMethod?: string; stripePaymentIntentId?: string }
  ) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || settled(invoice)) return false;
    const intent = data.stripePaymentIntentId;
    const inFlight = invoice.paymentProcessingIntentId;
    if (intent ? inFlight != null && inFlight !== intent : inFlight != null) return false;
    Object.assign(invoice, { status: "paid", ...data, paymentProcessingAt: null, paymentProcessingIntentId: null });
    return affected(true);
  },
  // WHERE id AND (intent: lastDuplicate <> intent AND settling <> intent) | (null: refundNeeded = false)
  flagInvoiceDuplicatePayment: async (id: number, intent: string | null) => {
    const invoice = kit.invoices.get(id);
    if (!invoice) return false;
    if (intent == null) {
      if (invoice.refundNeeded) return false;
      invoice.refundNeeded = true;
      return true;
    }
    if (invoice.lastDuplicateIntentId === intent || invoice.stripePaymentIntentId === intent) return false;
    invoice.refundNeeded = true;
    invoice.lastDuplicateIntentId = intent;
    return true;
  },
  findInvoicePaymentByIntent: async (invoiceId: number, intent: string) =>
    copy(kit.payments.find(p => p.invoiceId === invoiceId && p.stripePaymentIntentId === intent)),
  // WHERE id AND status NOT IN (paid, void) AND processing IS NULL
  markInvoicePaymentProcessing: async (id: number, intent: string, now: Date = new Date()) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || settled(invoice) || invoice.paymentProcessingIntentId != null) return false;
    invoice.paymentProcessingAt = now;
    invoice.paymentProcessingIntentId = intent;
    return true;
  },
  // WHERE id AND processing = intent
  clearInvoicePaymentProcessing: async (
    id: number,
    intent: string,
    window: { linkExpiresAt: Date; dueDate: string; restartRemindersAt?: Date }
  ) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || invoice.paymentProcessingIntentId !== intent) return false;
    const { restartRemindersAt, ...rest } = window;
    Object.assign(invoice, { paymentProcessingAt: null, paymentProcessingIntentId: null, ...rest });
    if (restartRemindersAt) {
      Object.assign(invoice, { linkSentAt: restartRemindersAt, reminderCount: 0, lastReminderAt: null, reminderExhaustedAlertAt: null });
    }
    return true;
  },
  // WHERE id AND status NOT IN (paid, void) AND lastDuplicate = intent AND processing = failed
  promoteDuplicatePayment: async (id: number, intent: string, failedIntent: string, data: { paidAt: Date; paidMethod?: string }) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || settled(invoice) || invoice.lastDuplicateIntentId !== intent || invoice.paymentProcessingIntentId !== failedIntent) {
      return false;
    }
    Object.assign(invoice, {
      status: "paid",
      paidAt: data.paidAt,
      paidVia: "stripe",
      paidMethod: data.paidMethod,
      stripePaymentIntentId: intent,
      refundNeeded: false,
      lastDuplicateIntentId: null,
      paymentProcessingAt: null,
      paymentProcessingIntentId: null,
    });
    for (const p of kit.payments) if (p.invoiceId === id && p.stripePaymentIntentId === intent) p.duplicate = false;
    if (kit.payments.some(p => p.invoiceId === id && p.duplicate && p.status === "succeeded")) invoice.refundNeeded = true;
    return true;
  },
  markDuplicatePaymentRefunded: async (id: number, intent: string) => {
    for (const p of kit.payments) if (p.invoiceId === id && p.stripePaymentIntentId === intent && p.duplicate) p.status = "refunded";
    const invoice = kit.invoices.get(id);
    if (invoice && !kit.payments.some(p => p.invoiceId === id && p.duplicate && p.status === "succeeded")) {
      Object.assign(invoice, { refundNeeded: false, lastDuplicateIntentId: null });
    }
  },
  // Offline settlement: refused while a bank payment processes.
  recordOfflineInvoicePayment: async () => ({ outcome: "not_found" as const }),
  // WHERE id AND checkoutAttempt = expected AND stripeSessionId <=> expectedSession AND status NOT IN (paid, void) AND processing IS NULL
  claimInvoiceCheckoutAttempt: async (id: number, expected: number, expectedSession: string | null, now: Date = new Date()) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || invoice.checkoutAttempt !== expected || invoice.stripeSessionId !== expectedSession) return false;
    if (settled(invoice) || invoice.paymentProcessingIntentId) return false;
    Object.assign(invoice, { checkoutAttempt: expected + 1, checkoutClaimedAt: now, stripeSessionId: null, stripeSessionExpiresAt: null });
    return true;
  },
  // WHERE id AND checkoutAttempt = attempt AND stripeSessionId IS NULL
  releaseInvoiceCheckoutClaim: async (id: number, attempt: number) => {
    const invoice = kit.invoices.get(id);
    if (invoice && invoice.checkoutAttempt === attempt && invoice.stripeSessionId == null) invoice.checkoutClaimedAt = null;
  },
  recordInvoiceCheckoutSession: async (
    id: number,
    attempt: number,
    session: { stripeSessionId: string; expiresAt: Date; createdAt?: Date }
  ) => {
    const invoice = kit.invoices.get(id);
    kit.sessionLog.push({
      invoiceId: id,
      invoiceNumber: invoice?.number ?? null,
      stripeSessionId: session.stripeSessionId,
      attempt,
      createdAt: session.createdAt ?? new Date(),
      expiresAt: session.expiresAt,
      endedAt: null,
      endReason: null,
    });
    if (!invoice || invoice.checkoutAttempt !== attempt || settled(invoice) || invoice.paymentProcessingIntentId) return false;
    invoice.stripeSessionId = session.stripeSessionId;
    invoice.stripeSessionExpiresAt = session.expiresAt;
    return true;
  },
  endInvoiceCheckoutSession: async (stripeSessionId: string, reason: string, at: Date = new Date()) => {
    const row = kit.sessionLog.find(r => r.stripeSessionId === stripeSessionId && r.endedAt == null);
    if (row) Object.assign(row, { endedAt: at, endReason: reason });
  },
  // Reminder sweep: status 'sent', a token, nothing processing.
  listSentBalanceInvoices: async () =>
    Array.from(kit.invoices.values())
      .filter(i => i.status === "sent" && i.payToken && !i.paymentProcessingAt)
      .map(i => ({ ...i })),
  claimBalanceReminder: async (id: number, expected: number, data: { linkExpiresAt: Date; dueDate: string }, now: Date = new Date()) => {
    const invoice = kit.invoices.get(id);
    if (!invoice || invoice.status !== "sent" || invoice.reminderCount !== expected || invoice.paymentProcessingAt) return false;
    Object.assign(invoice, { reminderCount: expected + 1, lastReminderAt: now, ...data });
    return true;
  },
  claimBalanceReminderExhaustedAlert: async () => false,
  listInvoiceCheckoutSessionsSince: async () => kit.sessionLog.map(r => ({ ...r })),
  listStuckProcessingInvoices: async (before: Date) =>
    Array.from(kit.invoices.values())
      .filter(i => i.paymentProcessingAt && i.paymentProcessingAt <= before && !settled(i))
      .map(i => ({
        invoiceId: i.id,
        invoiceNumber: i.number,
        paymentProcessingAt: i.paymentProcessingAt,
        paymentProcessingIntentId: i.paymentProcessingIntentId,
      })),
  getInvoicePaymentRecords: async (ids: number[]) => ({
    invoices: ids.flatMap(id => {
      const i = kit.invoices.get(id);
      return i
        ? [{ id: i.id, number: i.number, status: i.status, stripePaymentIntentId: i.stripePaymentIntentId, paymentProcessingIntentId: i.paymentProcessingIntentId }]
        : [];
    }),
    payments: kit.payments
      .filter(p => p.invoiceId != null && ids.includes(p.invoiceId) && p.stripePaymentIntentId)
      .map(p => ({ invoiceId: p.invoiceId, stripePaymentIntentId: p.stripePaymentIntentId, status: p.status, duplicate: p.duplicate })),
  }),
  // Quiet no-ops for the best-effort side paths (tip ask, email log).
  claimBookingCompletedBySettlement: async () => false,
  recordEmailAttemptReturningId: async () => 1,
};

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

type FakeSession = {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  payment_intent: string | null;
  expires_at: number;
  created: number;
  amount_total: number;
  metadata: Record<string, string>;
  client_reference_id: string | null;
};
type FakeIntent = {
  id: string;
  object: "payment_intent";
  status: string;
  metadata: Record<string, string>;
  refunded?: boolean;
  /** The instrument on the charge, as Stripe names it ("card", "us_bank_account"). */
  methodType?: string;
  next_action?: { type: string } | null;
};

export const stripeKit = {
  sessions: new Map<string, FakeSession>(),
  intents: new Map<string, FakeIntent>(),
  createCalls: [] as Array<{ params: Record<string, unknown>; options?: { idempotencyKey?: string } }>,
  expireCalls: [] as string[],
  idempotency: new Map<string, { params: string; session: FakeSession }>(),
  seq: 0,
  /** Make the next N sessions.create calls fail, as a provider outage would. */
  failCreates: 0,
};

export function resetFakeStripe(): void {
  stripeKit.sessions.clear();
  stripeKit.intents.clear();
  stripeKit.createCalls = [];
  stripeKit.expireCalls = [];
  stripeKit.idempotency.clear();
  stripeKit.seq = 0;
  stripeKit.failCreates = 0;
}

function missing(kind: string, id: string): Error {
  return Object.assign(new Error(`No such ${kind}: '${id}'`), { code: "resource_missing", type: "StripeInvalidRequestError" });
}

function lineTotal(params: Record<string, unknown>): number {
  const lines = (params.line_items ?? []) as Array<{ price_data: { unit_amount: number }; quantity: number }>;
  return lines.reduce((sum, line) => sum + line.price_data.unit_amount * line.quantity, 0);
}

function intentWithCharge(intent: FakeIntent): Record<string, unknown> {
  return {
    ...intent,
    latest_charge: {
      id: `ch_${intent.id}`,
      refunded: Boolean(intent.refunded),
      amount_refunded: intent.refunded ? 1 : 0,
      payment_method_details: intent.methodType ? { type: intent.methodType } : null,
    },
  };
}

function expandIntent(session: FakeSession, expand: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...session };
  const wantIntent = expand.some(e => e === "payment_intent" || e.startsWith("data.payment_intent"));
  if (wantIntent && session.payment_intent) {
    const intent = stripeKit.intents.get(session.payment_intent);
    out.payment_intent = intent ? intentWithCharge(intent) : session.payment_intent;
  }
  return out;
}

export const fakeStripe = {
  checkout: {
    sessions: {
      create: async (params: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        stripeKit.createCalls.push({ params, options });
        if (stripeKit.failCreates > 0) {
          stripeKit.failCreates -= 1;
          throw Object.assign(new Error("Stripe is down"), { type: "StripeAPIError" });
        }
        const key = options?.idempotencyKey;
        const signature = JSON.stringify(params);
        if (key) {
          const prior = stripeKit.idempotency.get(key);
          if (prior) {
            if (prior.params !== signature) {
              throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), {
                type: "StripeIdempotencyError",
              });
            }
            return { ...prior.session };
          }
        }
        stripeKit.seq += 1;
        const id = `cs_test_${stripeKit.seq}`;
        const session: FakeSession = {
          id,
          object: "checkout.session",
          url: `https://checkout.stripe.test/${id}`,
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          expires_at: Number(params.expires_at),
          created: Math.floor(Date.now() / 1000),
          amount_total: lineTotal(params),
          metadata: (params.metadata ?? {}) as Record<string, string>,
          client_reference_id: (params.client_reference_id as string) ?? null,
        };
        stripeKit.sessions.set(id, session);
        if (key) stripeKit.idempotency.set(key, { params: signature, session: { ...session } });
        return { ...session };
      },
      retrieve: async (id: string, opts?: { expand?: string[] }) => {
        const session = stripeKit.sessions.get(id);
        if (!session) throw missing("checkout.session", id);
        return expandIntent(session, opts?.expand);
      },
      expire: async (id: string) => {
        stripeKit.expireCalls.push(id);
        const session = stripeKit.sessions.get(id);
        if (!session) throw missing("checkout.session", id);
        if (session.status !== "open") throw Object.assign(new Error("Only open sessions can be expired"), { type: "StripeInvalidRequestError" });
        session.status = "expired";
        session.url = null;
        return { ...session };
      },
      list: (params: { created?: { gte?: number }; expand?: string[] }) => {
        const rows = Array.from(stripeKit.sessions.values())
          .filter(s => s.created >= (params.created?.gte ?? 0))
          .map(s => expandIntent(s, params.expand));
        return {
          async *[Symbol.asyncIterator]() {
            for (const row of rows) yield row;
          },
        };
      },
    },
  },
  paymentIntents: {
    retrieve: async (id: string) => {
      const intent = stripeKit.intents.get(id);
      if (!intent) throw missing("payment_intent", id);
      return intentWithCharge(intent);
    },
  },
  webhooks: {
    constructEvent: (body: Buffer | string) => JSON.parse(body.toString()),
  },
};

/**
 * The customer completes checkout on a session: a card pays at once, a bank
 * (ACH) debit starts processing, and an ACH customer who typed their account
 * in by hand ("ach_microdeposits") first has to confirm two microdeposits.
 */
export function customerPays(sessionId: string, method: "card" | "ach" | "ach_microdeposits", intentId: string): void {
  const session = stripeKit.sessions.get(sessionId);
  if (!session || session.status !== "open") throw new Error(`session ${sessionId} is not payable`);
  session.status = "complete";
  session.url = null;
  session.payment_intent = intentId;
  session.payment_status = method === "card" ? "paid" : "unpaid";
  stripeKit.intents.set(intentId, {
    id: intentId,
    object: "payment_intent",
    status: method === "card" ? "succeeded" : method === "ach" ? "processing" : "requires_action",
    metadata: { payment_type: "balance", invoice_id: session.metadata.invoice_id ?? "" },
    methodType: method === "card" ? "card" : "us_bank_account",
    next_action: method === "ach_microdeposits" ? { type: "verify_with_microdeposits" } : null,
  });
}

/** The bank answers: the debit clears, or it fails (returned, insufficient funds). */
export function bankSettles(intentId: string, outcome: "succeeded" | "failed"): void {
  const intent = stripeKit.intents.get(intentId);
  if (!intent) throw new Error(`no intent ${intentId}`);
  intent.status = outcome === "succeeded" ? "succeeded" : "requires_payment_method";
  intent.next_action = null;
  if (outcome === "succeeded") {
    for (const session of Array.from(stripeKit.sessions.values())) {
      if (session.payment_intent === intentId) session.payment_status = "paid";
    }
  }
}

/** A webhook event for a session, as Stripe would send it (payment_intent as an id). */
export function sessionEvent(type: string, sessionId: string, eventId = `evt_${type}_${sessionId}`): string {
  const session = stripeKit.sessions.get(sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  return JSON.stringify({ id: eventId, type, data: { object: { ...session } } });
}

/** A webhook event for a PaymentIntent. */
export function intentEvent(type: string, intentId: string, eventId = `evt_${type}_${intentId}`): string {
  const intent = stripeKit.intents.get(intentId);
  if (!intent) throw new Error(`no intent ${intentId}`);
  return JSON.stringify({ id: eventId, type, data: { object: { ...intent } } });
}
