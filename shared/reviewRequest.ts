/**
 * The review request — "how did we do?" the day after a completed and paid
 * cleaning — and the two small settings around it: the Google review link
 * the email points at, and the tap-to-text line offered in the booking flow.
 *
 * Pure helpers, shared so Admin → Settings validates the link the same way
 * the sweep reads it, and the booking page builds the same sms: link the
 * tests check.
 */

/** Admin → Settings: where the review email sends people. Blank = the site's own testimonials page. */
export const REVIEW_URL_SETTING_KEY = "google_review_url";
/** Admin → Settings: the number customers can text from the booking flow. Blank = no link. */
export const TEXT_NUMBER_SETTING_KEY = "text_number";
/** Admin → Settings: whose number it is ("Karyme"). Blank = a generic "text us". */
export const TEXT_NAME_SETTING_KEY = "text_name";

/** email_log type for the review request, so its volume reads apart from the thank-you and the nudges. */
export const REVIEW_REQUEST_EMAIL_TYPE = "review_request";

/**
 * Hours after settlement before the ask goes out. The tip thank-you lands the
 * moment a job settles; this one follows on the next daily beat rather than
 * arriving in the same minute.
 */
export const REVIEW_REQUEST_DELAY_HOURS = 20;

/**
 * A cleaning settled longer ago than this is left alone. The sweep is for
 * recent jobs — never a backfill that would email every customer in the
 * history the day this ships.
 */
export const REVIEW_REQUEST_WINDOW_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;

/** The configured review link, or null when blank or not a web address. */
export function normalizeReviewUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return reviewUrlProblem(trimmed) ? null : trimmed;
}

/** Why a value cannot be saved as the review link, or null when it can (blank is allowed — it clears the link). */
export function reviewUrlProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) return "The review link is too long (500 characters max).";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter the full review link, starting with https://";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The review link must start with https://";
  }
  return null;
}

/**
 * The sms: link for a configured number, or null when there is nothing to
 * text. Ten digits are a US number and get +1; eleven starting with 1 already
 * carry it; anything shorter than seven digits is not a phone number.
 */
export function smsHref(number: string | null | undefined): string | null {
  const digits = (number ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (digits.length === 10) return `sms:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `sms:+${digits}`;
  return `sms:${(number ?? "").trim().startsWith("+") ? "+" : ""}${digits}`;
}

export type ReviewDueState = "not_settled" | "too_soon" | "too_old" | "due";

/**
 * Where a settled job sits relative to the review window. `settledAt` is the
 * moment the customer owed nothing — the paid invoice's paidAt, or for a job
 * the deposit covered outright, the completion thank-you's timestamp.
 */
export function reviewRequestDue(settledAt: Date | null | undefined, now: Date): ReviewDueState {
  if (!settledAt) return "not_settled";
  const ageMs = now.getTime() - settledAt.getTime();
  if (ageMs < REVIEW_REQUEST_DELAY_HOURS * HOUR_MS) return "too_soon";
  if (ageMs > REVIEW_REQUEST_WINDOW_DAYS * 24 * HOUR_MS) return "too_old";
  return "due";
}
