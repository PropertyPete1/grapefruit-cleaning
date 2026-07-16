import { TRPCError } from "@trpc/server";
import type { TrpcContext } from "./_core/context";

/**
 * Lightweight in-memory anti-spam utilities for public endpoints.
 * No CAPTCHA — a honeypot field, a minimum-fill-time check, and per-IP
 * rate limiting cover the vast majority of automated form spam.
 *
 * NOTE: in-memory state resets on each deploy/cold start, which is fine —
 * this is a best-effort nuisance filter, not a security boundary.
 */

// ---------- Per-IP rate limiting ----------

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export function clientIp(ctx: TrpcContext): string {
  const req = ctx.req;
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0]!.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Throws TOO_MANY_REQUESTS when `ip` exceeds `limit` calls to `scope`
 * within `windowMs`. Defaults: 5 requests per minute.
 */
export function assertRateLimit(scope: string, ip: string, limit = 5, windowMs = 60_000): void {
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, b] of Array.from(buckets.entries())) {
        if (now - b.windowStart >= windowMs) buckets.delete(k);
        if (buckets.size < MAX_BUCKETS / 2) break;
      }
    }
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please wait a moment and try again.",
    });
  }
}

/** Test-only helper. */
export function _resetRateLimits(): void {
  buckets.clear();
}

// ---------- Honeypot + minimum fill time ----------

export type SpamSignals = {
  /** Honeypot field — humans never see it, bots often fill it. */
  website?: string;
  /** Epoch ms when the form was first rendered. */
  formRenderedAt?: number;
};

const MIN_FILL_MS = 3_000;

/**
 * Returns true when the submission looks like a bot (honeypot filled or the
 * form was submitted implausibly fast). Callers should reject SILENTLY —
 * return a success response without persisting — so bots learn nothing.
 */
export function looksLikeSpam(signals: SpamSignals): boolean {
  if (signals.website && signals.website.trim().length > 0) return true;
  if (
    typeof signals.formRenderedAt === "number" &&
    Number.isFinite(signals.formRenderedAt) &&
    signals.formRenderedAt > 0
  ) {
    const elapsed = Date.now() - signals.formRenderedAt;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return true;
  }
  return false;
}
