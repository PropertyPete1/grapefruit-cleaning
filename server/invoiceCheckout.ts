/**
 * One live Stripe Checkout Session per invoice.
 *
 * The emailed pay link (/api/pay/balance/:token) outlives any single Stripe
 * session, so it used to mint a fresh one on every visit. That is how a
 * customer paying by bank was charged twice: ACH completes as "unpaid" and
 * stays that way for days, the invoice still read unpaid, and the retry got a
 * second, fully payable checkout. Every way into checkout for an invoice now
 * goes through openInvoiceCheckout, which decides from Stripe's own record of
 * the invoice's current session, never from the invoice status alone:
 *
 *   - session still open (and not about to lapse) → reopen THAT session's url;
 *   - session complete and paid → the payment happened; settle and say so;
 *   - session complete and unpaid → a bank payment is processing; refuse;
 *   - session expired, or its payment failed → mint the replacement.
 *
 * Minting is claimed first (db.claimInvoiceCheckoutAttempt — a conditional
 * UPDATE on the attempt count), so two visits racing cannot both create a
 * session, and the claimed attempt number rides in the Stripe idempotency key
 * so Stripe would refuse a second session for the same attempt as well.
 *
 * Settling and failing live in balance.ts; they arrive here as hooks so this
 * module stays free of the email and ledger machinery (and of an import cycle).
 */
import type Stripe from "stripe";
import type { Invoice } from "../drizzle/schema";
import { STRIPE_SESSION_MAX_SECONDS } from "./balanceRules";
import * as db from "./db";
import { getStripe } from "./stripe";

/**
 * A live session is reopened only while it has at least this long left. A bank
 * login inside Checkout takes minutes; a session about to lapse is closed and
 * replaced instead, closed FIRST so the two are never payable at once.
 */
export const CHECKOUT_REUSE_MARGIN_MS = 10 * 60 * 1000;

/** A claimed attempt with no session after this long was abandoned (its request died); the next visit may claim anew. */
export const CHECKOUT_CLAIM_LEASE_MS = 60 * 1000;

/** How long a visit that lost the mint race waits for the winner's session before showing "try again". */
const CHECKOUT_BUSY_WAIT_MS = 4000;
const CHECKOUT_BUSY_POLL_MS = 250;
const MAX_ROUNDS = 24;

/**
 * Stripe idempotency key for one minting attempt. Derived from the invoice —
 * its id, plus its unique random-suffixed number so two databases sharing a
 * Stripe account can never collide — and the claimed attempt, because a key
 * from the invoice alone would make Stripe replay a dead session (or refuse
 * the changed expires_at) for 24 hours. No customer data: Stripe asks for none.
 */
export function checkoutIdempotencyKey(invoice: Pick<Invoice, "id" | "number">, attempt: number): string {
  return `gf-invoice-${invoice.id}-${invoice.number}-checkout-${attempt}`;
}

export type PaymentIntentState = "succeeded" | "processing" | "failed" | "unknown";

/**
 * A PaymentIntent's status, as this app cares about it. "requires_action" is
 * processing too: an ACH customer verifying by microdeposits sits there for up
 * to ten days, and a second checkout in that window is a second debit.
 */
export function paymentIntentState(status: string | null | undefined): PaymentIntentState {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "processing":
    case "requires_action":
    case "requires_confirmation":
    case "requires_capture":
      return "processing";
    case "requires_payment_method":
    case "canceled":
      return "failed";
    default:
      return "unknown";
  }
}

export type SessionView =
  | { kind: "open"; url: string | null; expiresAtMs: number; amountTotal: number | null }
  | { kind: "paid"; paymentIntentId: string | null }
  | { kind: "processing"; paymentIntentId: string | null }
  | { kind: "failed"; paymentIntentId: string | null }
  | { kind: "expired" }
  | { kind: "unknown" };

function intentIdOf(session: Pick<Stripe.Checkout.Session, "payment_intent">): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

/**
 * What a Checkout Session means for its invoice. A complete session is "paid"
 * only on Stripe's word; complete-and-unpaid is processing unless its intent
 * has visibly failed — an unreadable intent counts as processing, because the
 * safe mistake is refusing a checkout, never minting a second debit.
 */
export function classifySession(
  session: Pick<Stripe.Checkout.Session, "status" | "payment_status" | "payment_intent" | "url" | "expires_at" | "amount_total">
): SessionView {
  if (session.status === "open") {
    return { kind: "open", url: session.url, expiresAtMs: session.expires_at * 1000, amountTotal: session.amount_total ?? null };
  }
  if (session.status === "expired") return { kind: "expired" };
  if (session.status !== "complete") return { kind: "unknown" };
  const paymentIntentId = intentIdOf(session);
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    return { kind: "paid", paymentIntentId };
  }
  const intentStatus = typeof session.payment_intent === "object" && session.payment_intent ? session.payment_intent.status : null;
  const state = paymentIntentState(intentStatus);
  if (state === "succeeded") return { kind: "paid", paymentIntentId };
  if (state === "failed") return { kind: "failed", paymentIntentId };
  return { kind: "processing", paymentIntentId };
}

export type CheckoutResolution =
  /** Send the customer here: the invoice's live session, reopened or just minted. */
  | { kind: "redirect"; url: string; sessionId: string; reused: boolean }
  /** A bank payment is in flight — no new checkout. */
  | { kind: "processing"; paymentIntentId: string | null }
  /** The invoice is paid (or its session just was) — nothing to open. */
  | { kind: "paid" }
  /** The invoice is void — nothing to open. */
  | { kind: "closed" }
  /** Another visit is minting this invoice's session right now and did not finish in time. */
  | { kind: "busy" }
  /** Inspect-only: no live session and none was minted. */
  | { kind: "none" };

export interface CheckoutHooks {
  /** Creates the Stripe session for a claimed attempt. Must pass `idempotencyKey` and `expiresAt` through to Stripe. */
  mint(args: { invoice: Invoice; attempt: number; expiresAt: Date; idempotencyKey: string }): Promise<Stripe.Checkout.Session>;
  /** Stripe shows the payment succeeded (the webhook may not have landed yet): settle, idempotently. */
  onPaymentSucceeded(invoiceId: number, paymentIntentId: string | null): Promise<unknown>;
  /** The processing payment failed (the webhook may not have landed yet): clear the state, idempotently. */
  onPaymentFailed(invoiceId: number, paymentIntentId: string): Promise<unknown>;
}

export interface OpenCheckoutOptions {
  /**
   * False for a look that must never create anything — the customer landing
   * back from Stripe. The live session is still reported, and a payment
   * Stripe has settled is still recorded.
   */
  mint?: boolean;
  /**
   * The amount the session must charge. A live session for any other amount
   * (an approval retried with a corrected total) is closed and replaced,
   * never reopened. Defaults to the invoice row's own amount.
   */
  expectedAmountCents?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** The session with its intent expanded, or null when Stripe has no such session. */
async function retrieveSession(sessionId: string): Promise<Stripe.Checkout.Session | null> {
  try {
    return await getStripe().checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  } catch (error) {
    if (errorCode(error) === "resource_missing") return null;
    throw error;
  }
}

/** Where a processing payment stands now. A Stripe hiccup reads "unknown", which callers treat as still processing. */
async function readIntentState(paymentIntentId: string): Promise<PaymentIntentState> {
  try {
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
    return paymentIntentState(intent.status);
  } catch (error) {
    console.warn(`[Checkout] Could not read payment intent ${paymentIntentId}:`, error);
    return "unknown";
  }
}

/**
 * Closes an open session. "completed" when it turned out to have completed in
 * the meantime (Stripe refuses to expire anything not open), so the caller
 * re-reads instead of minting over a payment.
 */
async function closeSession(sessionId: string): Promise<"closed" | "completed"> {
  try {
    await getStripe().checkout.sessions.expire(sessionId);
    return "closed";
  } catch (error) {
    const fresh = await retrieveSession(sessionId);
    if (!fresh || fresh.status === "expired") return "closed";
    if (fresh.status === "complete") return "completed";
    throw error;
  }
}

function amountCentsOf(invoice: Pick<Invoice, "amount" | "amountCents">): number {
  return invoice.amountCents ?? Math.round(Number(invoice.amount) * 100);
}

/**
 * Opens checkout for an invoice under the one-live-session rule. Throws only
 * for genuine provider/database failures — callers show an error page and the
 * customer tries again; nothing is ever minted blind on an unreadable state.
 */
export async function openInvoiceCheckout(
  invoiceId: number,
  hooks: CheckoutHooks,
  options: OpenCheckoutOptions = {}
): Promise<CheckoutResolution> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const mayMint = options.mint !== false;
  let waitedMs = 0;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const invoice = await db.getInvoiceById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    if (invoice.status === "paid") return { kind: "paid" };
    if (invoice.status === "void") return { kind: "closed" };

    // A delayed payment already on file. Ask Stripe whether it has finished
    // since — the webhook may be late, or never configured — and otherwise
    // refuse: the customer has paid, the bank is moving the money.
    if (invoice.paymentProcessingIntentId) {
      const state = await readIntentState(invoice.paymentProcessingIntentId);
      if (state === "succeeded") {
        await hooks.onPaymentSucceeded(invoice.id, invoice.paymentProcessingIntentId);
        return { kind: "paid" };
      }
      if (state === "failed") {
        await hooks.onPaymentFailed(invoice.id, invoice.paymentProcessingIntentId);
        continue;
      }
      return { kind: "processing", paymentIntentId: invoice.paymentProcessingIntentId };
    }
    if (invoice.paymentProcessingAt) return { kind: "processing", paymentIntentId: null };

    const expectedCents = options.expectedAmountCents ?? amountCentsOf(invoice);

    if (invoice.stripeSessionId) {
      const session = await retrieveSession(invoice.stripeSessionId);
      if (!session) {
        // Stripe has never heard of it (a test-mode id in live, say): nothing
        // can be paid there, so it is safe to replace.
        await db.endInvoiceCheckoutSession(invoice.stripeSessionId, "expired", now());
      } else {
        const view = classifySession(session);
        if (view.kind === "open") {
          const amountMatches = view.amountTotal == null || view.amountTotal === expectedCents;
          if (view.url && amountMatches && view.expiresAtMs - now().getTime() > CHECKOUT_REUSE_MARGIN_MS) {
            return { kind: "redirect", url: view.url, sessionId: session.id, reused: true };
          }
          if (!mayMint) {
            return view.url ? { kind: "redirect", url: view.url, sessionId: session.id, reused: true } : { kind: "none" };
          }
          // About to lapse, or charging the wrong amount: close it BEFORE its
          // replacement exists, so there is never a moment with two live.
          if ((await closeSession(session.id)) === "completed") continue;
          await db.endInvoiceCheckoutSession(session.id, "closed", now());
        } else if (view.kind === "paid") {
          await hooks.onPaymentSucceeded(invoice.id, view.paymentIntentId);
          return { kind: "paid" };
        } else if (view.kind === "processing") {
          // Checkout finished with a bank payment and the webhook has not said
          // so yet: record it now, so the reminders stop and the next visit
          // takes the fast path above.
          if (view.paymentIntentId) await db.markInvoicePaymentProcessing(invoice.id, view.paymentIntentId, now());
          return { kind: "processing", paymentIntentId: view.paymentIntentId };
        } else if (view.kind === "failed") {
          await db.endInvoiceCheckoutSession(session.id, "payment_failed", now());
        } else if (view.kind === "expired") {
          await db.endInvoiceCheckoutSession(session.id, "expired", now());
        } else {
          throw new Error(`Checkout session ${session.id} is in an unreadable state (${String(session.status)})`);
        }
      }
    } else if (invoice.checkoutClaimedAt && now().getTime() - new Date(invoice.checkoutClaimedAt).getTime() < CHECKOUT_CLAIM_LEASE_MS) {
      // Another visit claimed this invoice's next session moments ago and is
      // creating it now. Wait for it rather than mint a second one.
      if (!mayMint) return { kind: "none" };
      if (waitedMs >= CHECKOUT_BUSY_WAIT_MS) return { kind: "busy" };
      await sleep(CHECKOUT_BUSY_POLL_MS);
      waitedMs += CHECKOUT_BUSY_POLL_MS;
      continue;
    }

    if (!mayMint) return { kind: "none" };

    // Mint. Claim the attempt first; losing the claim means someone else is
    // minting (or just minted) — go round and reopen theirs.
    const claimedAt = now();
    const attempt = invoice.checkoutAttempt + 1;
    if (!(await db.claimInvoiceCheckoutAttempt(invoice.id, invoice.checkoutAttempt, claimedAt))) continue;

    const expiresAt = new Date(Math.floor(claimedAt.getTime() / 1000) * 1000 + STRIPE_SESSION_MAX_SECONDS * 1000);
    let session: Stripe.Checkout.Session;
    try {
      session = await hooks.mint({ invoice, attempt, expiresAt, idempotencyKey: checkoutIdempotencyKey(invoice, attempt) });
    } catch (error) {
      // Hand the attempt back so the customer's retry is not stuck behind a
      // claim's lease. If Stripe did create a session before failing, its url
      // never reached anyone, so nobody can pay it.
      await db.releaseInvoiceCheckoutClaim(invoice.id, attempt).catch(() => undefined);
      throw error;
    }

    const sessionExpiresAt = session.expires_at ? new Date(session.expires_at * 1000) : expiresAt;
    const stored = await db.recordInvoiceCheckoutSession(invoice.id, attempt, {
      stripeSessionId: session.id,
      expiresAt: sessionExpiresAt,
      createdAt: claimedAt,
    });
    if (!stored) {
      // Our claim outlived its lease and a newer attempt took over while
      // Stripe was answering. Close ours; the newer one stands.
      await closeSession(session.id).catch(() => undefined);
      await db.endInvoiceCheckoutSession(session.id, "superseded", now());
      continue;
    }
    if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a url`);
    return { kind: "redirect", url: session.url, sessionId: session.id, reused: false };
  }
  return { kind: "busy" };
}
