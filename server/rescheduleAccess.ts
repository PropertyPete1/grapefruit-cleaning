import { createHash, randomBytes } from "node:crypto";
import * as db from "./db";
import { publicOrigin } from "./publicOrigin";

const TOKEN_BYTES = 32;
const TOKEN_LIFETIME_DAYS = 400;

export type RescheduleLocale = "en" | "es";

export function hashRescheduleToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function rescheduleRequestPath(locale: RescheduleLocale, token: string): string {
  return locale === "es" ? `/es/reprogramar/${token}` : `/en/reschedule/${token}`;
}

/**
 * Rotates the customer access credential and returns the one-time raw URL.
 * Only its SHA-256 hash is persisted; an old email link stops working after a
 * new reschedule or counter email is issued.
 */
export async function mintBookingRescheduleUrl(args: {
  bookingId: number;
  locale: RescheduleLocale;
  origin?: string;
  now?: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const now = args.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_DAYS * 86_400_000);
  await db.setBookingRescheduleToken(args.bookingId, hashRescheduleToken(token), expiresAt);
  const origin = (args.origin ?? publicOrigin()).replace(/\/+$/, "");
  return { url: `${origin}${rescheduleRequestPath(args.locale, token)}`, expiresAt };
}

export async function getBookingRescheduleAccess(token: string, now: Date = new Date()) {
  if (!/^[a-f0-9]{64}$/i.test(token)) return undefined;
  const row = await db.getBookingByRescheduleTokenHash(hashRescheduleToken(token));
  if (!row) return undefined;
  if (!row.booking.rescheduleTokenExpiresAt || row.booking.rescheduleTokenExpiresAt.getTime() <= now.getTime()) {
    return undefined;
  }
  if (row.booking.status !== "confirmed") return undefined;
  return row;
}
