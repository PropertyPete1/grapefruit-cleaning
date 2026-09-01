import { useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface RescheduleDialogBooking {
  id: number;
  reference: string;
  serviceType: string | null;
  sqft: number | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  status: string;
}

export function RescheduleDialog({ booking, compact = false }: { booking: RescheduleDialogBooking; compact?: boolean }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(booking.scheduledDate ?? "");
  const [time, setTime] = useState(booking.scheduledTime ?? "");
  const [pendingTime, setPendingTime] = useState(booking.scheduledDate != null && booking.scheduledTime == null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setDate(booking.scheduledDate ?? "");
    setTime(booking.scheduledTime ?? "");
    setPendingTime(booking.scheduledDate != null && booking.scheduledTime == null);
    setNote("");
  }, [open, booking.scheduledDate, booking.scheduledTime]);

  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: (booking.serviceType ?? undefined) as never,
      sqft: booking.sqft ?? undefined,
    },
    { enabled: open && !pendingTime && /^\d{4}-\d{2}-\d{2}$/.test(date) }
  );
  const history = trpc.admin.bookingScheduleEvents.useQuery(
    { bookingId: booking.id },
    { enabled: open }
  );

  const move = trpc.admin.rescheduleBooking.useMutation({
    onSuccess: result => {
      utils.admin.bookings.invalidate();
      utils.admin.rescheduleRequests.invalidate();
      utils.staff.schedule.invalidate();
      utils.booking.availability.invalidate();
      toast.success(
        pendingTime
          ? `${booking.reference} moved — time still needs to be set`
          : `${booking.reference} rescheduled and customer notified${result.delivery.cleanerDelivered ? "; cleaner notified" : ""}`
      );
      setOpen(false);
    },
    onError: error => toast.error(error.message || "Could not reschedule this booking"),
  });
  const sendLink = trpc.admin.sendRescheduleLink.useMutation({
    onSuccess: result => toast.success(result.emailSent ? "Reschedule link emailed" : "Link created, but the email was not delivered"),
    onError: error => toast.error(error.message || "Could not send the reschedule link"),
  });

  const canSubmit = date && (pendingTime || time) && booking.status === "confirmed" && !move.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={compact ? "h-8 flex-1 rounded-lg text-xs" : "h-8 rounded-lg text-xs"}>
          <CalendarClock className="mr-1 h-3.5 w-3.5" /> Reschedule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reschedule {booking.reference}</DialogTitle>
          <DialogDescription>
            The same booking, deposit, invoice, price, add-ons, and cleaner assignment carry over. The old slot is released only when this move succeeds.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor={`reschedule-date-${booking.id}`}>New date</Label>
            <Input
              id={`reschedule-date-${booking.id}`}
              type="date"
              min={todayInBookingZone()}
              value={date}
              onChange={event => {
                setDate(event.target.value);
                setTime("");
              }}
              className="mt-1.5 rounded-xl"
            />
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-3">
            <Checkbox
              checked={pendingTime}
              onCheckedChange={checked => {
                setPendingTime(checked === true);
                if (checked) setTime("");
              }}
            />
            <span>
              <span className="block text-sm font-semibold">Date selected; time to be decided</span>
              <span className="block text-xs text-muted-foreground">
                Releases the old slot now and shows this job as unscheduled on the selected day.
              </span>
            </span>
          </label>

          {!pendingTime && date && availability.isLoading && (
            <div className="flex h-10 items-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Checking live availability…
            </div>
          )}
          {!pendingTime && date && availability.data && availability.data.length === 0 && (
            <p className="text-xs text-muted-foreground">Closed that day — choose another date.</p>
          )}
          {!pendingTime && date && availability.data && availability.data.length > 0 && (
            <div>
              <Label className="text-xs font-semibold">New start time</Label>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {availability.data.map(slot => (
                  <button
                    key={slot.time}
                    type="button"
                    disabled={!slot.available}
                    onClick={() => setTime(slot.time)}
                    className={`h-9 rounded-lg border text-xs font-semibold transition-colors ${
                      time === slot.time
                        ? "border-primary bg-primary text-primary-foreground"
                        : slot.available
                          ? "border-border bg-card hover:border-primary/40"
                          : "cursor-not-allowed border-dashed border-border bg-muted text-muted-foreground"
                    }`}
                  >
                    {slot.time}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor={`reschedule-note-${booking.id}`}>Reason or note (optional)</Label>
            <Textarea
              id={`reschedule-note-${booking.id}`}
              value={note}
              onChange={event => setNote(event.target.value)}
              maxLength={2000}
              placeholder="Customer requested tomorrow; exact time to follow"
              className="mt-1.5 min-h-24 rounded-xl"
            />
          </div>

          <Button
            className="w-full rounded-xl"
            disabled={!canSubmit}
            onClick={() => move.mutate({ id: booking.id, date, time: pendingTime ? null : time, note: note || undefined })}
          >
            {move.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {pendingTime ? "Move date — time to follow" : "Confirm new date & time"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full rounded-xl"
            disabled={sendLink.isPending || booking.status !== "confirmed"}
            onClick={() => sendLink.mutate({ bookingId: booking.id })}
          >
            {sendLink.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Email customer a request link
          </Button>
          <div className="border-t border-border pt-4">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Schedule history</p>
            {history.isLoading ? (
              <p className="mt-2 text-xs text-muted-foreground">Loading history…</p>
            ) : history.data && history.data.length > 0 ? (
              <div className="mt-2 space-y-2">
                {history.data.map(event => (
                  <div key={event.id} className="rounded-xl bg-muted/40 p-3 text-xs">
                    <p className="font-semibold text-foreground">
                      {event.fromDate ?? "No date"} {event.fromTime ?? "time TBD"} → {event.toDate} {event.toTime ?? "time TBD"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {event.actorLabel || event.actorType} · {new Date(event.createdAt).toLocaleString()}
                    </p>
                    {event.note && <p className="mt-1 text-muted-foreground">{event.note}</p>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No schedule changes recorded yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
