import type { Stripe } from "stripe";

/**
 * The payment methods a deposit or tip Checkout Session may offer: card only.
 * Apple Pay and Google Pay are card wallets on Checkout and stay available.
 *
 * Without an explicit list Checkout offers whatever the Stripe Dashboard
 * enables — ACH included. A bank debit completes Checkout with
 * payment_status "unpaid" and settles days later, and neither path is built
 * for that: they act only on "paid" and track no payment in flight. An ACH
 * deposit left its booking pending_deposit with the link still payable, so a
 * retry was a second debit; an ACH tip was never recorded at all.
 *
 * Restricting the methods at the session is what makes "complete" mean "paid"
 * on these surfaces again. Spread it into each call (`[...LIST]`): Stripe's
 * parameter type is a mutable array, and this list must never be mutated.
 *
 * Balance invoices do not use it — a whole job balance is where a bank
 * transfer earns its keep, so that surface is meant to handle delayed
 * payments rather than refuse them.
 */
export const IMMEDIATE_PAYMENT_METHOD_TYPES = [
  "card",
] as const satisfies readonly Stripe.Checkout.SessionCreateParams.PaymentMethodType[];
