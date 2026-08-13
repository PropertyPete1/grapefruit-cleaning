import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** True while `ref`'s content is wider than the element itself. */
function useHasOverflow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return overflowing;
}

/**
 * A table that stays a table on phones, scrolling inside its own card rather
 * than pushing the page sideways. The hint only appears when there is actually
 * more to see.
 */
export function ScrollableTable({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const overflowing = useHasOverflow(ref);
  return (
    <>
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
      {overflowing && (
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground lg:hidden">
          Swipe the table sideways to see more →
        </p>
      )}
    </>
  );
}

/**
 * Data table on desktop, stacked cards on phones.
 *
 * A six-column table can't be read on a 390px screen, and letting it scroll
 * sideways hides the status and action columns that matter most. Below lg each
 * row becomes a card instead. The table markup is passed through untouched and
 * still renders inside its scroll container at lg and up, so desktop layouts
 * are unchanged.
 */
export function TableOrCards({ table, cards }: { table: ReactNode; cards: ReactNode }) {
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">{table}</div>
      <div className="divide-y divide-border lg:hidden">{cards}</div>
    </>
  );
}

/**
 * One record as a phone-friendly card: who/when on the left, amount and status
 * on the right, the long tail of fields behind a "Details" toggle, and any
 * controls kept at full width where a thumb can reach them.
 */
export function RowCard({
  title,
  subtitle,
  badge,
  amount,
  details,
  note,
  actions,
  onClick,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  amount?: ReactNode;
  /** Secondary fields, revealed on tap. */
  details?: { label: string; value: ReactNode }[];
  /**
   * Full-width block shown under the details, for content the label/value grid
   * would squash — customer notes, above all.
   */
  note?: ReactNode;
  /** Always-visible controls (selects, buttons). */
  actions?: ReactNode;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean((details && details.length > 0) || note);

  return (
    <div className="px-4 py-3.5">
      <div
        className={onClick ? "-m-1 cursor-pointer rounded-lg p-1 active:bg-muted/60" : undefined}
        onClick={onClick}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium text-foreground">{title}</div>
            {subtitle && <div className="mt-0.5 break-words text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {amount && <span className="text-sm font-semibold text-foreground">{amount}</span>}
            {badge}
          </div>
        </div>
      </div>

      {hasDetails && (
        <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            {open ? "Hide details" : "Details"}
          </button>
          {open && (
            <div className="mt-2 space-y-2">
              {details && details.length > 0 && (
                <dl className="space-y-1.5 rounded-xl bg-muted/50 p-3 text-xs">
                  {details.map(d => (
                    <div key={d.label} className="flex justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{d.label}</dt>
                      <dd className="min-w-0 break-words text-right font-medium text-foreground">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {note}
            </div>
          )}
        </>
      )}

      {actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * What the customer wrote when they booked — door codes, gate instructions,
 * "the dog is friendly, leave the side gate shut".
 *
 * Deliberately louder than the fields around it. This is the one piece of a
 * booking an admin cannot afford to skim past, and it used to render nowhere in
 * the admin dashboard at all. Quoted and italic like the staff job card, on the
 * amber the dashboard already uses for "look at this".
 */
export function NotesBlock({ notes, className = "" }: { notes: string; className?: string }) {
  return (
    <div className={`rounded-xl bg-amber-50 p-2.5 text-left ring-1 ring-amber-200 ${className}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Customer notes</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs font-normal italic text-amber-900">
        “{notes}”
      </p>
    </div>
  );
}

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
  expired: "bg-slate-200 text-slate-500",
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

