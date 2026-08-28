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

/**
 * Captured before the deletion below. See LIVE_BRAIN_TOKEN_KEY at the foot of
 * this file for why this one value survives.
 */
const capturedBrainToken = process.env.BRAIN_READ_TOKEN;
const capturedLiveSmtp = {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  password: process.env.SMTP_PASSWORD,
};

for (const key of GUARDED_ENV_KEYS) {
  delete process.env[key];
}

/**
 * One deliberate carve-out, taken BEFORE the deletion above: the live
 * credential check (brainToken.live.test.ts) has to see the real
 * BRAIN_READ_TOKEN, since its entire purpose is proving the saved secret
 * actually authenticates. Stashing it under a name no application module reads
 * keeps the guard intact — application code still finds BRAIN_READ_TOKEN
 * absent, so no test can accidentally authenticate against a real credential
 * it did not ask for.
 */
export const LIVE_BRAIN_TOKEN_KEY = "__LIVE_BRAIN_READ_TOKEN__";
export const LIVE_SMTP_KEYS = {
  host: "__LIVE_SMTP_HOST__",
  port: "__LIVE_SMTP_PORT__",
  user: "__LIVE_SMTP_USER__",
  password: "__LIVE_SMTP_PASSWORD__",
} as const;

if (capturedBrainToken) {
  process.env[LIVE_BRAIN_TOKEN_KEY] = capturedBrainToken;
}

if (capturedLiveSmtp.host) process.env[LIVE_SMTP_KEYS.host] = capturedLiveSmtp.host;
if (capturedLiveSmtp.port) process.env[LIVE_SMTP_KEYS.port] = capturedLiveSmtp.port;
if (capturedLiveSmtp.user) process.env[LIVE_SMTP_KEYS.user] = capturedLiveSmtp.user;
if (capturedLiveSmtp.password) process.env[LIVE_SMTP_KEYS.password] = capturedLiveSmtp.password;
