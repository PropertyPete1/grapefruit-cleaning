import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";

/**
 * Live credential check: verifies the configured SMTP login actually
 * authenticates against its server, using the exact same resolution the app
 * uses — SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD, with the legacy
 * GMAIL_USER/GMAIL_APP_PASSWORD names as fallbacks (host then defaults to
 * Gmail). Skipped when credentials are not configured (e.g. CI without
 * secrets). NOTE: vitest.setup.ts clears these vars for the unit suite; this
 * check is for running by hand against real deployment values.
 */
describe("smtp credentials", () => {
  const user = process.env.SMTP_USER || process.env.GMAIL_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD;
  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT) || (host === "smtp.gmail.com" ? 465 : 587);

  it.skipIf(!user || !pass)(
    `authenticates against ${host}:${port}`,
    async () => {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await expect(transporter.verify()).resolves.toBe(true);
    },
    30_000
  );
});
