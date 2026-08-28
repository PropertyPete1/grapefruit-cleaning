import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();
const mockLogEmailAttempt = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: (...args: unknown[]) => mockSendMail(...args),
    }),
  },
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...args: unknown[]) => mockNotifyOwner(...args),
}));

vi.mock("./emailLog", () => ({
  logEmailAttempt: (...args: unknown[]) => mockLogEmailAttempt(...args),
}));

import { __resetTransporter, sendDepositLinkEmail, sendOwnerAlert } from "./emails";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SMTP_HOST", "smtp.gmail.com");
  vi.stubEnv("SMTP_PORT", "465");
  vi.stubEnv("SMTP_USER", "grapefruitcleaningc@gmail.com");
  vi.stubEnv("SMTP_PASSWORD", "app-password");
  vi.stubEnv("OWNER_EMAIL", "grapefruitcleaningc@gmail.com");
  mockSendMail.mockResolvedValue({ messageId: "smtp-message" });
  mockNotifyOwner.mockResolvedValue(undefined);
  mockLogEmailAttempt.mockResolvedValue(undefined);
  __resetTransporter();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

describe("critical email incident repairs", () => {
  it("records the known booking ID on a deposit-link delivery", async () => {
    await sendDepositLinkEmail(
      {
        reference: "GFC-TEST01",
        customerName: "Carolina",
        customerEmail: "carolina@example.com",
        basePrice: 80,
        deposit: 16,
        payUrl: "https://grapeclean.com/pay/deposit/token",
        expiresOn: "2026-08-29",
        locale: "en",
      },
      { bookingId: 180002 }
    );

    expect(mockLogEmailAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: "carolina@example.com",
        emailType: "deposit_link",
        outcome: "delivered",
        smtpUser: "grapefruitcleaningc@gmail.com",
        bookingId: 180002,
      })
    );
  });

  it("reports an owner alert delivered when either independent channel accepts it", async () => {
    mockSendMail.mockRejectedValue(new Error("smtp unavailable"));
    const result = await sendOwnerAlert("Test alert", "Something needs attention");
    expect(result).toEqual({
      delivered: true,
      platformDelivered: true,
      emailDelivered: false,
      emailRecipient: "grapefruitcleaningc@gmail.com",
    });
  });

  it("reports an owner alert undelivered when both channels fail", async () => {
    mockNotifyOwner.mockRejectedValue(new Error("notification unavailable"));
    mockSendMail.mockRejectedValue(new Error("smtp unavailable"));
    const result = await sendOwnerAlert("Test alert", "Something needs attention");
    expect(result).toEqual({
      delivered: false,
      platformDelivered: false,
      emailDelivered: false,
      emailRecipient: "grapefruitcleaningc@gmail.com",
    });
  });
});
