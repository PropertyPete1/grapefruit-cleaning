/**
 * How a customer said they intend to pay.
 *
 * "online" is the card path — the deposit at booking and the balance link
 * after the cleaning. "cash" is the customer telling us up front: no deposit
 * is taken, the booking confirms on the spot, and the job carries "cash
 * pending" until the owner taps Paid in Cash. A preference is a statement,
 * not a lock; the online link keeps working for anyone who changes their mind.
 */
export const PAYMENT_PREFERENCES = ["online", "cash"] as const;

export type PaymentPreference = (typeof PAYMENT_PREFERENCES)[number];

export function isCashPreference(preference: string | null | undefined): boolean {
  return preference === "cash";
}
