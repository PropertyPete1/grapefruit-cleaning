/**
 * Admin → Calendar → tap a day: every booking on that date, scannable without
 * opening each one — who, what, where, when, how much, whether it's paid, its
 * status, and the customer's notes — plus the one action a day view needs, a
 * new booking with the date already chosen.
 *
 * Reads the same admin.bookings rows the month grid renders, so nothing here
 * can disagree with the chip the owner just tapped. Airbnb work is marked in
 * its own colour, exactly as on the grid.
 */
import { Phone, Plus } from "lucide-react";
import { formatJobSpan } from "@shared/availability";
import { isAirbnbBooking } from "@shared/bookingStatus";
import type { BookingPaymentStatus } from "@shared/paymentStatus";
import { composeAddressOr } from "@shared/property";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AirbnbBadge, NotesBlock, PaymentStatusBadge, SERVICE_LABELS, StatusBadge, fmtMoney } from "./adminShared";
import { longDateLabel, sortDayBookings } from "./calendarDay";
import { RescheduleDialog } from "./RescheduleDialog";

/** The admin.bookings row fields the panel reads — a structural subset. */
export interface CalendarBooking {
  id: number;
  reference: string;
  kind: string;
  status: string;
  serviceType: string | null;
  sqft: number | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  /** Hours on site, resolved server-side. */
  durationHours: number;
  addressLine: string | null;
  unitNumber: string | null;
  city: string | null;
  totalAmount: number;
  notes: string | null;
  customerName: string;
  customerPhone: string | null;
  paymentStatus: BookingPaymentStatus;
  slotConflict?: boolean;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function CalendarDayPanel({
  date,
  bookings,
  onClose,
  onNewBooking,
}: {
  date: string;
  bookings: CalendarBooking[];
  onClose: () => void;
  /** Absent for a day in the past — nothing can be booked there. */
  onNewBooking?: () => void;
}) {
  const sorted = sortDayBookings(bookings);
  const airbnbCount = sorted.filter(isAirbnbBooking).length;
  const summary =
    sorted.length === 0
      ? "No bookings on this day."
      : `${sorted.length} booking${sorted.length === 1 ? "" : "s"}${airbnbCount ? ` · ${airbnbCount} Airbnb` : ""}`;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="calendar-day-panel">
        <DialogHeader>
          <DialogTitle>{longDateLabel(date)}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        {sorted.length === 0 ? (
          <p className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
            {onNewBooking ? "Nothing scheduled yet — add a booking below." : "Nothing was scheduled on this day."}
          </p>
        ) : (
          <ul className="space-y-3">
            {sorted.map(b => {
              const airbnb = isAirbnbBooking(b);
              return (
                <li
                  key={b.id}
                  className={`rounded-xl border p-3 ${airbnb ? "border-violet-200 bg-violet-50/40" : "border-border"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {b.scheduledTime ? formatJobSpan(b.scheduledTime, b.durationHours) : "Time to be decided"}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
                        <span className="font-medium">
                          {b.serviceType ? (SERVICE_LABELS[b.serviceType] ?? b.serviceType) : "Service TBD"}
                        </span>
                        {airbnb && <AirbnbBadge auto={b.kind === "ical_auto"} />}
                        {b.slotConflict && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                            ⚠ Slot conflict
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-sm font-semibold text-foreground">{fmtMoney(b.totalAmount)}</span>
                      <PaymentStatusBadge status={b.paymentStatus} />
                      <StatusBadge status={b.status} />
                    </div>
                  </div>
                  <dl className="mt-2 space-y-1 text-xs">
                    <Row
                      label="Customer"
                      value={
                        <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                          <span>{b.customerName || "—"}</span>
                          {b.customerPhone && (
                            <a
                              href={`tel:${b.customerPhone.replace(/[^\d+]/g, "")}`}
                              className="inline-flex items-center gap-1 text-primary underline"
                            >
                              <Phone className="h-3 w-3" /> {b.customerPhone}
                            </a>
                          )}
                        </span>
                      }
                    />
                    <Row label="Address" value={composeAddressOr(b, "No address yet")} />
                    <Row label="Reference" value={<span className="font-mono">{b.reference}</span>} />
                  </dl>
                  {b.notes && <NotesBlock notes={b.notes} className="mt-2" />}
                  {b.status === "confirmed" && (
                    <div className="mt-2">
                      <RescheduleDialog booking={b} compact />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter sticky>
          <Button variant="outline" className="rounded-xl" onClick={onClose}>
            Close
          </Button>
          {onNewBooking && (
            <Button className="rounded-xl" onClick={onNewBooking}>
              <Plus className="mr-1.5 h-4 w-4" /> New booking on this day
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
