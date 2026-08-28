/**
 * Admin → Email log: the last 50 outbound send attempts and what actually
 * happened to each one.
 *
 * This page exists to answer one question without asking anyone: "did the
 * customer get it?" Production console logs roll off after about an hour, so
 * every attempt is recorded in the database as it happens — including the
 * failures, which is the half that used to be invisible.
 */
import { AlertTriangle, CheckCircle2, FileWarning, Mail, MinusCircle, Send } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "./adminShared";

type Outcome = "delivered" | "log_only" | "error" | "skipped";

const OUTCOME_META: Record<Outcome, { label: string; hint: string; className: string; Icon: typeof Mail }> = {
  delivered: {
    label: "Delivered",
    hint: "The mail server accepted it",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    Icon: CheckCircle2,
  },
  error: {
    label: "Failed",
    hint: "The mail server rejected it",
    className: "bg-red-50 text-red-700 ring-red-200",
    Icon: AlertTriangle,
  },
  log_only: {
    label: "Not sent",
    hint: "No mailbox configured — written to the server log instead",
    className: "bg-amber-50 text-amber-700 ring-amber-200",
    Icon: FileWarning,
  },
  skipped: {
    label: "No address",
    hint: "This customer has no email on file",
    className: "bg-muted text-muted-foreground ring-border",
    Icon: MinusCircle,
  },
};

/** "balance_reminder_1" reads as "Balance reminder 1" without a lookup table. */
function prettyType(raw: string): string {
  const spaced = raw.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const meta = OUTCOME_META[outcome as Outcome] ?? OUTCOME_META.skipped;
  const { Icon } = meta;
  return (
    <span
      title={meta.hint}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${meta.className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

export default function AdminEmailLog() {
  // Refetched on focus: the common use is sending something, switching tabs,
  // and coming back to see whether it landed.
  const log = trpc.admin.emailLog.useQuery(undefined, { refetchOnWindowFocus: true });
  const rows = log.data ?? [];
  const failures = rows.filter(r => r.outcome === "error" || r.outcome === "log_only").length;

  // The weekly report normally arrives on Monday by itself. This button is for
  // wanting it now — and it doubles as a way to confirm the reporting path
  // still works, rather than waiting a week to discover it doesn't.
  const utils = trpc.useUtils();
  const smtp = trpc.admin.smtpDiagnostics.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
  });
  const sendDiagnostic = trpc.admin.sendSmtpDiagnostic.useMutation({
    onSuccess: result => {
      toast[result.ok ? "success" : "error"](
        result.ok ? "Production SMTP accepted the Peter diagnostic" : `Production SMTP rejected the diagnostic: ${result.error ?? "unknown error"}`,
        { duration: 10000 }
      );
      void utils.admin.emailLog.invalidate();
      void utils.admin.smtpDiagnostics.invalidate();
    },
    onError: e => toast.error(`Could not run the production SMTP diagnostic: ${e.message}`, { duration: 10000 }),
  });
  const sendReport = trpc.admin.sendWeeklyDigestNow.useMutation({
    onSuccess: r => {
      toast.success(
        `Report sent — ${r.emailsThisWeek} email${r.emailsThisWeek === 1 ? "" : "s"} this week, ` +
          `${r.upcomingNudges} invitation${r.upcomingNudges === 1 ? "" : "s"} due, ` +
          `${r.problems} problem${r.problems === 1 ? "" : "s"} found`,
        { duration: 8000 }
      );
      void utils.admin.emailLog.invalidate();
    },
    onError: e => toast.error(`Could not send the report: ${e.message}`, { duration: 10000 }),
  });

  return (
    <div>
      <PageHeader
        title="Email log"
        subtitle="Every message the site tried to send, and what the mail server said back"
      />

      <div className="mb-6 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-border">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Production SMTP diagnostics</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Password-safe configuration and a live connection verify from this production process.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => sendDiagnostic.mutate({ to: "peter@lifestyledesignrealty.com" })}
            disabled={sendDiagnostic.isPending}
            className="shrink-0 gap-2 bg-background"
          >
            <Send className="h-4 w-4" />
            {sendDiagnostic.isPending ? "Sending test…" : "Send one test to Peter"}
          </Button>
        </div>

        {smtp.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full rounded-xl" />
        ) : smtp.error ? (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-100">
            Verify failed to run: {smtp.error.message}
          </p>
        ) : smtp.data ? (
          <div className="mt-4 grid gap-2 font-mono text-xs text-muted-foreground sm:grid-cols-2">
            <p>SMTP_HOST={smtp.data.config.env.SMTP_HOST ?? "&lt;unset&gt;"}</p>
            <p>SMTP_PORT={smtp.data.config.env.SMTP_PORT ?? "&lt;unset&gt;"}</p>
            <p>SMTP_USER={smtp.data.config.env.SMTP_USER ?? "&lt;unset&gt;"}</p>
            <p>GMAIL_USER={smtp.data.config.env.GMAIL_USER ?? "&lt;unset&gt;"}</p>
            <p>Effective host={smtp.data.config.effective.host}:{smtp.data.config.effective.port}</p>
            <p>Effective user={smtp.data.config.effective.user ?? "&lt;unset&gt;"}</p>
            <p>Password source={smtp.data.config.env.passwordSource}</p>
            <p>Secure={String(smtp.data.config.effective.secure)}</p>
            <p className={smtp.data.verify.ok ? "text-emerald-700" : "text-red-700"}>
              Verify={smtp.data.verify.ok ? "accepted" : "rejected"}
            </p>
            {smtp.data.verify.error && <p className="break-words text-red-700 sm:col-span-2">Verify error={smtp.data.verify.error}</p>}
          </div>
        ) : null}

        {sendDiagnostic.data && (
          <pre className="mt-4 overflow-x-auto rounded-xl bg-muted p-3 text-xs leading-relaxed text-foreground">
            {JSON.stringify(sendDiagnostic.data, null, 2)}
          </pre>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-border">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Weekly report</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Arrives every Monday: what was sent, what failed, who is due a re-booking invitation, and anything
            inconsistent in the data. Send it now to see the current picture.
          </p>
        </div>
        <Button onClick={() => sendReport.mutate()} disabled={sendReport.isPending} className="shrink-0 gap-2">
          <Send className="h-4 w-4" />
          {sendReport.isPending ? "Sending…" : "Send report now"}
        </Button>
      </div>

      {log.isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl bg-card p-10 text-center text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          No emails recorded yet. Every send from here on is logged — confirmations, reminders, payment links and
          owner alerts.
        </div>
      ) : (
        <>
          {failures > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {failures} of the last {rows.length} messages did not reach the customer. Open the row to see exactly
                what the mail server said.
              </p>
            </div>
          )}

          <div className="space-y-3">
            {rows.map(entry => (
              <div key={entry.id} className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-border sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <OutcomeBadge outcome={entry.outcome} />
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                        {prettyType(entry.emailType)}
                      </span>
                    </div>
                    <p className="mt-2 break-words font-medium text-foreground">{entry.subject}</p>
                    <p className="mt-0.5 break-all text-sm text-muted-foreground">
                      {entry.recipient ?? "No address on file"}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>

                {entry.errorText && (
                  <p className="mt-3 break-words rounded-xl bg-red-50 px-3 py-2 font-mono text-xs leading-relaxed text-red-800 ring-1 ring-red-100">
                    {entry.errorText}
                  </p>
                )}

                {(entry.smtpUser || entry.invoiceId || entry.bookingId) && (
                  <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                    {entry.smtpUser && <span className="break-all">Sent as {entry.smtpUser}</span>}
                    {entry.invoiceId != null && <span>Invoice #{entry.invoiceId}</span>}
                    {entry.bookingId != null && <span>Booking #{entry.bookingId}</span>}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
