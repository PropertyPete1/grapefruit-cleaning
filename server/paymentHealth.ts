/**
 * The daily payments integrity check — the part of the health check that
 * would have caught the ACH double charge.
 *
 * Read-only, like everything in ownerDigest.ts: it reports to the owner and
 * never changes an invoice or a payment. It deliberately does NOT trust the
 * app's own ledger alone. Neither of the two ACH debits behind that incident
 * produced a payments row — the webhook never recorded them — so a check over
 * the database would have reported a clean bill of health. Stripe's own record
 * of the invoice's Checkout Sessions is read and held up against the app's:
 *
 *   - duplicatePayments: more than one Stripe payment that went through (or is
 *     going through) for one invoice, refunded ones excluded;
 *   - overlappingCheckoutSessions: a session minted while another was still
 *     payable — from the app's session history, and any invoice Stripe shows
 *     with two sessions open right now;
 *   - unrecordedStripePayments: Stripe has the customer's money (or has it in
 *     flight) but the invoice still reads unpaid — the customer is being
 *     reminded to pay something they paid;
 *   - bankAnswersNotRecorded: Stripe has the bank's answer (succeeded or
 *     failed) for a payment the invoice still calls processing — the webhook
 *     is not receiving the async events;
 *   - stuckPaymentProcessing: a bank payment "processing" longer than any bank
 *     takes.
 */
import type Stripe from "stripe";
import { BALANCE_PAYMENT_TYPE } from "./balanceRules";
import * as db from "./db";
import { getStripe } from "./stripe";

/** How far back Stripe's sessions are read. ACH settles within days; a month covers any duplicate still worth refunding. */
export const PAYMENT_HEALTH_WINDOW_DAYS = 30;
/**
 * Longer than any bank takes: up to 10 days of microdeposit verification plus
 * about 4 business days of settlement — which can run past 14 calendar days
 * over a weekend, so the line sits well beyond it.
 */
export const STUCK_PROCESSING_DAYS = 20;
/** Overlaps are reported once: only for sessions minted since about the previous daily run. */
const OVERLAP_REPORT_WINDOW_MS = 26 * 60 * 60 * 1000;
/** A payment this fresh may simply be ahead of its webhook. */
const WEBHOOK_GRACE_MS = 60 * 60 * 1000;
/**
 * How long an invoice must have been waiting before a Stripe answer it was
 * never told about is reported. The answer's own time is not on the session,
 * and Stripe retries a failed delivery for hours, so a day is the honest line.
 */
const ANSWER_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_STRIPE_SESSIONS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StripePaymentHealthState = "succeeded" | "processing";
type StripeSessionPaymentState = StripePaymentHealthState | "failed";

export interface PaymentIntegrityFindings {
  duplicatePayments: Array<{
    invoiceId: number;
    invoiceNumber: string;
    payments: Array<{ intentId: string; state: StripePaymentHealthState }>;
  }>;
  overlappingCheckoutSessions: Array<{
    invoiceId: number;
    invoiceNumber: string;
    firstSessionId: string;
    secondSessionId: string;
    detail: string;
  }>;
  unrecordedStripePayments: Array<{
    invoiceId: number;
    invoiceNumber: string;
    intentId: string;
    state: StripePaymentHealthState;
  }>;
  bankAnswersNotRecorded: Array<{
    invoiceId: number;
    invoiceNumber: string;
    intentId: string;
    stripeState: "succeeded" | "failed";
  }>;
  stuckPaymentProcessing: Array<{
    invoiceNumber: string;
    intentId: string | null;
    since: string;
    days: number;
  }>;
  /** Why Stripe's side could not be read (or was read only in part); null when it was read in full or is not configured. */
  paymentInspectionError: string | null;
}

export const EMPTY_PAYMENT_FINDINGS: PaymentIntegrityFindings = {
  duplicatePayments: [],
  overlappingCheckoutSessions: [],
  unrecordedStripePayments: [],
  bankAnswersNotRecorded: [],
  stuckPaymentProcessing: [],
  paymentInspectionError: null,
};

type SessionHistoryRow = {
  invoiceId: number;
  invoiceNumber: string | null;
  stripeSessionId: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason?: string | null;
};

const ms = (value: Date | string) => new Date(value).getTime();

/**
 * Sessions from the app's own history whose payable window opened while an
 * earlier session for the same invoice was still payable — still unexpired
 * and not yet seen to end. The one-live-session rule makes this impossible;
 * finding one means a race or a code path got around it.
 *
 * A "superseded" session never counts: it was closed by the request that
 * minted it, before its url reached anyone. `reportSince` limits the report
 * to sessions minted since then (the daily run passes about a day), so one
 * overlap is reported once rather than every day for a month.
 */
export function findOverlappingSessions(
  rows: SessionHistoryRow[],
  reportSince?: Date
): PaymentIntegrityFindings["overlappingCheckoutSessions"] {
  const byInvoice = new Map<number, SessionHistoryRow[]>();
  for (const row of rows) {
    const list = byInvoice.get(row.invoiceId) ?? [];
    list.push(row);
    byInvoice.set(row.invoiceId, list);
  }
  const found: PaymentIntegrityFindings["overlappingCheckoutSessions"] = [];
  byInvoice.forEach(all => {
    const list = all.filter(row => row.endReason !== "superseded").sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    for (let j = 1; j < list.length; j += 1) {
      const later = list[j]!;
      const opened = ms(later.createdAt);
      if (reportSince && opened < reportSince.getTime()) continue;
      const live = list
        .slice(0, j)
        .find(earlier => opened < ms(earlier.expiresAt) && (earlier.endedAt == null || ms(earlier.endedAt) > opened));
      if (live) {
        found.push({
          invoiceId: later.invoiceId,
          invoiceNumber: later.invoiceNumber ?? `#${later.invoiceId}`,
          firstSessionId: live.stripeSessionId,
          secondSessionId: later.stripeSessionId,
          detail: `minted ${new Date(opened).toISOString()} while the earlier session was payable until ${new Date(ms(live.expiresAt)).toISOString()}`,
        });
      }
    }
  });
  return found;
}

/**
 * Where a session's payment stands, from its expanded intent and charge. A
 * fully refunded payment counts for nothing — once the owner refunds a
 * duplicate, it stops being reported.
 */
export function sessionPaymentState(
  session: Pick<Stripe.Checkout.Session, "status" | "payment_intent">
): { intentId: string; state: StripeSessionPaymentState } | null {
  const intent = session.payment_intent;
  if (!intent || typeof intent === "string") return null;
  if (intent.status === "succeeded") {
    const charge = intent.latest_charge;
    // Fully refunded: no money held. A partial refund still holds money.
    if (charge && typeof charge === "object" && charge.refunded) return null;
    return { intentId: intent.id, state: "succeeded" };
  }
  if (session.status !== "complete") return null;
  if (intent.status === "processing" || intent.status === "requires_action") return { intentId: intent.id, state: "processing" };
  if (intent.status === "requires_payment_method" || intent.status === "canceled") return { intentId: intent.id, state: "failed" };
  return null;
}

type StripeInvoiceView = {
  invoiceNumber: string | null;
  payments: Map<string, { state: StripeSessionPaymentState; createdMs: number }>;
  openSessionIds: string[];
};

async function readStripeInvoiceSessions(now: Date): Promise<{ invoices: Map<number, StripeInvoiceView>; capped: boolean }> {
  const since = Math.floor((now.getTime() - PAYMENT_HEALTH_WINDOW_DAYS * DAY_MS) / 1000);
  const invoices = new Map<number, StripeInvoiceView>();
  let seen = 0;
  let capped = false;
  const list = getStripe().checkout.sessions.list({
    created: { gte: since },
    limit: 100,
    expand: ["data.payment_intent.latest_charge"],
  });
  for await (const session of list) {
    seen += 1;
    if (seen > MAX_STRIPE_SESSIONS) {
      capped = true;
      break;
    }
    if (session.metadata?.payment_type !== BALANCE_PAYMENT_TYPE) continue;
    const invoiceId = Number(session.metadata?.invoice_id ?? session.client_reference_id);
    if (!invoiceId) continue;
    const view: StripeInvoiceView = invoices.get(invoiceId) ?? {
      invoiceNumber: session.metadata?.invoice_number ?? null,
      payments: new Map(),
      openSessionIds: [],
    };
    if (session.status === "open" && session.expires_at * 1000 > now.getTime()) view.openSessionIds.push(session.id);
    const payment = sessionPaymentState(session);
    if (payment) view.payments.set(payment.intentId, { state: payment.state, createdMs: session.created * 1000 });
    invoices.set(invoiceId, view);
  }
  return { invoices, capped };
}

function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** The whole payments check. Never throws: a failure to read Stripe is itself a finding. */
export async function inspectPaymentIntegrity(now: Date = new Date()): Promise<PaymentIntegrityFindings> {
  const findings: PaymentIntegrityFindings = {
    duplicatePayments: [],
    overlappingCheckoutSessions: [],
    unrecordedStripePayments: [],
    bankAnswersNotRecorded: [],
    stuckPaymentProcessing: [],
    paymentInspectionError: null,
  };
  const errors: string[] = [];

  try {
    const [history, stuck] = await Promise.all([
      db.listInvoiceCheckoutSessionsSince(new Date(now.getTime() - PAYMENT_HEALTH_WINDOW_DAYS * DAY_MS)),
      db.listStuckProcessingInvoices(new Date(now.getTime() - STUCK_PROCESSING_DAYS * DAY_MS)),
    ]);
    findings.overlappingCheckoutSessions.push(
      ...findOverlappingSessions(history, new Date(now.getTime() - OVERLAP_REPORT_WINDOW_MS))
    );
    findings.stuckPaymentProcessing = stuck.map(row => ({
      invoiceNumber: row.invoiceNumber,
      intentId: row.paymentProcessingIntentId,
      since: row.paymentProcessingAt ? new Date(row.paymentProcessingAt).toISOString().slice(0, 10) : "unknown",
      days: row.paymentProcessingAt ? Math.floor((now.getTime() - ms(row.paymentProcessingAt)) / DAY_MS) : 0,
    }));
  } catch (error) {
    errors.push(`session history: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (stripeConfigured()) {
    try {
      const { invoices, capped } = await readStripeInvoiceSessions(now);
      if (capped) errors.push(`only the newest ${MAX_STRIPE_SESSIONS} Stripe sessions were checked`);
      const records = await db.getInvoicePaymentRecords(Array.from(invoices.keys()));
      const invoiceById = new Map(records.invoices.map(row => [row.id, row]));
      const recordedIntents = new Set(
        records.payments.flatMap((row): string[] =>
          row.stripePaymentIntentId ? [`${row.invoiceId}:${row.stripePaymentIntentId}`] : []
        )
      );

      invoices.forEach((view, invoiceId) => {
        const invoice = invoiceById.get(invoiceId);
        const invoiceNumber = invoice?.number ?? view.invoiceNumber ?? `#${invoiceId}`;
        const all = Array.from(view.payments.entries()).map(([intentId, p]) => ({ intentId, ...p }));
        // Money taken or in flight; a failed payment took nothing.
        const payments = all.flatMap(p => (p.state === "failed" ? [] : [{ ...p, state: p.state as StripePaymentHealthState }]));

        // The invoice still waits on a payment Stripe has already answered for.
        const waitingOn = invoice?.paymentProcessingIntentId;
        const answer = waitingOn ? all.find(p => p.intentId === waitingOn) : undefined;
        const waitingSince = invoice?.paymentProcessingAt ? new Date(invoice.paymentProcessingAt).getTime() : now.getTime();
        if (answer && answer.state !== "processing" && now.getTime() - waitingSince >= ANSWER_GRACE_MS) {
          findings.bankAnswersNotRecorded.push({ invoiceId, invoiceNumber, intentId: answer.intentId, stripeState: answer.state });
        }

        if (payments.length >= 2) {
          findings.duplicatePayments.push({
            invoiceId,
            invoiceNumber,
            payments: payments.map(({ intentId, state }) => ({ intentId, state })),
          });
        }
        if (view.openSessionIds.length >= 2) {
          findings.overlappingCheckoutSessions.push({
            invoiceId,
            invoiceNumber,
            firstSessionId: view.openSessionIds[0]!,
            secondSessionId: view.openSessionIds[1]!,
            detail: `${view.openSessionIds.length} checkout sessions are open at once on Stripe`,
          });
        }
        // Money Stripe holds (or is moving) that the invoice does not know
        // about, while the invoice still reads unpaid. A paid invoice was
        // reconciled by someone; an unpaid one is being chased.
        if (invoice && invoice.status !== "paid" && invoice.status !== "void") {
          for (const payment of payments) {
            if (now.getTime() - payment.createdMs < WEBHOOK_GRACE_MS) continue;
            const known =
              invoice.stripePaymentIntentId === payment.intentId ||
              invoice.paymentProcessingIntentId === payment.intentId ||
              recordedIntents.has(`${invoiceId}:${payment.intentId}`);
            if (!known) {
              findings.unrecordedStripePayments.push({ invoiceId, invoiceNumber, intentId: payment.intentId, state: payment.state });
            }
          }
        }
      });
    } catch (error) {
      errors.push(`Stripe: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  findings.paymentInspectionError = errors.length > 0 ? errors.join("; ") : null;
  return findings;
}

/** Problem count for the payments findings — every entry needs a human, and so does a check that could not run. */
export function paymentProblemCount(f: PaymentIntegrityFindings): number {
  return (
    f.duplicatePayments.length +
    f.overlappingCheckoutSessions.length +
    f.unrecordedStripePayments.length +
    (f.bankAnswersNotRecorded?.length ?? 0) +
    f.stuckPaymentProcessing.length +
    (f.paymentInspectionError ? 1 : 0)
  );
}

/** The payments section, as plain text for the daily alert and the weekly digest. Empty when there is nothing to say. */
export function formatPaymentFindings(f: PaymentIntegrityFindings): string[] {
  const lines: string[] = [];
  if (f.duplicatePayments.length > 0) {
    lines.push(`MORE THAN ONE STRIPE PAYMENT ON ONE INVOICE (${f.duplicatePayments.length})`);
    lines.push("The customer paid twice. Keep the payment that settled the invoice and refund the other in Stripe:");
    for (const d of f.duplicatePayments) {
      lines.push(`  • ${d.invoiceNumber} — ${d.payments.map(p => `${p.intentId} (${p.state})`).join(", ")}`);
    }
    lines.push("");
  }
  if (f.unrecordedStripePayments.length > 0) {
    lines.push(`STRIPE PAYMENTS THE APP NEVER RECORDED (${f.unrecordedStripePayments.length})`);
    lines.push("Stripe has this money (or is moving it), but the invoice still reads unpaid — the customer may be getting");
    lines.push("reminders for a bill they paid. Do NOT record these by hand: a hand-recorded payment turns the real Stripe");
    lines.push("payment into a 'refund' duplicate when its event arrives.");
    for (const u of f.unrecordedStripePayments) {
      lines.push(
        u.state === "succeeded"
          ? `  • ${u.invoiceNumber} — ${u.intentId} (succeeded): press "Check with Stripe" on the invoice in Admin → Invoices — it records this payment and sends nothing.`
          : `  • ${u.invoiceNumber} — ${u.intentId} (still processing): press "Check with Stripe" once — it marks the invoice processing and stops the reminders; the payment records itself when the bank answers.`
      );
    }
    lines.push("");
  }
  if ((f.bankAnswersNotRecorded?.length ?? 0) > 0) {
    lines.push(`BANK PAYMENTS STRIPE HAS ANSWERED BUT THE APP WAS NEVER TOLD (${f.bankAnswersNotRecorded.length})`);
    lines.push("For over a day the webhook has not delivered checkout.session.async_payment_succeeded / async_payment_failed");
    lines.push("for these — check the endpoint's subscription and delivery log in the Stripe Dashboard. Meanwhile press");
    lines.push('"Check with Stripe" on each invoice: it records the payment, or reopens a failed one and emails the customer:');
    for (const b of f.bankAnswersNotRecorded) {
      lines.push(`  • ${b.invoiceNumber} — ${b.intentId} ${b.stripeState} on Stripe; the invoice still says processing`);
    }
    lines.push("");
  }
  if (f.overlappingCheckoutSessions.length > 0) {
    lines.push(`CHECKOUT SESSIONS PAYABLE AT THE SAME TIME (${f.overlappingCheckoutSessions.length})`);
    lines.push("A second payment page was opened while another was still payable — the double-charge pattern:");
    for (const o of f.overlappingCheckoutSessions) {
      lines.push(`  • ${o.invoiceNumber} — ${o.firstSessionId} and ${o.secondSessionId}: ${o.detail}`);
    }
    lines.push("");
  }
  if (f.stuckPaymentProcessing.length > 0) {
    lines.push(`BANK PAYMENTS PROCESSING FOR OVER ${STUCK_PROCESSING_DAYS} DAYS (${f.stuckPaymentProcessing.length})`);
    lines.push("No bank takes this long. Check each payment in Stripe — if it settled or failed there, the webhook is");
    lines.push('not receiving checkout.session.async_payment_succeeded / async_payment_failed (press "Check with Stripe" to sync it):');
    for (const s of f.stuckPaymentProcessing) {
      lines.push(`  • ${s.invoiceNumber} — ${s.intentId ?? "(no payment id)"} — processing since ${s.since} (${s.days} days)`);
    }
    lines.push("");
  }
  if (f.paymentInspectionError) {
    lines.push("PAYMENTS CHECK COULD NOT RUN IN FULL");
    lines.push(`Duplicate and unrecorded payments may be missing from this report: ${f.paymentInspectionError}`);
    lines.push("");
  }
  return lines;
}
