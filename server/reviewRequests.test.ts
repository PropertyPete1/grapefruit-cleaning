/**
 * The review request (PR C2): "how did we do?" the day after a completed and
 * paid cleaning, with the Google review link from Admin → Settings.
 *
 * What this file pins:
 *   - it goes to a job that is completed AND paid — the same test that makes a
 *     customer returning — and only once the settlement is a day old, never
 *     for one older than the window (no backfill of history on deploy);
 *   - once per job: the claim is written before the email leaves, and a job
 *     already claimed is skipped;
 *   - it respects the marketing unsubscribe, and every copy carries the
 *     one-click unsubscribe link;
 *   - the Google link from Settings is the button; without one, the site's
 *     own review form stands in; a broken value is treated as unset;
 *   - a customer's first completed job says the recurring plans are now theirs,
 *     with the booking link — later jobs, and jobs already on a plan, do not;
 *   - it is logged to email_log as "review_request" against the booking;
 *   - both languages; nothing at all without a public origin;
 *   - the daily cron beat runs it in its own try/catch, after the transactional
 *     reminders; auto-booked turnovers are never candidates;
 *   - Admin → Settings validates the link and exposes the three new fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockListCandidates = vi.fn();
const mockListInvoiceStates = vi.fn();
const mockEnsureToken = vi.fn();
const mockCountCompleted = vi.fn();
const mockClaim = vi.fn();
const mockRecordEmail = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  setSetting: (...a: unknown[]) => mockSetSetting(...a),
  listReviewRequestCandidates: (...a: unknown[]) => mockListCandidates(...a),
  listInvoiceStatesForBookings: (...a: unknown[]) => mockListInvoiceStates(...a),
  ensureMarketingToken: (...a: unknown[]) => mockEnsureToken(...a),
  countCompletedBookingsForCustomer: (...a: unknown[]) => mockCountCompleted(...a),
  claimReviewRequestEmail: (...a: unknown[]) => mockClaim(...a),
  recordEmailAttemptReturningId: (...a: unknown[]) => mockRecordEmail(...a),
  lastEmailAlertAt: vi.fn().mockResolvedValue(null),
  markEmailAlertSent: vi.fn().mockResolvedValue(undefined),
  markEmailAlertSuppressed: vi.fn().mockResolvedValue(undefined),
  countSuppressedSince: vi.fn().mockResolvedValue(0),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import {
  REVIEW_REQUEST_DELAY_HOURS,
  REVIEW_REQUEST_EMAIL_TYPE,
  REVIEW_REQUEST_WINDOW_DAYS,
  REVIEW_URL_SETTING_KEY,
  normalizeReviewUrl,
  reviewRequestDue,
  reviewUrlProblem,
} from "@shared/reviewRequest";
import { __resetTransporter, buildReviewRequestEmail, sendReviewRequestEmail } from "./emails";
import { sendDueReviewRequests, settledAtOf } from "./reviewRequests";
import { adminRouter } from "./routers/admin";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const ORIGIN = "https://grapeclean.example";
const NOW = new Date("2026-09-28T14:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const GOOGLE = "https://g.page/r/AbCdEf/review";
const TOKEN = "t".repeat(48);

const candidate = (overrides: Record<string, unknown> = {}) => ({
  bookingId: 12,
  reference: "GFC-REV12",
  customerId: 41,
  serviceType: "residential",
  scheduledDate: "2026-09-26",
  frequency: "onetime",
  locale: "en",
  status: "completed",
  totalAmount: 112.99,
  totalAmountCents: 11299,
  depositAmount: 22.6,
  depositAmountCents: 2260,
  stripePaymentIntentId: "pi_1",
  completedEmailSentAt: hoursAgo(26),
  tipEmailSentAt: hoursAgo(26),
  customerFirstName: "Maria",
  customerEmail: "maria@example.com",
  marketingUnsubscribedAt: null,
  marketingToken: TOKEN,
  ...overrides,
});

const paidInvoice = (paidAt: Date = hoursAgo(26), bookingId = 12) => ({ bookingId, status: "paid", paidAt });

const sentMail = () => mockSendMail.mock.calls[0]![0] as { to: string; subject: string; text: string; html: string };

const adminCaller = () =>
  adminRouter.createCaller({
    user: { id: 1, role: "admin" },
    req: { protocol: "https", headers: { origin: ORIGIN } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransporter();
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("SMTP_USER", "hello@grapefruitclean.com");
  vi.stubEnv("SMTP_PASSWORD", "pw");
  mockGetSetting.mockImplementation(async (key: string) =>
    key === REVIEW_URL_SETTING_KEY ? GOOGLE : key === "business_phone" ? "(210) 555-0123" : null
  );
  mockSetSetting.mockResolvedValue(undefined);
  mockListCandidates.mockResolvedValue([candidate()]);
  mockListInvoiceStates.mockResolvedValue([paidInvoice()]);
  mockEnsureToken.mockResolvedValue(TOKEN);
  mockCountCompleted.mockResolvedValue(1);
  mockClaim.mockResolvedValue(true);
  mockRecordEmail.mockResolvedValue(1);
  mockSendMail.mockResolvedValue({ messageId: "1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Timing.
// ---------------------------------------------------------------------------

describe("when the ask is due", () => {
  it("a day after settlement, and for two weeks", () => {
    expect(reviewRequestDue(hoursAgo(REVIEW_REQUEST_DELAY_HOURS - 1), NOW)).toBe("too_soon");
    expect(reviewRequestDue(hoursAgo(REVIEW_REQUEST_DELAY_HOURS), NOW)).toBe("due");
    expect(reviewRequestDue(daysAgo(REVIEW_REQUEST_WINDOW_DAYS), NOW)).toBe("due");
    expect(reviewRequestDue(daysAgo(REVIEW_REQUEST_WINDOW_DAYS + 1), NOW)).toBe("too_old");
    expect(reviewRequestDue(null, NOW)).toBe("not_settled");
  });

  it("settlement is the paid invoice's paidAt, else the completion thank-you's timestamp", () => {
    const row = candidate({ completedEmailSentAt: hoursAgo(40), tipEmailSentAt: hoursAgo(40) });
    expect(settledAtOf(row, [paidInvoice(hoursAgo(30))])).toEqual(hoursAgo(30));
    expect(settledAtOf(row, [{ bookingId: 12, status: "sent", paidAt: null }])).toEqual(hoursAgo(40));
    expect(settledAtOf(candidate({ completedEmailSentAt: null, tipEmailSentAt: null }), [])).toBeNull();
    // Two paid invoices: the later settlement is the one that counts.
    expect(settledAtOf(row, [paidInvoice(hoursAgo(60)), paidInvoice(hoursAgo(25))])).toEqual(hoursAgo(25));
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

describe("sendDueReviewRequests", () => {
  it("sends the ask for a completed, paid job settled a day ago — claimed first, logged as review_request", async () => {
    const summary = await sendDueReviewRequests(ORIGIN, NOW);
    expect(summary).toMatchObject({ scanned: 1, sent: 1, skipped: {} });
    expect(summary.details).toEqual(["GFC-REV12 (first job — recurring plans unlocked)"]);

    expect(mockClaim).toHaveBeenCalledWith(12, NOW);
    expect(mockClaim.mock.invocationCallOrder[0]!).toBeLessThan(mockSendMail.mock.invocationCallOrder[0]!);

    const mail = sentMail();
    expect(mail.to).toBe("maria@example.com");
    expect(mail.subject).toBe("How did we do? We'd love your review | Grapefruit Cleaning Co.");
    expect(mail.html).toContain(`href="${GOOGLE}"`);
    expect(mail.html).toContain("Leave a Google review");
    expect(mail.text).toContain(`Leave a Google review: ${GOOGLE}`);
    expect(mail.html).toContain("GFC-REV12");
    expect(mail.html).toContain("(210) 555-0123");

    expect(mockRecordEmail).toHaveBeenCalledWith(
      expect.objectContaining({ emailType: REVIEW_REQUEST_EMAIL_TYPE, bookingId: 12, outcome: "delivered", recipient: "maria@example.com" })
    );
  });

  it("carries the one-click unsubscribe link in both parts", async () => {
    await sendDueReviewRequests(ORIGIN, NOW);
    const mail = sentMail();
    expect(mail.html).toContain(`href="${ORIGIN}/unsubscribe/${TOKEN}"`);
    expect(mail.text).toContain(`${ORIGIN}/unsubscribe/${TOKEN}`);
    expect(mockEnsureToken).toHaveBeenCalledWith(41, expect.stringMatching(/^[0-9a-f]{48}$/));
  });

  it("a first completed job says the recurring plans are now theirs, with the booking link", async () => {
    await sendDueReviewRequests(ORIGIN, NOW);
    const mail = sentMail();
    expect(mail.html).toContain("recurring plans are available to you");
    expect(mail.html).toContain(`href="${ORIGIN}/en/book"`);
    expect(mail.text).toContain(`Book my next cleaning: ${ORIGIN}/en/book`);
  });

  it("a second job, or a job already on a plan the owner set, gets no recurring invite", async () => {
    mockCountCompleted.mockResolvedValue(2);
    await sendDueReviewRequests(ORIGIN, NOW);
    expect(sentMail().html).not.toContain("recurring plans are available");
    expect((await sendDueReviewRequests(ORIGIN, NOW)).details).toEqual(["GFC-REV12"]);

    mockSendMail.mockClear();
    mockCountCompleted.mockResolvedValue(1);
    mockListCandidates.mockResolvedValue([candidate({ frequency: "biweekly" })]);
    await sendDueReviewRequests(ORIGIN, NOW);
    expect(sentMail().html).not.toContain("recurring plans are available");
  });

  it("Spanish customers get the Spanish email, the Spanish booking link and the Spanish review form", async () => {
    mockGetSetting.mockResolvedValue(null);
    mockListCandidates.mockResolvedValue([candidate({ locale: "es" })]);
    await sendDueReviewRequests(ORIGIN, NOW);
    const mail = sentMail();
    expect(mail.subject).toBe("¿Cómo lo hicimos? Su opinión nos importa | Grapefruit Cleaning Co.");
    expect(mail.html).toContain("Dejar una reseña");
    expect(mail.html).toContain(`href="${ORIGIN}/es/testimonios"`);
    expect(mail.html).toContain(`href="${ORIGIN}/es/reservar"`);
    expect(mail.html).toContain("Cancele su suscripción");
  });

  it("without a Google link — or with a broken one — the site's own review form stands in", async () => {
    mockGetSetting.mockResolvedValue(null);
    await sendDueReviewRequests(ORIGIN, NOW);
    expect(sentMail().html).toContain(`href="${ORIGIN}/en/testimonials"`);
    expect(sentMail().html).toContain("Leave a review");
    expect(sentMail().html).not.toContain("Google");

    mockSendMail.mockClear();
    mockGetSetting.mockImplementation(async (key: string) => (key === REVIEW_URL_SETTING_KEY ? "g.page/broken" : null));
    await sendDueReviewRequests(ORIGIN, NOW);
    expect(sentMail().html).toContain(`href="${ORIGIN}/en/testimonials"`);
  });

  it("is once per job: a claim that fails means someone else already sent it", async () => {
    mockClaim.mockResolvedValue(false);
    const summary = await sendDueReviewRequests(ORIGIN, NOW);
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toEqual({ already_claimed: 1 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("waits a day after settlement, and leaves anything older than the window alone", async () => {
    mockListInvoiceStates.mockResolvedValue([paidInvoice(hoursAgo(2))]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).skipped).toEqual({ too_soon: 1 });

    mockListInvoiceStates.mockResolvedValue([paidInvoice(daysAgo(20))]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).skipped).toEqual({ too_old: 1 });

    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("Test D/F — an unpaid job is not asked; a job the deposit covered outright is", async () => {
    mockListInvoiceStates.mockResolvedValue([{ bookingId: 12, status: "sent", paidAt: null }]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).skipped).toEqual({ unpaid: 1 });
    expect(mockClaim).not.toHaveBeenCalled();

    // Zero balance: no invoice, deposit = total, settled at the completion thank-you.
    mockListInvoiceStates.mockResolvedValue([]);
    mockListCandidates.mockResolvedValue([candidate({ depositAmountCents: 11299, depositAmount: 112.99 })]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).sent).toBe(1);

    // Cash the owner recorded is a paid invoice like any other.
    mockSendMail.mockClear();
    mockListCandidates.mockResolvedValue([candidate({ stripePaymentIntentId: null, depositAmountCents: 0 })]);
    mockListInvoiceStates.mockResolvedValue([{ bookingId: 12, status: "paid", paidAt: hoursAgo(30), paidVia: "manual", paidMethod: "cash" }]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).sent).toBe(1);
  });

  it("honours the marketing unsubscribe, and skips a customer with no email", async () => {
    mockListCandidates.mockResolvedValue([candidate({ marketingUnsubscribedAt: daysAgo(100) })]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).skipped).toEqual({ unsubscribed: 1 });
    mockListCandidates.mockResolvedValue([candidate({ customerEmail: null })]);
    expect((await sendDueReviewRequests(ORIGIN, NOW)).skipped).toEqual({ no_email: 1 });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("sends nothing at all without a public origin — the links would be relative", async () => {
    const summary = await sendDueReviewRequests("", NOW);
    expect(summary.sent).toBe(0);
    expect(summary.details[0]).toContain("no public origin");
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it("scans only recently touched jobs, and never an auto-booked turnover", async () => {
    await sendDueReviewRequests(ORIGIN, NOW);
    const since = mockListCandidates.mock.calls[0]![0] as Date;
    expect(since.getTime()).toBe(daysAgo(REVIEW_REQUEST_WINDOW_DAYS + 2).getTime());
    const db = source("./db.ts");
    const query = db.slice(db.indexOf("export async function listReviewRequestCandidates"));
    expect(query).toContain('ne(bookings.kind, "ical_auto")');
    expect(query).toContain("isNull(bookings.reviewEmailSentAt)");
    expect(query).toContain('eq(bookings.status, "completed")');
  });

  it("the send itself refuses to go without an unsubscribe link", async () => {
    const data = {
      bookingId: 12,
      reference: "GFC-REV12",
      serviceName: "Residential Cleaning",
      date: "2026-09-26",
      customerName: "Maria",
      customerEmail: "maria@example.com",
      locale: "en" as const,
      reviewUrl: GOOGLE,
      googleReview: true,
      unsubscribeUrl: "",
    };
    expect(await sendReviewRequestEmail(data)).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
    // The builder itself is pure and bilingual.
    expect(buildReviewRequestEmail({ ...data, unsubscribeUrl: `${ORIGIN}/unsubscribe/x`, locale: "es" }).subject).toContain("¿Cómo lo hicimos?");
  });
});

// ---------------------------------------------------------------------------
// Wiring and settings.
// ---------------------------------------------------------------------------

describe("the daily beat and the schema", () => {
  it("runs the sweep on the reminders cron, in its own try/catch, after the balance reminders", () => {
    const scheduled = source("./scheduledRoutes.ts");
    expect(scheduled).toContain("reviews = await sendDueReviewRequests(publicOrigin(req));");
    expect(scheduled).toContain('console.error("[Reviews] Review request sweep failed:", error);');
    expect(scheduled.indexOf("sendDueBalanceReminders(publicOrigin(req))")).toBeLessThan(scheduled.indexOf("sendDueReviewRequests(publicOrigin(req))"));
    expect(scheduled.indexOf("sendDueReviewRequests(publicOrigin(req))")).toBeLessThan(scheduled.indexOf("sendDueRebookingNudges(publicOrigin(req))"));
    expect(scheduled).toContain("balanceReminders: balances, reviews, nudges");
  });

  it("the once-per-job claim has a column and a migration", () => {
    expect(source("../drizzle/schema.ts")).toContain('reviewEmailSentAt: timestamp("reviewEmailSentAt")');
    expect(source("../drizzle/0035_review_request.sql")).toContain("ALTER TABLE `bookings` ADD `reviewEmailSentAt` timestamp;");
    const db = source("./db.ts");
    expect(db).toContain("export async function claimReviewRequestEmail");
    expect(db).toContain(".set({ reviewEmailSentAt: now })");
    expect(db).toContain("isNull(bookings.reviewEmailSentAt)));");
  });
});

describe("Admin → Settings", () => {
  it("validates the review link: a web address or blank, nothing else", async () => {
    await expect(adminCaller().saveSetting({ key: REVIEW_URL_SETTING_KEY, value: "g.page/r/abc/review" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(adminCaller().saveSetting({ key: REVIEW_URL_SETTING_KEY, value: "ftp://g.page/r/abc" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mockSetSetting).not.toHaveBeenCalled();
    await adminCaller().saveSetting({ key: REVIEW_URL_SETTING_KEY, value: GOOGLE });
    await adminCaller().saveSetting({ key: REVIEW_URL_SETTING_KEY, value: "" });
    expect(mockSetSetting).toHaveBeenCalledWith(REVIEW_URL_SETTING_KEY, GOOGLE);
    expect(mockSetSetting).toHaveBeenCalledWith(REVIEW_URL_SETTING_KEY, "");
  });

  it("the shared validator and normalizer agree", () => {
    expect(reviewUrlProblem("")).toBeNull();
    expect(reviewUrlProblem(GOOGLE)).toBeNull();
    expect(reviewUrlProblem("not a url")).toMatch(/https:\/\//);
    expect(reviewUrlProblem(`https://x.example/${"a".repeat(600)}`)).toMatch(/too long/);
    expect(normalizeReviewUrl(`  ${GOOGLE}  `)).toBe(GOOGLE);
    expect(normalizeReviewUrl("")).toBeNull();
    expect(normalizeReviewUrl("javascript:alert(1)")).toBeNull();
  });

  it("exposes the review link and the text line in the general settings form", () => {
    const page = source("../client/src/pages/admin/AdminSettings.tsx");
    expect(page).toContain('title: "Reviews & texting"');
    expect(page).toContain("key: REVIEW_URL_SETTING_KEY");
    expect(page).toContain("key: TEXT_NUMBER_SETTING_KEY");
    expect(page).toContain("key: TEXT_NAME_SETTING_KEY");
    expect(page).toContain("{f.hint && <p");
  });
});
