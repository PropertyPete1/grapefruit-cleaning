/**
 * Place an auto-booked turnover by hand — the [ACTION NEEDED] path when the
 * sync found no slot, and the recovery for any auto booking the owner wants
 * moved. Times come from the same availability query the calendars use;
 * slots inside the notice window are offered (these are operational
 * placements, lead-time-exempt like the sync itself), everything physical is
 * enforced again server-side.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2 } from "lucide-react";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
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

export function SetTimeDialog({
  bookingId,
  reference,
  serviceType,
  sqft,
  currentDate,
}: {
  bookingId: number;
  reference: string;
  serviceType: string | null;
  sqft: number | null;
  currentDate: string | null;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(currentDate ?? "");
  const [time, setTime] = useState("");

  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: (serviceType ?? undefined) as never,
      sqft: sqft ?? undefined,
    },
    { enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(date) }
  );

  const schedule = trpc.admin.scheduleBooking.useMutation({
    onSuccess: () => {
      utils.admin.bookings.invalidate();
      utils.admin.properties.invalidate();
      toast.success(`${reference} placed — the turnover is covered`);
      setOpen(false);
    },
    onError: error => toast.error(error.message || "Couldn't place it there"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 rounded-lg border-red-300 px-2 text-[11px] text-red-700">
          <CalendarClock className="mr-1 h-3 w-3" /> Set time
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Place {reference}</DialogTitle>
          <DialogDescription>
            An auto-booked turnover with no time yet. Greyed slots are inside the notice window — still fine for
            an operational placement; the server re-checks everything physical.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs font-semibold">Date</Label>
            <Input
              type="date"
              className="mt-1.5 rounded-xl"
              min={todayInBookingZone()}
              value={date}
              onChange={e => {
                setDate(e.target.value);
                setTime("");
              }}
            />
          </div>
          {date && availability.isLoading && (
            <div className="flex h-10 items-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Checking availability…
            </div>
          )}
          {date && availability.data && availability.data.length === 0 && (
            <p className="text-xs text-muted-foreground">Closed that day — pick another date.</p>
          )}
          {date && availability.data && availability.data.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {availability.data.map(slot => (
                <button
                  key={slot.time}
                  type="button"
                  onClick={() => setTime(slot.time)}
                  className={`h-9 rounded-lg border text-xs font-semibold transition-colors ${
                    time === slot.time
                      ? "border-primary bg-primary text-primary-foreground"
                      : slot.available
                        ? "border-border bg-card hover:border-primary/40"
                        : "border-dashed border-amber-400 bg-amber-50 text-amber-800"
                  }`}
                  title={slot.available ? undefined : "Inside the notice window — allowed for operational placement"}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          )}
          <Button
            className="w-full rounded-xl"
            disabled={!date || !time || schedule.isPending}
            onClick={() => schedule.mutate({ id: bookingId, date, time })}
          >
            {schedule.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Place turnover
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
