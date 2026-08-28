import { afterEach, describe, expect, it, vi } from "vitest";
import { smtpDiagnostics } from "./emails";

const ENV_NAMES = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
] as const;

afterEach(() => {
  for (const name of ENV_NAMES) vi.unstubAllEnvs();
});

describe("production-safe SMTP diagnostics", () => {
  it("reports the exact effective Gmail fallback without exposing the password", () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASSWORD", "");
    vi.stubEnv("GMAIL_USER", "grapefruitcleaningc@gmail.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "sixteencharsdemo");

    const result = smtpDiagnostics();

    expect(result.env).toEqual({
      SMTP_HOST: null,
      SMTP_PORT: null,
      SMTP_USER: null,
      GMAIL_USER: "grapefruitcleaningc@gmail.com",
      passwordSource: "GMAIL_APP_PASSWORD",
      passwordMasked: "************",
    });
    expect(result.effective).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: "grapefruitcleaningc@gmail.com",
    });
    expect(JSON.stringify(result)).not.toContain("sixteencharsdemo");
  });

  it("honors generic SMTP variables ahead of legacy Gmail variables", () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_USER", "smtp-user@example.com");
    vi.stubEnv("SMTP_PASSWORD", "private-password");
    vi.stubEnv("GMAIL_USER", "legacy@gmail.com");
    vi.stubEnv("GMAIL_APP_PASSWORD", "legacy-password");

    const result = smtpDiagnostics();

    expect(result.effective).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "smtp-user@example.com",
    });
    expect(result.env.passwordSource).toBe("SMTP_PASSWORD");
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(JSON.stringify(result)).not.toContain("legacy-password");
  });
});
