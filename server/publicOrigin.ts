/**
 * The site's public origin for a request.
 *
 * Everything customer- and crawler-facing is built from this: the URLs in
 * sitemap.xml and robots.txt, and the Stripe return URLs on balance payment
 * links. Behind the Manus proxy the raw request cannot supply it — req.protocol
 * is "http" and req.headers.host is the internal Cloud Run hostname — so a URL
 * built from those points somewhere the public internet cannot reach.
 *
 * Resolution order, most trustworthy first:
 *  1. PUBLIC_BASE_URL — explicit configuration, always wins. Set this in the
 *     deployment environment and none of the guesswork below is needed.
 *  2. X-Forwarded-Host / X-Forwarded-Proto — what the edge says the client
 *     actually asked for. X-Forwarded-Proto is already trusted for the session
 *     cookie's Secure flag (see _core/cookies.ts).
 *  3. The request's own Origin header. Browsers send it on the tRPC calls that
 *     create a booking, but NOT on plain link navigations or crawler fetches —
 *     which is exactly when step 4 gets it wrong.
 *  4. req.protocol + Host, which is right in local development.
 *
 * Kept free of Express, DB and Stripe imports so it stays unit-testable, in the
 * same spirit as bookingRules.ts and balanceRules.ts.
 */

/** Just the parts of an Express request this needs; also satisfied by test doubles. */
export interface OriginRequest {
  protocol?: string;
  headers?: Record<string, unknown>;
}

/** First value of a header that may arrive as a string or a string[]. */
function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  // Proxy chains comma-join; the client-facing entry is the first one.
  const first = value.split(",")[0]!.trim();
  return first.length > 0 ? first : undefined;
}

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * Absolute origin ("https://example.com", no trailing slash) to build public
 * links from. Returns "" only when nothing at all is available — internal
 * callers with no request and no PUBLIC_BASE_URL configured.
 */
export function publicOrigin(req?: OriginRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return stripTrailingSlashes(configured);

  const headers = req?.headers ?? {};
  const forwardedProto = headerValue(headers, "x-forwarded-proto");
  const forwardedHost = headerValue(headers, "x-forwarded-host");
  if (forwardedHost) return stripTrailingSlashes(`${forwardedProto ?? "https"}://${forwardedHost}`);

  const origin = headerValue(headers, "origin");
  if (origin) return stripTrailingSlashes(origin);

  const host = headerValue(headers, "host");
  if (host) return stripTrailingSlashes(`${forwardedProto ?? req?.protocol ?? "https"}://${host}`);

  return "";
}
