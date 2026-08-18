/**
 * The states an admin-created booking's deposit link can be in.
 *
 * In shared/ rather than beside the rules in server/depositLinkRules.ts because
 * the admin appointments table renders these labels, and the client must not
 * reach into server code to name them.
 */
export type DepositLinkStatus = "none" | "awaiting_payment" | "paid" | "expired";
