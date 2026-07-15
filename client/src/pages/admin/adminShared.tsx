import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export const STATUS_STYLES: Record<string, string> = {
  pending_deposit: "bg-amber-100 text-amber-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-slate-200 text-slate-700",
  cancelled: "bg-red-100 text-red-600",
  new: "bg-amber-100 text-amber-700",
  replied: "bg-emerald-100 text-emerald-700",
  archived: "bg-slate-200 text-slate-600",
  draft: "bg-slate-200 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-emerald-100 text-emerald-700",
  overdue: "bg-red-100 text-red-600",
  void: "bg-slate-200 text-slate-500",
  succeeded: "bg-emerald-100 text-emerald-700",
  refunded: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-600",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export const SERVICE_LABELS: Record<string, string> = {
  residential: "Residential",
  commercial: "Commercial",
  airbnb: "Airbnb",
  moveinout: "Move In/Out",
  deep: "Deep Clean",
  office: "Office",
};

export function fmtMoney(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString()}`;
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(`${d}T00:00:00`) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

