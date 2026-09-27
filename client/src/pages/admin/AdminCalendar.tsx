import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatJobSpan, intervalEndTime } from "@shared/availability";
import { holdsCalendarSlot, isAirbnbBooking } from "@shared/bookingStatus";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AIRBNB_CHIP_CLASS, AirbnbBadge, PageHeader, SERVICE_LABELS, StatusBadge, fmtDate } from "./adminShared";
import { CalendarDayPanel } from "./CalendarDayPanel";
import { NewBookingDialog } from "./NewBookingDialog";
import { RescheduleDialog } from "./RescheduleDialog";

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function AdminCalendar() {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  /** The day whose bookings are open in the day panel. */
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  /** The day a new booking is being created for — the date is prefilled. */
  const [newBookingDate, setNewBookingDate] = useState<string | null>(null);

  const from = `${ym(month)}-01`;
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const to = `${ym(month)}-${String(lastDay).padStart(2, "0")}`;

  // onCalendar: cancelled and expired bookings have released their slot and
  // must not be drawn as if the crew were still going. They stay listed on
  // Appointments, which is where history belongs.
  const bookings = trpc.admin.bookings.useQuery({ from, to, onCalendar: true });

  /**
   * Only rows with a slot can sit on a calendar. The date-range filter already
   * excludes slotless links server-side (a NULL date matches no range), and
   * onCalendar already drops released rows — the predicate here makes the
   * types tell the same story, and guards against a stale cache.
   */
  const dated = useMemo(
    () =>
      (bookings.data ?? []).filter(
        (b): b is typeof b & { scheduledDate: string } => b.scheduledDate != null && holdsCalendarSlot(b.status)
      ),
    [bookings.data]
  );

  const byDate = useMemo(() => {
    const map: Record<string, typeof dated> = {};
    for (const b of dated) {
      (map[b.scheduledDate] ||= []).push(b);
    }
    return map;
  }, [dated]);

  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: lastDay }, (_, i) => i + 1),
  ];
  // The business's own today, not the browser's: the owner may be looking at
  // this from another timezone, and "today" is a San Antonio day.
  const todayStr = todayInBookingZone();

  /**
   * Tap a day. An empty future day goes straight to a new booking with the
   * date filled in; a day with bookings opens the day panel (which has its own
   * "new booking on this day" button); a past day opens the panel read-only.
   */
  const openDay = (dateStr: string) => {
    const hasBookings = (byDate[dateStr] ?? []).length > 0;
    if (!hasBookings && dateStr >= todayStr) {
      setNewBookingDate(dateStr);
      return;
    }
    setSelectedDate(dateStr);
  };

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Monthly schedule of all appointments — tap a day to see its bookings or add one"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl bg-card"
              onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              aria-label="Previous month"
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
              aria-label="Next month"
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
              if (!day) {
                return <div key={i} className="min-h-24 border-b border-r border-border/60 last:border-r-0" />;
              }
              return (
                // The whole cell is the target: on a phone a 24px number is
                // not something a thumb can hit, a 100px cell is.
                <button
                  key={i}
                  type="button"
                  onClick={() => openDay(dateStr)}
                  aria-label={`${fmtDate(dateStr)}: ${dayBookings.length} booking${dayBookings.length === 1 ? "" : "s"}`}
                  className={`min-h-24 border-b border-r border-border/60 p-1.5 text-left transition-colors last:border-r-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${
                    dateStr === todayStr ? "bg-primary/5" : ""
                  }`}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      dateStr === todayStr ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {day}
                  </span>
                  <div className="mt-1 space-y-1">
                    {dayBookings.slice(0, 3).map(b => {
                      const airbnb = isAirbnbBooking(b);
                      return (
                        // Airbnb work gets its own violet, everywhere it is drawn.
                        // The rest keeps the coral tint: coral text on a 10% coral
                        // fill measured 2.9:1, under the 4.5:1 floor for text this
                        // small, so accent-foreground — the dark coral paired with
                        // this tint — carries the text. Amber marks a job whose
                        // start time is still to be decided.
                        <div
                          key={b.id}
                          className={`truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium ${airbnb ? AIRBNB_CHIP_CLASS : b.scheduledTime ? "bg-primary/10 text-accent-foreground" : "bg-amber-100 text-amber-900"} ${airbnb && !b.scheduledTime ? "ring-1 ring-amber-400" : ""}`}
                          title={`${b.customerName || b.reference} · ${b.serviceType ? SERVICE_LABELS[b.serviceType] : "Service TBD"} · ${b.scheduledTime ? formatJobSpan(b.scheduledTime, b.durationHours) : "Time to be decided"}`}
                        >
                          {b.scheduledTime ? `${b.scheduledTime}–${intervalEndTime(b.scheduledTime, b.durationHours)}` : "TIME TBD"}{" "}
                          {b.serviceType ? SERVICE_LABELS[b.serviceType] : "Service TBD"}
                        </div>
                      );
                    })}
                    {dayBookings.length > 3 && (
                      <p className="px-1 text-[10px] text-muted-foreground">+{dayBookings.length - 3} more</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-primary/30" /> Cleaning
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-violet-300" /> Airbnb
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-300" /> Time to be decided
            </span>
            <span className="sm:ml-auto">Tap a day to see its bookings or add one.</span>
          </div>
        </div>
      )}

      {/* Upcoming list */}
      <div className="mt-6 rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
        <h2 className="font-semibold text-foreground">This month's appointments</h2>
        {dated.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No appointments scheduled this month.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {dated
              .slice()
              .sort((a, b) => `${a.scheduledDate}${a.scheduledTime ?? "99:99"}`.localeCompare(`${b.scheduledDate}${b.scheduledTime ?? "99:99"}`))
              .map(b => (
                <div key={b.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                  <div>
                    <span className="font-mono text-xs font-semibold text-primary">{b.reference}</span>
                    <p className="flex flex-wrap items-center gap-x-2 font-medium text-foreground">
                      {b.serviceType ? SERVICE_LABELS[b.serviceType] : "Service TBD"}
                      {isAirbnbBooking(b) && <AirbnbBadge auto={b.kind === "ical_auto"} />}
                    </p>
                    {b.customerName && <p className="text-xs text-muted-foreground">{b.customerName}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground">
                      {b.scheduledDate} · {b.scheduledTime ? formatJobSpan(b.scheduledTime, b.durationHours) : "Time to be decided"}
                    </p>
                    <StatusBadge status={b.status} />
                    {b.status === "confirmed" && <div className="mt-2"><RescheduleDialog booking={b} /></div>}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {selectedDate && (
        <CalendarDayPanel
          date={selectedDate}
          bookings={byDate[selectedDate] ?? []}
          onClose={() => setSelectedDate(null)}
          onNewBooking={
            selectedDate >= todayStr
              ? () => {
                  setSelectedDate(null);
                  setNewBookingDate(selectedDate);
                }
              : undefined
          }
        />
      )}

      {newBookingDate && (
        // Keyed by date so a second day opens a fresh form with its own date.
        <NewBookingDialog
          key={newBookingDate}
          initialDate={newBookingDate}
          open
          onOpenChange={open => {
            if (!open) setNewBookingDate(null);
          }}
          trigger={false}
        />
      )}
    </div>
  );
}
