import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetTransporter, smtpDiagnostics, verifySmtpTransport } from "./emails";
import { LIVE_SMTP_KEYS } from "./vitest.setup";

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
  it.runIf(process.env.RUN_LIVE_SMTP_VERIFY === "1")(
    "authenticates the securely supplied SMTP credential without exposing it",
    async () => {
      const live = {
        host: process.env[LIVE_SMTP_KEYS.host],
        port: process.env[LIVE_SMTP_KEYS.port],
        user: process.env[LIVE_SMTP_KEYS.user],
        password: process.env[LIVE_SMTP_KEYS.password],
      };
      expect(live.host).toBeTruthy();
      expect(live.port).toBeTruthy();
      expect(live.user).toBeTruthy();
      expect(live.password).toBeTruthy();
      Object.assign(process.env, {
        SMTP_HOST: live.host,
        SMTP_PORT: live.port,
        SMTP_USER: live.user,
        SMTP_PASSWORD: live.password,
      });
      try {
        __resetTransporter();
        const result = await verifySmtpTransport();
        expect(result.ok, result.error ?? "SMTP verify failed").toBe(true);
        expect(result.diagnostics.effective.user).toBe("grapefruitcleaningc@gmail.com");
        expect(JSON.stringify(result)).not.toContain(live.password);
      } finally {
        for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]) delete process.env[key];
        __resetTransporter();
      }
    },
    20_000
  );

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
