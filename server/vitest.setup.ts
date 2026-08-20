/**
 * Global test-environment guard. Runs once per test file, before any of it.
 *
 * Several modules read deployment environment variables directly —
 * publicOrigin() reads PUBLIC_BASE_URL, emails.ts reads GMAIL_USER /
 * OWNER_EMAIL, db.ts reads DATABASE_URL. Tests that exercise the
 * *unconfigured* fallback are silently testing something else whenever the
 * shell happens to have those set, which is exactly what happens in the deploy
 * environment: the suite passed locally and failed there.
 *
 * Clearing them here makes the suite depend on nothing but itself. A test that
 * needs one of these set must say so with vi.stubEnv, which is self-documenting
 * and undone automatically.
 *
 * DATABASE_URL is on the list for a second reason: with it set, getDb() would
 * open a real connection for any code path a test forgot to mock. Tests must
 * never be able to reach a real database.
 */

/** Deployment-supplied variables that must never leak into a test run. */
export const GUARDED_ENV_KEYS = [
  "PUBLIC_BASE_URL",
  "BRAIN_READ_TOKEN",
  "DATABASE_URL",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "OWNER_EMAIL",
  "OWNER_OPEN_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

for (const key of GUARDED_ENV_KEYS) {
  delete process.env[key];
}
