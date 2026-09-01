import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { todayInBookingZone } from "@shared/leadTime";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fmtDate } from "./adminShared";
import type { AppRouter } from "../../../../server/routers";

type RequestRow = inferRouterOutputs<AppRouter>["admin"]["rescheduleRequests"][number];

function CounterDialog({ row, refresh }: { row: RequestRow; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(row.request.proposedDate);
  const [time, setTime] = useState(row.request.proposedTime);
  const [pendingTime, setPendingTime] = useState(false);
  const [note, setNote] = useState("");
  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: (row.booking.serviceType ?? undefined) as never,
      sqft: row.booking.sqft ?? undefined,
    },
    { enabled: open && !pendingTime && /^\d{4}-\d{2}-\d{2}$/.test(date) }
  );
  const counter = trpc.admin.counterRescheduleRequest.useMutation({
    onSuccess: result => {
      toast.success(result.emailSent ? "Counter emailed to customer" : "Counter saved; email was not delivered");
      setOpen(false);
      refresh();
    },
    onError: error => toast.error(error.message || "Could not send counter"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Counter</Button></DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Counter {row.booking.reference}</DialogTitle>
          <DialogDescription>The booking does not move until the customer accepts this option.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Proposed date</Label>
            <Input type="date" min={todayInBookingZone()} value={date} onChange={event => { setDate(event.target.value); setTime(""); }} />
          </div>
          <label className="flex items-start gap-3 rounded-xl border border-border p-3">
            <Checkbox checked={pendingTime} onCheckedChange={checked => { setPendingTime(checked === true); if (checked) setTime(""); }} />
            <span>
              <span className="block text-sm font-semibold">Date only; time to follow</span>
              <span className="block text-xs text-muted-foreground">Customer accepts the date while the start time stays pending.</span>
            </span>
          </label>
          {!pendingTime && availability.isLoading && <p className="text-xs text-muted-foreground">Checking availability…</p>}
          {!pendingTime && availability.data && (
            <div className="grid grid-cols-4 gap-1.5">
              {availability.data.map(slot => (
                <button
                  key={slot.time}
                  type="button"
                  disabled={!slot.available}
                  onClick={() => setTime(slot.time)}
                  className={`h-9 rounded-lg border text-xs font-semibold ${time === slot.time ? "border-primary bg-primary text-primary-foreground" : slot.available ? "bg-card" : "cursor-not-allowed border-dashed bg-muted text-muted-foreground"}`}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          )}
          <div>
            <Label>Note (optional)</Label>
            <Textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} className="mt-1.5 min-h-24" />
          </div>
          <Button
            className="w-full"
            disabled={!date || (!pendingTime && !time) || counter.isPending}
            onClick={() => counter.mutate({ requestId: row.request.id, date, time: pendingTime ? null : time, note: note || undefined })}
          >
            {counter.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send counter
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RescheduleRequestsPanel() {
  const utils = trpc.useUtils();
  const requests = trpc.admin.rescheduleRequests.useQuery();
  const open = (requests.data ?? []).filter(row => row.request.status === "pending" || row.request.status === "countered");
  const refresh = () => {
    utils.admin.rescheduleRequests.invalidate();
    utils.admin.bookings.invalidate();
    utils.staff.schedule.invalidate();
    utils.booking.availability.invalidate();
  };
  const approve = trpc.admin.approveRescheduleRequest.useMutation({
    onSuccess: () => { toast.success("Request approved; customer and assigned cleaner notified"); refresh(); },
    onError: error => toast.error(error.message || "Could not approve request"),
  });
  const decline = trpc.admin.declineRescheduleRequest.useMutation({
    onSuccess: () => { toast.success("Request declined; customer notified"); refresh(); },
    onError: error => toast.error(error.message || "Could not decline request"),
  });

  if (requests.isLoading || open.length === 0) return null;

  return (
    <Card className="mb-5 border-amber-200 bg-amber-50/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-amber-950">
          <CalendarClock className="h-4 w-4" /> Reschedule requests ({open.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {open.map(row => (
          <div key={row.request.id} className="rounded-xl border border-amber-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{row.customer ? `${row.customer.firstName} ${row.customer.lastName}`.trim() : "Customer"} · {row.booking.reference}</p>
                <p className="text-sm text-muted-foreground">
                  Current: {row.booking.scheduledDate ? fmtDate(row.booking.scheduledDate) : "No date"}
                  {row.booking.scheduledTime ? ` at ${row.booking.scheduledTime}` : " · time to be decided"}
                </p>
                <p className="mt-1 text-sm font-semibold text-amber-900">
                  Requested: {fmtDate(row.request.proposedDate)} at {row.request.proposedTime}
                </p>
                {row.request.customerNote && <p className="mt-1 text-sm">“{row.request.customerNote}”</p>}
                {row.request.status === "countered" && row.request.counterDate && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Counter waiting for customer: {fmtDate(row.request.counterDate)}{row.request.counterTime ? ` at ${row.request.counterTime}` : " · time to be decided"}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {row.request.status === "pending" && (
                  <Button
                    size="sm"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate({ requestId: row.request.id })}
                  >
                    Approve
                  </Button>
                )}
                <CounterDialog row={row} refresh={refresh} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decline.isPending}
                  onClick={() => decline.mutate({ requestId: row.request.id })}
                >
                  Decline
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
