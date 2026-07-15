import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SERVICE_LABELS, StatusBadge } from "./adminShared";

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function AdminCalendar() {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const from = `${ym(month)}-01`;
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const to = `${ym(month)}-${String(lastDay).padStart(2, "0")}`;

  const bookings = trpc.admin.bookings.useQuery({ from, to });

  const byDate = useMemo(() => {
    const map: Record<string, NonNullable<typeof bookings.data>> = {};
    for (const b of bookings.data ?? []) {
      (map[b.scheduledDate] ||= []).push(b);
    }
    return map;
  }, [bookings.data]);

  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: lastDay }, (_, i) => i + 1),
  ];
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Monthly schedule of all appointments"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl bg-card"
              onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="w-40 text-center font-semibold text-foreground">
              {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl bg-card"
              onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {bookings.isLoading ? (
        <Skeleton className="h-[480px] w-full rounded-2xl" />
      ) : (
        <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-border">
          <div className="grid grid-cols-7 border-b border-border bg-muted/40 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
              <div key={d} className="py-2.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const dateStr = day ? `${ym(month)}-${String(day).padStart(2, "0")}` : "";
              const dayBookings = day ? (byDate[dateStr] ?? []) : [];
              return (
                <div
                  key={i}
                  className={`min-h-24 border-b border-r border-border/60 p-1.5 last:border-r-0 ${
                    dateStr === todayStr ? "bg-primary/5" : ""
                  }`}
                >
                  {day && (
                    <>
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                          dateStr === todayStr ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {day}
                      </span>
                      <div className="mt-1 space-y-1">
                        {dayBookings.slice(0, 3).map(b => (
                          <div
                            key={b.id}
                            className="truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                            title={`${b.reference} · ${SERVICE_LABELS[b.serviceType]} · ${b.scheduledTime}`}
                          >
                            {b.scheduledTime} {SERVICE_LABELS[b.serviceType]}
                          </div>
                        ))}
                        {dayBookings.length > 3 && (
                          <p className="px-1 text-[10px] text-muted-foreground">+{dayBookings.length - 3} more</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upcoming list */}
      <div className="mt-6 rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
        <h2 className="font-semibold text-foreground">This month's appointments</h2>
        {(bookings.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No appointments scheduled this month.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {(bookings.data ?? [])
              .slice()
              .sort((a, b) => (a.scheduledDate + a.scheduledTime).localeCompare(b.scheduledDate + b.scheduledTime))
              .map(b => (
                <div key={b.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                  <div>
                    <span className="font-mono text-xs font-semibold text-primary">{b.reference}</span>
                    <p className="font-medium text-foreground">{SERVICE_LABELS[b.serviceType]}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground">
                      {b.scheduledDate} · {b.scheduledTime}
                    </p>
                    <StatusBadge status={b.status} />
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
