import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";

/**
 * Live credential check: verifies the Gmail SMTP login (GMAIL_USER +
 * GMAIL_APP_PASSWORD) actually authenticates against smtp.gmail.com.
 * Skipped when credentials are not configured (e.g. CI without secrets).
 */
describe("gmail smtp credentials", () => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  it.skipIf(!user || !pass)(
    "authenticates against smtp.gmail.com",
    async () => {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
      });
      await expect(transporter.verify()).resolves.toBe(true);
    },
    30_000
  );
});
