/**
 * Customer job-status emails: "we've started" and, for a job with nothing left
 * to collect, "we're done, thank you".
 *
 * Two properties matter more than the wording. Each email is once per booking —
 * a dashboard status flipped back and forth must not email the customer over
 * and over — and neither one can fail a status change. The crew tapping Start
 * job cannot be blocked by a mail server.
 *
 * The third thing pinned here is who does *not* get an email: a balance-due job
 * already learns it is finished from the approved-balance message, so it gets
 * nothing extra on completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBookingById = vi.fn();
const mockGetCustomerById = vi.fn();
const mockGetSetting = vi.fn();
const mockUpdateBooking = vi.fn();
const mockClaimStarted = vi.fn();
const mockClaimCompleted = vi.fn();
const mockClaimTip = vi.fn();
const mockCreateInvoice = vi.fn();
const mockGetBalanceInvoiceForBooking = vi.fn();
const mockSendMail = vi.fn();
const mockNotifyOwner = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomerById(...args),
  updateBooking: (...args: unknown[]) => mockUpdateBooking(...args),
  claimJobStartedEmail: (...args: unknown[]) => mockClaimStarted(...args),
  claimJobCompletedEmail: (...args: unknown[]) => mockClaimCompleted(...args),
  claimTipRequestEmail: (...args: unknown[]) => mockClaimTip(...args),
  getConnectedPropertyById: vi.fn().mockResolvedValue(undefined),
  createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
  getBalanceInvoiceForBooking: (...args: unknown[]) => mockGetBalanceInvoiceForBooking(...args),
  getInvoiceById: vi.fn().mockResolvedValue(undefined),
  updateInvoice: vi.fn(),
  createPayment: vi.fn(),
  isSlotTakenError: () => false,
}));

vi.mock("./stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: vi.fn(), expire: vi.fn() } } }),
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...args: unknown[]) => mockNotifyOwner(...args),
}));

// The real builders and deliverEmail run; only SMTP is faked.
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => mockSendMail(...args) }) },
}));

import { issueBalanceSafely } from "./balance";
import { __resetTransporter, buildJobCompleteEmail, buildJobStartedEmail } from "./emails";
import { adminRouter } from "./routers/admin";
import { staffRouter } from "./routers/staff";
import { reviewFormUrl, sendJobStartedEmailSafely } from "./statusEmails";
import type { TrpcContext } from "./_core/context";

const ORIGIN = "https://grapefruitclean.com";

const BOOKING = {
  id: 42,
  reference: "GFC-JOB42",
  customerId: 7,
  serviceType: "residential" as const,
  frequency: "onetime" as const,
  scheduledDate: "2026-08-19",
  scheduledTime: "10:00",
  locale: "en" as const,
  status: "in_progress" as const,
  totalAmount: 250,
  depositAmount: 50,
  addressLine: "123 Main St",
  city: "San Antonio",
  zip: "78201",
  extras: "[]",
  couponCode: null,
  stripePaymentIntentId: "pi_deposit_1",
};

const CUSTOMER = {
  id: 7,
  firstName: "Ana",
  lastName: "Lopez",
  email: "ana@example.com",
  phone: "2105550000",
  preferredLocale: "en" as const,
};

/** Messages actually handed to SMTP, oldest first. */
function sentEmails(): { to: string; subject: string; text: string; html: string }[] {
  return mockSendMail.mock.calls.map(c => c[0] as { to: string; subject: string; text: string; html: string });
}

const staffCaller = () =>
  staffRouter.createCaller({
    user: { id: 2, role: "staff" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as unknown as TrpcContext);

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as unknown as TrpcContext);

beforeEach(() => {
  // Emails only reach SMTP when credentials exist; without these the suite
  // would be asserting against the log-only fallback.
  vi.stubEnv("GMAIL_USER", "hello@grapefruitclean.com");
  vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
  __resetTransporter();
  mockSendMail.mockReset().mockResolvedValue({ messageId: "1" });
  mockNotifyOwner.mockReset().mockResolvedValue(undefined);
  mockGetSetting.mockReset().mockResolvedValue(null);
  mockUpdateBooking.mockReset().mockResolvedValue(undefined);
  mockGetCustomerById.mockReset().mockResolvedValue(CUSTOMER);
  mockCreateInvoice.mockReset().mockResolvedValue(501);
  mockGetBalanceInvoiceForBooking.mockReset().mockResolvedValue(undefined);
  // Default: this caller wins the claim. Repeat-send tests override it.
  mockClaimStarted.mockReset().mockResolvedValue(true);
  mockClaimCompleted.mockReset().mockResolvedValue(true);
  mockClaimTip.mockReset().mockResolvedValue(true);
  // The booking as it stands *before* the status change under test.
  mockGetBookingById.mockReset().mockResolvedValue({ ...BOOKING, status: "confirmed" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetTransporter();
});

describe("the job-started email fires on confirmed → in progress", () => {
  it("goes out when staff tap Start job", async () => {
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    const [email] = sentEmails();
    expect(email!.to).toBe("ana@example.com");
    expect(email!.subject).toContain("started your cleaning");
    expect(email!.subject).toContain("GFC-JOB42");
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "in_progress" });
  });

  it("goes out when an admin makes the same move", async () => {
    await adminCaller().updateBookingStatus({ id: 42, status: "in_progress" });
    expect(sentEmails()).toHaveLength(1);
    expect(sentEmails()[0]!.subject).toContain("started your cleaning");
  });

  it("stays quiet on a repeat, because the claim is what decides", async () => {
    // First move claims the email; the row now records it as sent.
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    expect(sentEmails()).toHaveLength(1);

    // Flip back to confirmed and start again — a correction, not a second
    // cleaning. The claim fails and nothing is sent.
    mockClaimStarted.mockResolvedValue(false);
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    await adminCaller().updateBookingStatus({ id: 42, status: "in_progress" });
    expect(sentEmails()).toHaveLength(1);
  });

  it("claims before sending, so a bounced send can never be retried into a second email", async () => {
    mockSendMail.mockRejectedValue(new Error("SMTP refused"));
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    expect(mockClaimStarted).toHaveBeenCalledWith(42);
    expect(mockClaimStarted.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSendMail.mock.invocationCallOrder[0]!
    );
  });

  it("does not fire for any other status change", async () => {
    for (const status of ["completed", "cancelled", "confirmed", "expired"] as const) {
      mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "confirmed" });
      await adminCaller().updateBookingStatus({ id: 42, status });
    }
    expect(sentEmails().some(e => e.subject.includes("started your cleaning"))).toBe(false);
  });

  it("does not fire when the job was never confirmed in the first place", async () => {
    // pending_deposit → in_progress is an admin correcting the record, not a
    // crew arriving at a booking the customer knows about.
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "pending_deposit" });
    await adminCaller().updateBookingStatus({ id: 42, status: "in_progress" });
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockClaimStarted).not.toHaveBeenCalled();
  });

  it("carries the business phone from settings when one is configured", async () => {
    mockGetSetting.mockResolvedValue(" (210) 555-0123 ");
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    expect(sentEmails()[0]!.text).toContain("(210) 555-0123");
  });

  it("writes in the language stored on the booking", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "confirmed", locale: "es" });
    await staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" });
    expect(sentEmails()[0]!.subject).toContain("Comenzamos su limpieza");
    expect(sentEmails()[0]!.html).toContain("¡Comenzamos su limpieza!");
  });
});

describe("an email failure never fails the status change", () => {
  it("survives SMTP refusing the message", async () => {
    mockSendMail.mockRejectedValue(new Error("SMTP refused"));
    await expect(
      staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" })
    ).resolves.toEqual({ success: true });
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "in_progress" });
  });

  it("survives the claim itself blowing up", async () => {
    mockClaimStarted.mockRejectedValue(new Error("database unavailable"));
    await expect(
      adminCaller().updateBookingStatus({ id: 42, status: "in_progress" })
    ).resolves.toEqual({ success: true });
    expect(mockUpdateBooking).toHaveBeenCalledWith(42, { status: "in_progress" });
  });

  it("survives the customer record having gone missing", async () => {
    mockGetCustomerById.mockResolvedValue(undefined);
    await expect(
      staffCaller().updateJobStatus({ bookingId: 42, status: "in_progress" })
    ).resolves.toEqual({ success: true });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("sends nothing at all for a booking that no longer exists", async () => {
    mockGetBookingById.mockResolvedValue(undefined);
    await sendJobStartedEmailSafely(42);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe("the completion email goes only to jobs with nothing left to collect", () => {
  it("thanks the customer when the deposit already covered the total", async () => {
    // Deposit equals total, so issueBalanceForCompletedBooking settles at zero.
    // The thank-you is the tip-request email now — same moment, same claim
    // discipline, with the tip ask riding in it.
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      status: "completed",
      totalAmount: 200,
      depositAmount: 200,
    });
    await issueBalanceSafely(42, ORIGIN);

    const [email] = sentEmails();
    expect(email!.to).toBe("ana@example.com");
    expect(email!.subject).toContain("complete");
    expect(email!.subject).toContain("thank you");
    expect(email!.html).toContain("/pay/tip/");
    expect(mockCreateInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 0, status: "paid" }));
  });

  it("includes the review ask, pointed at the public review form", async () => {
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      status: "completed",
      totalAmount: 200,
      depositAmount: 200,
    });
    await issueBalanceSafely(42, ORIGIN);
    expect(sentEmails()[0]!.html).toContain(`${ORIGIN}/en/testimonials`);
    expect(sentEmails()[0]!.text).toContain(`${ORIGIN}/en/testimonials`);
  });

  it("sends nothing extra when there is a balance to collect", async () => {
    // The approved-balance email is that customer's completion notice.
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "completed" });
    await issueBalanceSafely(42, ORIGIN);

    expect(mockCreateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, status: "awaiting_approval" })
    );
    expect(sentEmails().some(e => e.subject.includes("thank you"))).toBe(false);
    expect(mockClaimCompleted).not.toHaveBeenCalled();
    expect(mockClaimTip).not.toHaveBeenCalled();
  });

  it("stays quiet on a re-completion, twice over", async () => {
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      status: "completed",
      totalAmount: 200,
      depositAmount: 200,
    });
    await issueBalanceSafely(42, ORIGIN);
    expect(sentEmails()).toHaveLength(1);

    // The invoice already exists, so nothing is re-issued; and even if it were,
    // the claim would refuse.
    mockGetBalanceInvoiceForBooking.mockResolvedValue({ id: 501, amount: 0 });
    mockClaimTip.mockResolvedValue(false);
    await issueBalanceSafely(42, ORIGIN);
    expect(sentEmails()).toHaveLength(1);
  });

  it("goes out in Spanish for a Spanish booking", async () => {
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      status: "completed",
      locale: "es",
      totalAmount: 200,
      depositAmount: 200,
    });
    await issueBalanceSafely(42, ORIGIN);
    expect(sentEmails()[0]!.subject).toContain("Su limpieza está completa");
    expect(sentEmails()[0]!.html).toContain("/es/testimonios");
  });

  it("still completes the job when the thank-you cannot be sent", async () => {
    mockGetBookingById.mockResolvedValue({
      ...BOOKING,
      status: "completed",
      totalAmount: 200,
      depositAmount: 200,
    });
    mockSendMail.mockRejectedValue(new Error("SMTP refused"));
    await expect(
      staffCaller().updateJobStatus({ bookingId: 42, status: "completed" })
    ).resolves.toEqual({ success: true });
  });
});

describe("reviewFormUrl", () => {
  it("points at the review form in each locale", () => {
    expect(reviewFormUrl(ORIGIN, "en")).toBe(`${ORIGIN}/en/testimonials`);
    expect(reviewFormUrl(ORIGIN, "es")).toBe(`${ORIGIN}/es/testimonios`);
  });

  it("does not double the slash", () => {
    expect(reviewFormUrl(`${ORIGIN}/`, "en")).toBe(`${ORIGIN}/en/testimonials`);
  });

  it("is omitted rather than relative when no public origin is known", () => {
    // A relative link in an inbox goes nowhere; better to drop the ask.
    expect(reviewFormUrl("", "en")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The templates themselves.
// ---------------------------------------------------------------------------

const templateData = {
  reference: "GFC-JOB42",
  serviceName: "Residential Cleaning",
  date: "2026-08-19",
  customerName: "Ana",
  customerEmail: "ana@example.com",
  bizPhone: "(210) 555-0123",
};

describe("the branded status templates", () => {
  const builders = [
    ["job started", buildJobStartedEmail],
    ["job complete", buildJobCompleteEmail],
  ] as const;

  it.each(builders)("%s renders in both languages", (_name, build) => {
    for (const locale of ["en", "es"] as const) {
      const { subject, body, html } = build({ ...templateData, locale, reviewUrl: `${ORIGIN}/x` });
      expect(subject.length, locale).toBeGreaterThan(10);
      // Every one of them carries the booking's own details, in both parts.
      for (const part of [body, html]) {
        expect(part, locale).toContain("GFC-JOB42");
        expect(part, locale).toContain("Residential Cleaning");
        expect(part, locale).toContain("2026-08-19");
        expect(part, locale).toContain("Ana");
        expect(part, locale).toContain("(210) 555-0123");
      }
    }
  });

  it.each(builders)("%s uses Spanish copy for the es locale, not English", (_name, build) => {
    const en = build({ ...templateData, locale: "en" });
    const es = build({ ...templateData, locale: "es" });
    expect(es.subject).not.toBe(en.subject);
    expect(es.html).toContain("Grapefruit Cleaning Co."); // the wordmark stays
    expect(es.body).toMatch(/[áéíóúñ¡¿]/); // and the copy is genuinely translated
  });

  it.each(builders)("%s is laid out for real mail clients", (_name, build) => {
    const { html } = build({ ...templateData, locale: "en" });
    // Outlook renders through Word: tables, not flex or grid.
    expect(html).toContain("<table");
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
    // Gmail strips <style> blocks, so nothing may depend on one.
    expect(html).not.toContain("<style");
    expect(html).not.toContain("class=");
    expect(html).not.toContain("@media");
    // Single column that fits a phone without a media query.
    expect(html).toContain("max-width:560px");
    expect(html).toContain('<meta name="viewport"');
    // The brand coral header.
    expect(html).toContain("background-color:#F26D5B");
    expect(html).toContain("Grapefruit Cleaning Co.");
  });

  it.each(builders)("%s always ships a plain-text alternative", (_name, build) => {
    const { body } = build({ ...templateData, locale: "en" });
    expect(body).not.toContain("<");
    expect(body.split("\n").length).toBeGreaterThan(4);
  });

  it("escapes customer-supplied text instead of letting it into the markup", () => {
    const { html } = buildJobStartedEmail({
      ...templateData,
      locale: "en",
      customerName: `Ana <script>alert("x")</script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops the review button when there is no review URL to point at", () => {
    const withUrl = buildJobCompleteEmail({ ...templateData, locale: "en", reviewUrl: `${ORIGIN}/en/testimonials` });
    const without = buildJobCompleteEmail({ ...templateData, locale: "en" });
    expect(withUrl.html).toContain("Leave a review");
    expect(without.html).not.toContain("Leave a review");
    expect(without.html).not.toContain("<a href");
  });

  it("says the job is settled, since it only ever goes to a zero balance", () => {
    expect(buildJobCompleteEmail({ ...templateData, locale: "en" }).body).toMatch(/no balance left/i);
    expect(buildJobCompleteEmail({ ...templateData, locale: "es" }).body).toMatch(/no queda ningún saldo/i);
  });

  it("never mentions money owed in the started email", () => {
    for (const locale of ["en", "es"] as const) {
      const { body } = buildJobStartedEmail({ ...templateData, locale });
      expect(body).not.toMatch(/\$/);
    }
  });
});
