/**
 * Crew tips: the settled-booking thank-you and the /pay/tip/:token page.
 *
 * What this file pins:
 *   - the email fires once per booking (claim guard), never for a cancelled or
 *     unfinished job, and IS the thank-you — a booking gets it or the plain
 *     completion note, never both;
 *   - every dollar is computed server-side: presets from the stored total,
 *     custom amounts clamped to $1–100% of it, tampered figures neutralized;
 *   - the page opens with 15% pre-selected and offers a decline that consumes
 *     the ask without ever taking money;
 *   - a paid tip records once as a payment (kind "tip") with a cheerful owner
 *     note, however many times Stripe redelivers the event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockGetBookingById = vi.fn();
const mockGetBookingByTipToken = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetConnectedPropertyById = vi.fn();
const mockClaimTipEmail = vi.fn();
const mockClaimCompletedBySettlement = vi.fn();
const mockClaimTipPayment = vi.fn();
const mockDeclineTip = vi.fn();
const mockClaimJobCompleted = vi.fn();
const mockCreatePayment = vi.fn();
const mockSessionCreate = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  getBookingById: (...a: unknown[]) => mockGetBookingById(...a),
  getBookingByTipToken: (...a: unknown[]) => mockGetBookingByTipToken(...a),
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  getConnectedPropertyById: (...a: unknown[]) => mockGetConnectedPropertyById(...a),
  claimTipRequestEmail: (...a: unknown[]) => mockClaimTipEmail(...a),
  claimBookingCompletedBySettlement: (...a: unknown[]) => mockClaimCompletedBySettlement(...a),
  claimTipPayment: (...a: unknown[]) => mockClaimTipPayment(...a),
  declineTip: (...a: unknown[]) => mockDeclineTip(...a),
  claimJobCompletedEmail: (...a: unknown[]) => mockClaimJobCompleted(...a),
  createPayment: (...a: unknown[]) => mockCreatePayment(...a),
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockSessionCreate(...a) } } }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => mockNotifyOwner(...a),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { _resetRateLimits } from "./antiSpam";
import { __resetTransporter, buildTipRequestEmail } from "./emails";
import { tipRouter } from "./routers/tip";
import {
  applyTipPayment,
  clampTipAmount,
  sendTipRequestEmailSafely,
  tipPageState,
  tipPresetAmount,
  tipPresets,
} from "./tip";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapeclean.example";
const TOKEN = "f".repeat(48);

const BOOKING = {
  id: 42,
  reference: "GFC-TIP42",
  customerId: 7,
  serviceType: "residential" as const,
  scheduledDate: "2026-08-19",
  locale: "en" as const,
  status: "completed" as const,
  kind: "self_serve" as const,
  propertyId: null,
  totalAmount: 120,
  depositAmount: 24,
  tipToken: TOKEN,
  tipEmailSentAt: new Date(),
  tipPaidAt: null,
  tipDeclinedAt: null,
  tipAmount: null,
  tipStripePaymentIntentId: null,
};

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
};

const publicCtx = (): TrpcContext => ({
  user: null,
  req: { protocol: "https", headers: { origin: ORIGIN } } as unknown as TrpcContext["req"],
  res: {} as TrpcContext["res"],
});

const caller = () => tipRouter.createCaller(publicCtx());

const sentEmails = () =>
  mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string; html?: string });

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  __resetTransporter();
  vi.stubEnv("PUBLIC_BASE_URL", "");
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  mockGetSetting.mockResolvedValue(null);
  mockGetBookingById.mockResolvedValue(BOOKING);
  mockGetBookingByTipToken.mockResolvedValue(BOOKING);
  mockGetCustomerById.mockResolvedValue(CUSTOMER);
  mockGetConnectedPropertyById.mockResolvedValue(undefined);
  mockClaimTipEmail.mockResolvedValue(true);
  // Default: nothing to complete. Tests that settle an open booking say so.
  mockClaimCompletedBySettlement.mockResolvedValue(false);
  mockClaimTipPayment.mockResolvedValue(true);
  mockDeclineTip.mockResolvedValue(true);
  mockClaimJobCompleted.mockResolvedValue(true);
  mockSessionCreate.mockResolvedValue({ id: "cs_tip_1", url: "https://stripe.test/tip" });
  mockSendMail.mockResolvedValue({ messageId: "1" });
  mockNotifyOwner.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The arithmetic.
// ---------------------------------------------------------------------------

describe("tip amounts are server arithmetic", () => {
  it("presets are whole dollars of the job total", () => {
    expect(tipPresetAmount(120, 15)).toBe(18);
    expect(tipPresetAmount(120, 20)).toBe(24);
    expect(tipPresetAmount(120, 25)).toBe(30);
    // Rounding, not truncation: 15% of $130 is $19.50 → $20.
    expect(tipPresetAmount(130, 15)).toBe(20);
    expect(tipPresets(120)).toEqual([
      { percent: 15, amount: 18 },
      { percent: 20, amount: 24 },
      { percent: 25, amount: 30 },
    ]);
  });

  it("even a tiny job's preset never falls below $1", () => {
    expect(tipPresetAmount(3, 15)).toBe(1);
  });

  it("custom amounts clamp to $1–100% of the job total", () => {
    expect(clampTipAmount(25, 120)).toBe(25);
    expect(clampTipAmount(0.4, 120)).toBe(1);
    expect(clampTipAmount(999999, 120)).toBe(120);
    expect(clampTipAmount(3.7, 120)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The email.
// ---------------------------------------------------------------------------

describe("the tip-request thank-you", () => {
  it("goes out once for a settled completed booking, presets and review ask aboard", async () => {
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockClaimTipEmail).toHaveBeenCalledWith(42, TOKEN);
    const [email] = sentEmails();
    expect(email!.to).toBe("ana@example.com");
    expect(email!.subject).toContain("thank you");
    // The three preset dollar figures, computed from the $120 total.
    for (const amount of ["$18 USD", "$24 USD", "$30 USD"]) {
      expect(email!.html).toContain(amount);
    }
    expect(email!.html).toContain(`/pay/tip/${TOKEN}`);
    expect(email!.html).toContain(`${ORIGIN}/en/testimonials`);
  });

  it("mints a fresh token when the booking has none yet", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, tipToken: null });
    await sendTipRequestEmailSafely(42, ORIGIN);
    const [, token] = mockClaimTipEmail.mock.calls[0]!;
    expect(String(token)).toMatch(/^[0-9a-f]{48}$/);
    expect(sentEmails()[0]!.html).toContain(`/pay/tip/${token}`);
  });

  it("never sends twice — the claim decides", async () => {
    mockClaimTipEmail.mockResolvedValue(false);
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("never tips a cancelled booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "cancelled" });
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockClaimTipEmail).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  /**
   * Regression: booking GFC-WH33YS, invoice INV-MT0LDYJ6-7D0D.
   *
   * An admin-created booking was invoiced and paid ($170, stripe) while its
   * status still read `confirmed`, because nobody flipped it in Admin →
   * Appointments first. The old gate — `if (status !== "completed") return` —
   * swallowed the tip ask in silence: no email, no log line, no email_log row.
   * A paid balance is proof the job happened, so settlement now records the
   * completion and carries on to the thank-you.
   */
  it("completes a still-confirmed booking whose balance just settled, then tips", async () => {
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      // Daniel's exact shape: admin-created, still confirmed, never thanked.
      id: 150001,
      reference: "GFC-WH33YS",
      status: "confirmed",
      kind: "admin",
      totalAmount: 170,
      tipToken: null,
      tipEmailSentAt: null,
    });
    mockClaimCompletedBySettlement.mockResolvedValue(true);

    await sendTipRequestEmailSafely(150001, ORIGIN);

    expect(mockClaimCompletedBySettlement).toHaveBeenCalledWith(150001);
    expect(mockClaimTipEmail).toHaveBeenCalled();
    // 15/20/25% of $170, the figures Daniel should have been offered.
    const [email] = sentEmails();
    for (const amount of ["$26 USD", "$34 USD", "$43 USD"]) {
      expect(email!.html).toContain(amount);
    }
  });

  it("tips an in-progress booking whose balance settled", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "in_progress" });
    mockClaimCompletedBySettlement.mockResolvedValue(true);
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("stays silent when the completion claim is lost to a concurrent settle", async () => {
    // A cancelled row, or one another handler completed and thanked a moment
    // earlier: either way the claim reports no change and nothing is sent.
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "confirmed" });
    mockClaimCompletedBySettlement.mockResolvedValue(false);
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockClaimTipEmail).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("leaves an already-completed booking's status alone", async () => {
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockClaimCompletedBySettlement).not.toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("stays quiet for auto-booked turnovers unless the host asked for per-clean notices", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, kind: "ical_auto", propertyId: 5 });
    mockGetConnectedPropertyById.mockResolvedValue({ id: 5, perCleanEmails: false });
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockSendMail).not.toHaveBeenCalled();

    mockGetConnectedPropertyById.mockResolvedValue({ id: 5, perCleanEmails: true });
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockSendMail).toHaveBeenCalled();
  });

  it("falls back to the plain thank-you when there is no total to tip on", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, totalAmount: 0 });
    await sendTipRequestEmailSafely(42, ORIGIN);
    expect(mockClaimTipEmail).not.toHaveBeenCalled();
    expect(mockClaimJobCompleted).toHaveBeenCalledWith(42);
    expect(sentEmails()[0]!.subject).toContain("thank you");
    expect(sentEmails()[0]!.html).not.toContain("/pay/tip/");
  });

  it("falls back to the plain thank-you when no public origin is known — never a relative tip link", async () => {
    await sendTipRequestEmailSafely(42, "");
    expect(mockClaimTipEmail).not.toHaveBeenCalled();
    expect(mockClaimJobCompleted).toHaveBeenCalledWith(42);
    expect(sentEmails()[0]!.html).not.toContain("/pay/tip/");
  });

  it("renders in genuine Spanish for a Spanish booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, locale: "es" });
    await sendTipRequestEmailSafely(42, ORIGIN);
    const [email] = sentEmails();
    expect(email!.subject).toContain("Su limpieza está completa");
    expect(email!.html).toContain("propina");
    expect(email!.html).toContain("/es/testimonios");
  });

  it("a mail failure never throws out of the safely wrapper", async () => {
    mockSendMail.mockRejectedValue(new Error("SMTP refused"));
    await expect(sendTipRequestEmailSafely(42, ORIGIN)).resolves.toBeUndefined();
    // Claim-first, like every once-per-booking email: a bounced send is a lost
    // email, not a future double-send.
    expect(mockClaimTipEmail).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

describe("the tip page state and payload", () => {
  it("serves the open state with server-computed presets", async () => {
    const result = await caller().get({ token: TOKEN });
    expect(result.state).toBe("open");
    expect(result.booking).toMatchObject({
      reference: "GFC-TIP42",
      customerFirstName: "Ana",
      total: 120,
      presets: [
        { percent: 15, amount: 18 },
        { percent: 20, amount: 24 },
        { percent: 25, amount: 30 },
      ],
    });
  });

  it("says thanks instead of asking again once paid or declined", async () => {
    mockGetBookingByTipToken.mockResolvedValue({ ...BOOKING, tipPaidAt: new Date() });
    expect((await caller().get({ token: TOKEN })).state).toBe("paid");
    mockGetBookingByTipToken.mockResolvedValue({ ...BOOKING, tipDeclinedAt: new Date() });
    expect((await caller().get({ token: TOKEN })).state).toBe("declined");
  });

  it("a cancelled booking's link reads as not found", async () => {
    mockGetBookingByTipToken.mockResolvedValue({ ...BOOKING, status: "cancelled" });
    expect((await caller().get({ token: TOKEN })).state).toBe("notFound");
  });

  it("paid outranks declined when both somehow landed", () => {
    expect(tipPageState({ tipPaidAt: new Date(), tipDeclinedAt: new Date() })).toBe("paid");
  });
});

describe("minting the tip session", () => {
  it("prices a preset server-side and tags the session as a tip", async () => {
    const result = await caller().createSession({ token: TOKEN, preset: 20 });
    expect(result.amount).toBe(24);
    const session = mockSessionCreate.mock.calls[0]![0] as Record<string, never>;
    expect(session["line_items"]![0]!["price_data"]!["unit_amount"]).toBe(2400);
    expect(session["metadata"]).toMatchObject({
      payment_type: "tip",
      booking_id: "42",
      tip_amount: "24",
    });
    expect(String(session["success_url"])).toContain(`/pay/tip/${TOKEN}?paid=1`);
  });

  it("clamps a custom amount and rejects tampering above the job total", async () => {
    const modest = await caller().createSession({ token: TOKEN, customAmount: 22 });
    expect(modest.amount).toBe(22);
    // A crafted request cannot charge more than the job itself…
    const greedy = await caller().createSession({ token: TOKEN, customAmount: 999999 });
    expect(greedy.amount).toBe(120);
    // …or less than a dollar, and non-positive figures fail validation outright.
    await expect(caller().createSession({ token: TOKEN, customAmount: 0 })).rejects.toThrow();
    await expect(caller().createSession({ token: TOKEN, customAmount: -5 })).rejects.toThrow();
  });

  it("refuses a preset percentage that is not on the menu", async () => {
    await expect(
      caller().createSession({ token: TOKEN, preset: 99 as never })
    ).rejects.toThrow();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("requires exactly one of preset and custom amount", async () => {
    await expect(caller().createSession({ token: TOKEN })).rejects.toThrow();
    await expect(
      caller().createSession({ token: TOKEN, preset: 15, customAmount: 10 })
    ).rejects.toThrow();
  });

  it("refuses once the tip is settled either way", async () => {
    mockGetBookingByTipToken.mockResolvedValue({ ...BOOKING, tipPaidAt: new Date() });
    await expect(caller().createSession({ token: TOKEN, preset: 15 })).rejects.toThrow(/already/i);
    mockGetBookingByTipToken.mockResolvedValue({ ...BOOKING, tipDeclinedAt: new Date() });
    await expect(caller().createSession({ token: TOKEN, preset: 15 })).rejects.toThrow(/already/i);
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });
});

describe("declining", () => {
  it("consumes the ask without a cent moving", async () => {
    await expect(caller().decline({ token: TOKEN })).resolves.toEqual({ declined: true });
    expect(mockDeclineTip).toHaveBeenCalledWith(42);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it("declining twice stays graceful — the row simply keeps its first answer", async () => {
    mockDeclineTip.mockResolvedValue(false);
    await expect(caller().decline({ token: TOKEN })).resolves.toEqual({ declined: true });
  });
});

// ---------------------------------------------------------------------------
// The payment landing.
// ---------------------------------------------------------------------------

describe("applying a tip payment", () => {
  it("records the payment as kind tip and cheers the owner, once", async () => {
    const result = await applyTipPayment(42, 24, "pi_tip_1");
    expect(result.outcome).toBe("paid");
    expect(mockClaimTipPayment).toHaveBeenCalledWith(42, {
      amount: 24,
      stripePaymentIntentId: "pi_tip_1",
    });
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 42, amount: 24, kind: "tip", status: "succeeded" })
    );
    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Tip received — $24") })
    );
  });

  it("a redelivered event is a no-op — no second payment, no second cheer", async () => {
    mockClaimTipPayment.mockResolvedValue(false);
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      tipPaidAt: new Date(),
      tipStripePaymentIntentId: "pi_tip_1",
    });
    const result = await applyTipPayment(42, 24, "pi_tip_1");
    expect(result.outcome).toBe("duplicate");
    expect(mockCreatePayment).not.toHaveBeenCalled();
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("a genuinely different second payment is still put on the books", async () => {
    mockClaimTipPayment.mockResolvedValue(false);
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      tipPaidAt: new Date(),
      tipStripePaymentIntentId: "pi_tip_1",
    });
    const result = await applyTipPayment(42, 24, "pi_tip_2");
    expect(result.outcome).toBe("duplicate");
    expect(mockCreatePayment).toHaveBeenCalledTimes(1);
    expect(mockCreatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tip", stripePaymentIntentId: "pi_tip_2" })
    );
  });
});

// ---------------------------------------------------------------------------
// Wiring pinned at the source level.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the wiring around the tip flow", () => {
  it("the webhook routes tip sessions to applyTipPayment", () => {
    const source = read("./stripeWebhook.ts");
    expect(source).toContain("TIP_PAYMENT_TYPE");
    expect(source).toContain("applyTipPayment");
  });

  it("the tip page route exists and opens on the 15% preset with a decline offered", () => {
    const app = read("../client/src/App.tsx");
    expect(app).toContain('path="/pay/tip/:token"');
    const page = read("../client/src/pages/PayTip.tsx");
    // Default pre-selection: no hint (or a bad hint) lands on 15.
    expect(page).toMatch(/return pct === 20 \|\| pct === 25 \? pct : 15;/);
    expect(page).toContain('"No tip — just say thanks"');
    expect(page).toContain("Sin propina — solo dar las gracias");
  });

  it("the email's buttons carry preset hints the page reads, never amounts", () => {
    const email = buildTipRequestEmail({
      reference: "GFC-TIP42",
      serviceName: "Residential Cleaning",
      date: "2026-08-19",
      customerName: "Ana",
      customerEmail: "ana@example.com",
      locale: "en",
      total: 120,
      presets: tipPresets(120),
      tipUrl: `${ORIGIN}/pay/tip/${TOKEN}`,
      reviewUrl: `${ORIGIN}/en/testimonials`,
    });
    expect(email.html).toContain(`/pay/tip/${TOKEN}?p=15`);
    expect(email.html).toContain(`/pay/tip/${TOKEN}?p=20`);
    expect(email.html).toContain(`/pay/tip/${TOKEN}?p=25`);
    expect(email.html).toContain(`/pay/tip/${TOKEN}?p=custom`);
    // The URLs carry no dollar figures a customer could edit into a price.
    expect(email.html).not.toMatch(/\?p=\d+&amount/);
  });
});
