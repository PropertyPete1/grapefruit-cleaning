/**
 * The system reporting on itself, so the owner never has to go looking.
 *
 * Two rhythms:
 *   - a DAILY health check that folds anything wrong into the existing
 *     owner-alert path, so a problem surfaces within a day;
 *   - a WEEKLY digest every Monday: what the system sent, what failed
 *     quietly, who is about to be nudged, and what the books look like.
 *
 * Both are read-only over the database. Nothing here can change a booking, an
 * invoice or a customer — a reporting job that mutates state is a reporting
 * job that can corrupt it, and this one runs unattended forever.
 */
import { FIRST_NUDGE_DAYS, REPEAT_NUDGE_DAYS, nudgeDecision, type NudgeCandidate } from "@shared/marketingRules";
import * as db from "./db";
import { listHeartbeatJobs, type HeartbeatJobInfo } from "./_core/heartbeat";
import { sendOwnerAlert, smtpUser } from "./emails";

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthFindings {
  paidOnOpenBookings: Array<{ invoiceNumber: string; reference: string; bookingStatus: string; amount: number }>;
  deadLinks: Array<{ invoiceNumber: string; amount: number; expiredOn: string }>;
  customersWithoutEmail: Array<{ name: string; phone: string | null }>;
  staleIcalProperties: Array<{
    id: number;
    label: string;
    address: string;
    lastSuccessfulSyncAt: string | null;
    hoursSinceSuccess: number | null;
    lastError: string | null;
  }>;
  criticalScheduleProblems: Array<{
    name: string;
    problem: "missing" | "disabled" | "misconfigured" | "stale" | "inspection_failed";
    detail: string;
    lastExecutedAt: string | null;
    nextExecutionAt: string | null;
  }>;
  /** Public business mailbox compared with the transport's resolved sender. */
  smtpIdentity: {
    expected: string | null;
    effective: string | null;
    matches: boolean | null;
  };
  /** True when something needs a human. Missing emails alone do NOT qualify. */
  hasProblems: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const ICAL_SUCCESS_MAX_AGE_MS = 24 * HOUR_MS;
const NEXT_EXECUTION_GRACE_MS = 15 * 60 * 1000;

const CRITICAL_SCHEDULES = [
  {
    name: "hourly-ical-sync",
    cron: "0 5 * * * *",
    path: "/api/scheduled/icalSync",
    maxAgeMs: 2 * HOUR_MS,
  },
  {
    name: "daily-booking-reminders",
    cron: "0 0 14 * * *",
    path: "/api/scheduled/sendReminders",
    maxAgeMs: 26 * HOUR_MS,
  },
] as const;

function asMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function asIso(value: Date | string | null | undefined): string | null {
  const millis = asMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

export function inspectCriticalSchedules(
  jobs: HeartbeatJobInfo[],
  now: Date = new Date()
): HealthFindings["criticalScheduleProblems"] {
  const byName = new Map(jobs.map(job => [job.name, job]));
  const nowMs = now.getTime();
  const findings: HealthFindings["criticalScheduleProblems"] = [];

  for (const expected of CRITICAL_SCHEDULES) {
    const job = byName.get(expected.name);
    if (!job) {
      findings.push({
        name: expected.name,
        problem: "missing",
        detail: `Job is not registered; expected ${expected.cron} → ${expected.path}.`,
        lastExecutedAt: null,
        nextExecutionAt: null,
      });
      continue;
    }

    const lastExecutedMs = asMillis(job.lastExecutedAt);
    const nextExecutionMs = asMillis(job.nextExecutionAt);
    const base = {
      name: expected.name,
      lastExecutedAt: asIso(job.lastExecutedAt),
      nextExecutionAt: asIso(job.nextExecutionAt),
    };

    if (!job.isEnable) {
      findings.push({ ...base, problem: "disabled", detail: "Job is registered but disabled." });
      continue;
    }

    const configDifferences: string[] = [];
    if (job.cronExpression !== expected.cron) {
      configDifferences.push(`cron is ${job.cronExpression || "(missing)"}; expected ${expected.cron}`);
    }
    if (job.callbackPath !== expected.path) {
      configDifferences.push(`callback is ${job.callbackPath || "(missing)"}; expected ${expected.path}`);
    }
    if (configDifferences.length > 0) {
      findings.push({ ...base, problem: "misconfigured", detail: configDifferences.join("; ") });
      continue;
    }

    const staleReasons: string[] = [];
    if (lastExecutedMs === null) {
      staleReasons.push("no completed execution is recorded");
    } else if (nowMs - lastExecutedMs > expected.maxAgeMs) {
      staleReasons.push(`last execution is ${Math.round((nowMs - lastExecutedMs) / HOUR_MS * 10) / 10} hours old`);
    }
    if (nextExecutionMs === null) {
      staleReasons.push("no next execution is scheduled");
    } else if (nextExecutionMs < nowMs - NEXT_EXECUTION_GRACE_MS) {
      staleReasons.push("next execution is stuck in the past");
    }
    if (staleReasons.length > 0) {
      findings.push({ ...base, problem: "stale", detail: staleReasons.join("; ") });
    }
  }

  return findings;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

/**
 * Looks for the three inconsistencies worth chasing.
 *
 * Customers without an email are reported but do NOT set hasProblems: a phone
 * lead is a legitimate customer, not a fault, and alerting daily about a
 * permanent fact of the business is how an alert channel gets ignored.
 */
export async function runHealthCheck(now: Date = new Date()): Promise<HealthFindings> {
  const [paid, dead, noEmail, configuredBusinessEmail, activeProperties, heartbeat] = await Promise.all([
    db.findPaidInvoicesOnOpenBookings(),
    db.findInvoicesWithDeadLinks(now),
    db.findCustomersWithoutEmail(),
    db.getSetting("business_email"),
    db.listActiveSyncProperties(),
    listHeartbeatJobs("", { pageSize: 200 })
      .then(result => ({ jobs: result.jobs, error: null as string | null }))
      .catch(error => ({
        jobs: [] as HeartbeatJobInfo[],
        error: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const expectedSmtpUser = configuredBusinessEmail?.trim() || null;
  const effectiveSmtpUser = smtpUser()?.trim() || null;
  const nowMs = now.getTime();
  const staleIcalProperties = activeProperties.flatMap(property => {
    const successfulAt = property.lastSuccessfulSyncAt;
    const successfulMs = asMillis(successfulAt);
    if (successfulMs !== null && nowMs - successfulMs <= ICAL_SUCCESS_MAX_AGE_MS) return [];
    return [{
      id: property.id,
      label: property.label,
      address: [property.addressLine, property.unitNumber, property.city, property.zip].filter(Boolean).join(", "),
      lastSuccessfulSyncAt: asIso(successfulAt),
      hoursSinceSuccess: successfulMs === null
        ? null
        : Math.round((nowMs - successfulMs) / HOUR_MS * 10) / 10,
      lastError: property.lastSyncStatus && property.lastSyncStatus !== "ok" ? property.lastSyncStatus : null,
    }];
  });
  const criticalScheduleProblems: HealthFindings["criticalScheduleProblems"] = heartbeat.error
    ? [{
        name: "Heartbeat registry",
        problem: "inspection_failed",
        detail: heartbeat.error,
        lastExecutedAt: null,
        nextExecutionAt: null,
      }]
    : inspectCriticalSchedules(heartbeat.jobs, now);

  const findings: HealthFindings = {
    paidOnOpenBookings: paid.map(r => ({
      invoiceNumber: r.invoiceNumber,
      reference: r.reference,
      bookingStatus: r.bookingStatus,
      amount: Number(r.amount),
    })),
    deadLinks: dead.map(r => ({
      invoiceNumber: r.invoiceNumber,
      amount: Number(r.amount),
      expiredOn: fmtDate(r.linkExpiresAt),
    })),
    customersWithoutEmail: noEmail.map(c => ({
      name: `${c.firstName} ${c.lastName}`.trim(),
      phone: c.phone,
    })),
    staleIcalProperties,
    criticalScheduleProblems,
    smtpIdentity: {
      expected: expectedSmtpUser,
      effective: effectiveSmtpUser,
      matches: expectedSmtpUser
        ? effectiveSmtpUser?.toLowerCase() === expectedSmtpUser.toLowerCase()
        : null,
    },
    hasProblems: false,
  };
  findings.hasProblems =
    findings.paidOnOpenBookings.length > 0 ||
    findings.deadLinks.length > 0 ||
    findings.staleIcalProperties.length > 0 ||
    findings.criticalScheduleProblems.length > 0 ||
    findings.smtpIdentity.matches === false;
  return findings;
}

export function healthProblemCount(findings: HealthFindings): number {
  return findings.paidOnOpenBookings.length +
    findings.deadLinks.length +
    findings.staleIcalProperties.length +
    findings.criticalScheduleProblems.length +
    (findings.smtpIdentity.matches === false ? 1 : 0);
}

/** The health section, as plain text. Used by both the alert and the digest. */
export function formatHealthFindings(f: HealthFindings): string {
  const lines: string[] = [];
  if (f.paidOnOpenBookings.length > 0) {
    lines.push(`PAID INVOICES ON UNFINISHED JOBS (${f.paidOnOpenBookings.length})`);
    lines.push(`These were paid but the booking isn't marked completed, so the customer`);
    lines.push(`gets no tip request and won't enter the re-booking cycle:`);
    for (const r of f.paidOnOpenBookings) {
      lines.push(`  • ${r.invoiceNumber} — $${r.amount} — booking ${r.reference} is "${r.bookingStatus}"`);
    }
    lines.push("");
  }
  if (f.deadLinks.length > 0) {
    lines.push(`UNPAID INVOICES WITH EXPIRED PAYMENT LINKS (${f.deadLinks.length})`);
    lines.push(`The customer cannot pay these even if they want to. Press Resend in`);
    lines.push(`Admin → Invoices to issue a fresh link:`);
    for (const r of f.deadLinks) {
      lines.push(`  • ${r.invoiceNumber} — $${r.amount} — link expired ${r.expiredOn}`);
    }
    lines.push("");
  }
  if (f.customersWithoutEmail.length > 0) {
    lines.push(`CUSTOMERS WITH NO EMAIL ADDRESS (${f.customersWithoutEmail.length})`);
    lines.push(`Not a fault — but these people get no confirmations, receipts or`);
    lines.push(`re-booking invitations:`);
    for (const c of f.customersWithoutEmail) {
      lines.push(`  • ${c.name}${c.phone ? ` — ${c.phone}` : ""}`);
    }
    lines.push("");
  }
  if (f.smtpIdentity.matches === false) {
    lines.push("SMTP SENDER IDENTITY MISMATCH");
    lines.push(`Public business email: ${f.smtpIdentity.expected ?? "(not configured)"}`);
    lines.push(`Resolved SMTP sender: ${f.smtpIdentity.effective ?? "(not configured)"}`);
    lines.push("The email environment likely rolled back or drifted. Restore the intended mailbox before relying on customer delivery.");
    lines.push("");
  }
  if (f.staleIcalProperties.length > 0) {
    lines.push(`ICAL FEEDS WITHOUT A SUCCESSFUL SYNC IN 24 HOURS (${f.staleIcalProperties.length})`);
    lines.push("A missing turnover can leave the crew unaware of a scheduled cleaning:");
    for (const property of f.staleIcalProperties) {
      const age = property.hoursSinceSuccess === null ? "never" : `${property.hoursSinceSuccess} hours ago`;
      const error = property.lastError ? ` — last error: ${property.lastError}` : "";
      lines.push(`  • ${property.label} — ${property.address} — last success ${age}${error}`);
    }
    lines.push("");
  }
  if (f.criticalScheduleProblems.length > 0) {
    lines.push(`CRITICAL SCHEDULES NEED ATTENTION (${f.criticalScheduleProblems.length})`);
    lines.push("The iCal sync and reminder jobs must stay registered, enabled and current:");
    for (const schedule of f.criticalScheduleProblems) {
      lines.push(`  • ${schedule.name} — ${schedule.problem}: ${schedule.detail}`);
    }
    lines.push("");
  }
  if (lines.length === 0) lines.push("No inconsistencies found.");
  return lines.join("\n");
}

/**
 * Daily: alert the owner only when something actually needs doing.
 *
 * Silence when all is well is the point. An alert that arrives every single
 * day stops being read within a fortnight, and then the one that matters is
 * invisible too.
 */
export async function runDailyHealthCheck(now: Date = new Date()): Promise<HealthFindings> {
  const findings = await runHealthCheck(now);
  if (findings.hasProblems) {
    const count = healthProblemCount(findings);
    await sendOwnerAlert(
      `Grapefruit: ${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your attention`,
      [
        `The daily check found something worth a look.`,
        ``,
        formatHealthFindings(findings),
        `— Grapefruit Cleaning Co. automated check`,
      ].join("\n")
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Upcoming nudges
// ---------------------------------------------------------------------------

export interface UpcomingNudge {
  name: string;
  email: string;
  dueOn: string;
  nudgeNumber: number;
}

/**
 * Who is due a re-booking nudge in the next `days`.
 *
 * Projected by replaying the real decision function forward one day at a time,
 * rather than by reimplementing the cadence arithmetic here. If the rules
 * change, this projection changes with them automatically — a second copy of
 * the maths would silently drift and start promising nudges that never arrive.
 */
export async function upcomingNudges(days = 7, now: Date = new Date()): Promise<UpcomingNudge[]> {
  const rows = await db.listNudgeCandidates();
  const out: UpcomingNudge[] = [];
  for (const row of rows) {
    const candidate: NudgeCandidate = {
      customerId: row.customerId,
      email: row.email,
      lastCompletedAt: row.lastCompletedDate ? new Date(`${row.lastCompletedDate}T12:00:00Z`) : null,
      hasUpcomingBooking: Number(row.upcomingCount) > 0,
      hasOpenInvoice: Number(row.openInvoiceCount) > 0,
      marketingUnsubscribedAt: row.marketingUnsubscribedAt ? new Date(row.marketingUnsubscribedAt) : null,
      lastMarketingEmailAt: row.lastMarketingEmailAt ? new Date(row.lastMarketingEmailAt) : null,
      marketingEmailCount: Number(row.marketingEmailCount),
    };
    for (let d = 0; d <= days; d++) {
      const when = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
      const decision = nudgeDecision(candidate, when);
      if (decision.send) {
        out.push({
          name: row.firstName,
          email: row.email ?? "",
          dueOn: when.toISOString().slice(0, 10),
          nudgeNumber: decision.nudgeNumber,
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

export interface DigestData {
  weekStart: string;
  weekEnd: string;
  emailStats: Array<{ emailType: string; delivered: number; failed: number; other: number }>;
  totalSent: number;
  failures: Array<{ when: string; recipient: string; emailType: string; error: string; suppressed: boolean }>;
  quietFailures: number;
  nudges: UpcomingNudge[];
  health: HealthFindings;
  totals: Awaited<ReturnType<typeof db.ownerTotals>>;
}

export async function collectDigest(now: Date = new Date()): Promise<DigestData> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [statRows, failureRows, nudges, health, totals] = await Promise.all([
    db.emailStatsSince(since),
    db.emailFailuresSince(since),
    upcomingNudges(7, now),
    runHealthCheck(now),
    db.ownerTotals(),
  ]);

  const byType = new Map<string, { emailType: string; delivered: number; failed: number; other: number }>();
  for (const row of statRows) {
    const key = row.emailType ?? "other";
    const entry = byType.get(key) ?? { emailType: key, delivered: 0, failed: 0, other: 0 };
    const count = Number(row.count);
    if (row.outcome === "delivered") entry.delivered += count;
    else if (row.outcome === "error") entry.failed += count;
    else entry.other += count;
    byType.set(key, entry);
  }
  const emailStats = Array.from(byType.values()).sort(
    (a, b) => b.delivered + b.failed - (a.delivered + a.failed)
  );

  return {
    weekStart: fmtDate(since),
    weekEnd: fmtDate(now),
    emailStats,
    totalSent: emailStats.reduce((n, s) => n + s.delivered + s.failed + s.other, 0),
    failures: failureRows.map(f => ({
      when: fmtDate(f.createdAt),
      recipient: f.recipient ?? "(no address)",
      emailType: f.emailType,
      error: f.errorText ?? (f.outcome === "log_only" ? "no SMTP configured — logged only" : "unknown"),
      suppressed: Boolean(f.alertSuppressed) && !f.alertSentAt,
    })),
    quietFailures: failureRows.filter(f => Boolean(f.alertSuppressed) && !f.alertSentAt).length,
    nudges,
    health,
    totals,
  };
}

/** The digest as plain text. Written to be read on a phone, in one pass. */
export function formatDigest(d: DigestData): { subject: string; body: string } {
  const L: string[] = [];
  L.push(`GRAPEFRUIT CLEANING CO. — WEEKLY REPORT`);
  L.push(`${d.weekStart} to ${d.weekEnd}`);
  L.push(``);

  L.push(`THE BOOKS`);
  L.push(`  Bookings all time:      ${d.totals.bookings}`);
  L.push(`  Upcoming on calendar:   ${d.totals.upcomingBookings}`);
  L.push(`  Customers:              ${d.totals.customers}`);
  L.push(`  Unpaid invoices:        ${d.totals.unpaidInvoices} totalling $${d.totals.unpaidTotal}`);
  L.push(``);

  L.push(`EMAIL THIS WEEK (${d.totalSent} total)`);
  if (d.emailStats.length === 0) {
    L.push(`  Nothing sent this week.`);
  } else {
    for (const s of d.emailStats) {
      const bits = [`${s.delivered} delivered`];
      if (s.failed > 0) bits.push(`${s.failed} FAILED`);
      if (s.other > 0) bits.push(`${s.other} other`);
      L.push(`  ${s.emailType.padEnd(24)} ${bits.join(", ")}`);
    }
  }
  L.push(``);

  if (d.failures.length > 0) {
    L.push(`FAILURES (${d.failures.length})`);
    if (d.quietFailures > 0) {
      L.push(`  ${d.quietFailures} of these never raised an alert at the time —`);
      L.push(`  the hourly cap swallowed them. They are listed here for that reason.`);
    }
    for (const f of d.failures) {
      L.push(`  • ${f.when} — ${f.emailType} to ${f.recipient}`);
      L.push(`    ${f.error}${f.suppressed ? "  [no alert sent at the time]" : ""}`);
    }
    L.push(``);
  } else {
    L.push(`FAILURES`);
    L.push(`  None. Every email this week was accepted by the mail server.`);
    L.push(``);
  }

  L.push(`RE-BOOKING INVITATIONS DUE IN THE NEXT 7 DAYS (${d.nudges.length})`);
  if (d.nudges.length === 0) {
    L.push(`  Nobody is due. Customers become eligible ${FIRST_NUDGE_DAYS} days after their`);
    L.push(`  cleaning, then every ${REPEAT_NUDGE_DAYS} days, provided they owe nothing and`);
    L.push(`  have no booking coming up.`);
  } else {
    for (const n of d.nudges) {
      L.push(`  • ${n.dueOn} — ${n.name} (${n.email}) — invitation #${n.nudgeNumber}`);
    }
  }
  L.push(``);

  L.push(`SYSTEM CHECK`);
  L.push(formatHealthFindings(d.health).split("\n").map(l => (l ? `  ${l}` : l)).join("\n"));
  L.push(``);
  L.push(`— Sent automatically every Monday. Reply to this email if anything looks wrong.`);

  const flag = d.health.hasProblems || d.failures.length > 0 ? " — needs a look" : "";
  return {
    subject: `Grapefruit weekly report: ${d.weekEnd}${flag}`,
    body: L.join("\n"),
  };
}

/** Builds and sends the weekly digest through the owner-alert path. */
export async function sendWeeklyDigest(now: Date = new Date()): Promise<DigestData> {
  const data = await collectDigest(now);
  const { subject, body } = formatDigest(data);
  await sendOwnerAlert(subject, body);
  return data;
}
