/**
 * Re-booking nudges: the only marketing this system sends.
 *
 * What this file pins — the rules that keep it lawful and non-annoying:
 *   - an unsubscribe is honoured forever, and suppresses marketing only
 *     (invoices and receipts still reach the customer);
 *   - no nudge to someone with an upcoming booking or an unpaid invoice;
 *   - the cadence: ~3–4 weeks after the last cleaning, monthly thereafter,
 *     and never twice inside 21 days whatever else the rules say;
 *   - every nudge carries a working unsubscribe link, and a send with no link
 *     is refused outright;
 *   - the send is recorded BEFORE the email leaves, so a crash loses a nudge
 *     rather than repeating one;
 *   - both languages;
 *   - the sweep logs why each customer was skipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_NUDGE_DAYS,
  MARKETING_COOLDOWN_DAYS,
  MAX_NUDGES,
  REPEAT_NUDGE_DAYS,
  nudgeDecision,
  type NudgeCandidate,
} from "@shared/marketingRules";

const mockListCandidates = vi.fn();
const mockGetSetting = vi.fn();
const mockRecordSent = vi.fn();
const mockUnsubscribe = vi.fn();
const mockGetByToken = vi.fn();
const mockSendMail = vi.fn();

vi.mock("./db", () => ({
  listNudgeCandidates: (...a: unknown[]) => mockListCandidates(...a),
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  recordMarketingEmailSent: (...a: unknown[]) => mockRecordSent(...a),
  unsubscribeFromMarketing: (...a: unknown[]) => mockUnsubscribe(...a),
  getCustomerByMarketingToken: (...a: unknown[]) => mockGetByToken(...a),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

import { buildRebookingNudgeEmail, __resetTransporter } from "./emails";
import { bookUrlFor, sendDueRebookingNudges, unsubscribeUrlFor } from "./marketing";
import { unsubscribeHandler } from "./marketingRoutes";

const NOW = new Date("2026-08-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const CANDIDATE: NudgeCandidate = {
  customerId: 1,
  email: "ana@example.com",
  lastCompletedAt: daysAgo(40),
  hasUpcomingBooking: false,
  hasOpenInvoice: false,
  marketingUnsubscribedAt: null,
  lastMarketingEmailAt: null,
  marketingEmailCount: 0,
};

// ---------------------------------------------------------------------------
// The rules.
// ---------------------------------------------------------------------------

describe("who may receive a nudge", () => {
  it("sends the first one a few weeks after the last cleaning", () => {
    expect(nudgeDecision(CANDIDATE, NOW)).toEqual({ send: true, nudgeNumber: 1 });
  });

  it("waits out the full window after service", () => {
    const tooSoon = { ...CANDIDATE, lastCompletedAt: daysAgo(FIRST_NUDGE_DAYS - 1) };
    expect(nudgeDecision(tooSoon, NOW)).toEqual({ send: false, reason: "too_soon_since_service" });
    const justRight = { ...CANDIDATE, lastCompletedAt: daysAgo(FIRST_NUDGE_DAYS) };
    expect(nudgeDecision(justRight, NOW).send).toBe(true);
  });

  it("never emails an unsubscribed customer, however long it has been", () => {
    const gone = {
      ...CANDIDATE,
      marketingUnsubscribedAt: daysAgo(900),
      lastCompletedAt: daysAgo(900),
    };
    expect(nudgeDecision(gone, NOW)).toEqual({ send: false, reason: "unsubscribed" });
  });

  it("never nudges someone who already has a booking coming", () => {
    expect(nudgeDecision({ ...CANDIDATE, hasUpcomingBooking: true }, NOW)).toEqual({
      send: false,
      reason: "has_upcoming_booking",
    });
  });

  it("never markets to someone who owes us money", () => {
    expect(nudgeDecision({ ...CANDIDATE, hasOpenInvoice: true }, NOW)).toEqual({
      send: false,
      reason: "open_invoice",
    });
  });

  it("skips a customer who has never had a completed cleaning", () => {
    expect(nudgeDecision({ ...CANDIDATE, lastCompletedAt: null }, NOW)).toEqual({
      send: false,
      reason: "never_completed",
    });
  });

  it("skips a customer with no email address", () => {
    expect(nudgeDecision({ ...CANDIDATE, email: null }, NOW)).toEqual({
      send: false,
      reason: "no_email",
    });
  });

  it("spaces repeats a month apart and counts them up", () => {
    const recent = {
      ...CANDIDATE,
      marketingEmailCount: 1,
      lastMarketingEmailAt: daysAgo(REPEAT_NUDGE_DAYS - 1),
    };
    expect(nudgeDecision(recent, NOW)).toEqual({ send: false, reason: "too_soon_since_last_nudge" });
    const due = { ...recent, lastMarketingEmailAt: daysAgo(REPEAT_NUDGE_DAYS) };
    expect(nudgeDecision(due, NOW)).toEqual({ send: true, nudgeNumber: 2 });
  });

  it("honours the 21-day floor no matter what", () => {
    // Every gap shorter than the floor must be refused, whichever rule catches
    // it — this is the promise that carries legal weight.
    for (let gap = 0; gap < MARKETING_COOLDOWN_DAYS; gap++) {
      const decision = nudgeDecision(
        { ...CANDIDATE, marketingEmailCount: 1, lastMarketingEmailAt: daysAgo(gap) },
        NOW
      );
      expect(decision.send).toBe(false);
    }
  });

  it("stops asking after enough unanswered invitations", () => {
    const exhausted = {
      ...CANDIDATE,
      marketingEmailCount: MAX_NUDGES,
      lastMarketingEmailAt: daysAgo(400),
    };
    expect(nudgeDecision(exhausted, NOW)).toEqual({ send: false, reason: "exhausted" });
  });
});

// ---------------------------------------------------------------------------
// The email.
// ---------------------------------------------------------------------------

describe("the nudge email", () => {
  const DATA = {
    customerName: "Ana",
    customerEmail: "ana@example.com",
    lastServiceDate: "2026-07-11",
    monthsSince: 1,
    bookUrl: "https://grapeclean.example/en/book",
    unsubscribeUrl: "https://grapeclean.example/unsubscribe/abc123",
    locale: "en" as const,
  };

  it("invites them back and carries a visible unsubscribe", () => {
    const { subject, body } = buildRebookingNudgeEmail(DATA, 1);
    expect(subject).toContain("another cleaning");
    expect(body).toContain("2026-07-11");
    expect(body).toContain("https://grapeclean.example/en/book");
    expect(body).toContain("https://grapeclean.example/unsubscribe/abc123");
    expect(body).toContain("Unsubscribe");
  });

  it("makes clear that unsubscribing does not stop invoices", () => {
    const { body } = buildRebookingNudgeEmail(DATA, 1);
    expect(body).toContain("confirmations and invoices");
  });

  it("gets shorter after the first, rather than louder", () => {
    const first = buildRebookingNudgeEmail(DATA, 1);
    const later = buildRebookingNudgeEmail(DATA, 3);
    expect(later.body.length).toBeLessThan(first.body.length);
    expect(later.subject).not.toBe(first.subject);
    expect(later.body).toContain("/unsubscribe/");
  });

  it("renders in genuine Spanish", () => {
    const { subject, body } = buildRebookingNudgeEmail({ ...DATA, locale: "es" }, 1);
    expect(subject).toContain("limpieza");
    expect(body).toContain("Cancele su suscripción");
    expect(body).toContain("/unsubscribe/");
  });

  it("points Spanish customers at the Spanish booking page", () => {
    expect(bookUrlFor("https://x.test", "es")).toBe("https://x.test/es/reservar");
    expect(bookUrlFor("https://x.test", "en")).toBe("https://x.test/en/book");
    expect(unsubscribeUrlFor("https://x.test", "tok")).toBe("https://x.test/unsubscribe/tok");
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

describe("the daily nudge sweep", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    customerId: 1,
    firstName: "Ana",
    email: "ana@example.com",
    preferredLocale: "en",
    marketingUnsubscribedAt: null,
    marketingToken: null,
    lastMarketingEmailAt: null,
    marketingEmailCount: 0,
    lastCompletedDate: "2026-07-01",
    upcomingCount: 0,
    openInvoiceCount: 0,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTransporter();
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("SMTP_USER", "hello@grapefruitclean.com");
    vi.stubEnv("SMTP_PASSWORD", "pw");
    mockGetSetting.mockResolvedValue(null);
    mockRecordSent.mockResolvedValue(undefined);
    mockSendMail.mockResolvedValue({ messageId: "1" });
  });

  it("sends one nudge to an eligible customer and records it", async () => {
    mockListCandidates.mockResolvedValue([row()]);
    const summary = await sendDueRebookingNudges("https://grapeclean.example");
    expect(summary.sent).toBe(1);
    expect(mockRecordSent).toHaveBeenCalledWith(1, expect.stringMatching(/^[0-9a-f]{48}$/), expect.any(Date));
    const mail = mockSendMail.mock.calls[0]![0] as { to: string; text: string };
    expect(mail.to).toBe("ana@example.com");
    expect(mail.text).toContain("/unsubscribe/");
  });

  it("records the send BEFORE the email leaves, so a crash cannot double-send", async () => {
    const order: string[] = [];
    mockRecordSent.mockImplementation(async () => void order.push("recorded"));
    mockSendMail.mockImplementation(async () => {
      order.push("sent");
      return { messageId: "1" };
    });
    mockListCandidates.mockResolvedValue([row()]);
    await sendDueRebookingNudges("https://grapeclean.example");
    expect(order).toEqual(["recorded", "sent"]);
  });

  it("reuses an existing unsubscribe token so old links keep working", async () => {
    mockListCandidates.mockResolvedValue([
      row({ marketingToken: "existing-token", marketingEmailCount: 1, lastMarketingEmailAt: new Date("2026-01-01") }),
    ]);
    await sendDueRebookingNudges("https://grapeclean.example");
    expect(mockRecordSent).toHaveBeenCalledWith(1, "existing-token", expect.any(Date));
    expect((mockSendMail.mock.calls[0]![0] as { text: string }).text).toContain("/unsubscribe/existing-token");
  });

  it("sends nothing at all without a public origin — an unclickable unsubscribe is worse than silence", async () => {
    mockListCandidates.mockResolvedValue([row()]);
    const summary = await sendDueRebookingNudges("");
    expect(summary.sent).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it("skips the ineligible and says why", async () => {
    mockListCandidates.mockResolvedValue([
      row({ customerId: 2, marketingUnsubscribedAt: new Date("2026-01-01") }),
      row({ customerId: 3, upcomingCount: 1 }),
      row({ customerId: 4, openInvoiceCount: 1 }),
      row({ customerId: 5, lastCompletedDate: null }),
    ]);
    const summary = await sendDueRebookingNudges("https://grapeclean.example");
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toMatchObject({
      unsubscribed: 1,
      has_upcoming_booking: 1,
      open_invoice: 1,
      never_completed: 1,
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("uses the customer's own language", async () => {
    mockListCandidates.mockResolvedValue([row({ preferredLocale: "es" })]);
    await sendDueRebookingNudges("https://grapeclean.example");
    const mail = mockSendMail.mock.calls[0]![0] as { subject: string; text: string };
    expect(mail.subject).toContain("limpieza");
    expect(mail.text).toContain("/es/reservar");
  });
});

// ---------------------------------------------------------------------------
// The unsubscribe link.
// ---------------------------------------------------------------------------

describe("one-click unsubscribe", () => {
  const res = () => {
    const sent: { status: number; html: string } = { status: 200, html: "" };
    const stub = {
      status(code: number) {
        sent.status = code;
        return stub;
      },
      type() {
        return stub;
      },
      send(html: string) {
        sent.html = html;
        return stub;
      },
    };
    return { stub, sent };
  };

  beforeEach(() => vi.clearAllMocks());

  it("unsubscribes in a single GET, no confirmation step", async () => {
    mockGetByToken.mockResolvedValue({ id: 7, preferredLocale: "en" });
    mockUnsubscribe.mockResolvedValue(undefined);
    const { stub, sent } = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, stub as never);
    expect(mockUnsubscribe).toHaveBeenCalledWith(7);
    expect(sent.status).toBe(200);
    expect(sent.html).toContain("unsubscribed");
  });

  it("confirms in the customer's language", async () => {
    mockGetByToken.mockResolvedValue({ id: 7, preferredLocale: "es" });
    const { stub, sent } = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, stub as never);
    expect(sent.html).toContain("Suscripción cancelada");
  });

  it("never echoes the customer's identity back to whoever opened the link", async () => {
    mockGetByToken.mockResolvedValue({ id: 7, preferredLocale: "en", email: "ana@example.com", firstName: "Ana" });
    const { stub, sent } = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, stub as never);
    expect(sent.html).not.toContain("ana@example.com");
    expect(sent.html).not.toContain("Ana");
  });

  it("is idempotent — a second click still confirms", async () => {
    mockGetByToken.mockResolvedValue({ id: 7, preferredLocale: "en" });
    const first = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, first.stub as never);
    const second = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, second.stub as never);
    expect(second.sent.status).toBe(200);
    expect(second.sent.html).toContain("unsubscribed");
  });

  it("shows a helpful notice for an unknown token", async () => {
    mockGetByToken.mockResolvedValue(undefined);
    const { stub, sent } = res();
    await unsubscribeHandler({ params: { token: "nope" } } as never, stub as never);
    expect(sent.status).toBe(404);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("degrades to a branded notice if the database is unreachable", async () => {
    mockGetByToken.mockRejectedValue(new Error("db down"));
    const { stub, sent } = res();
    await unsubscribeHandler({ params: { token: "abc" } } as never, stub as never);
    expect(sent.status).toBe(500);
    expect(sent.html).toContain("Grapefruit Cleaning Co.");
  });
});
