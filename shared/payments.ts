export const OFFLINE_PAYMENT_METHODS = ["cash", "venmo", "zelle", "check", "other"] as const;

export type OfflinePaymentMethod = (typeof OFFLINE_PAYMENT_METHODS)[number];
