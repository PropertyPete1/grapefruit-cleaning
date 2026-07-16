import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, SERVICE_LABELS, StatusBadge, fmtDate, fmtMoney } from "./adminShared";

const STATUSES = ["pending_deposit", "confirmed", "in_progress", "completed", "cancelled"] as const;

export default function AdminAppointments() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const utils = trpc.useUtils();
  const bookings = trpc.admin.bookings.useQuery(
    statusFilter === "all" ? {} : { status: statusFilter as (typeof STATUSES)[number] }
  );
  const employees = trpc.admin.employees.useQuery();
  const updateStatus = trpc.admin.updateBookingStatus.useMutation({
    onSuccess: () => {
      utils.admin.bookings.invalidate();
      utils.admin.stats.invalidate();
      toast.success("Booking status updated");
    },
    onError: () => toast.error("Failed to update status"),
  });
  const assign = trpc.admin.assignEmployee.useMutation({
    onSuccess: () => {
      utils.admin.bookings.invalidate();
      toast.success("Cleaner assigned");
    },
    onError: () => toast.error("Failed to assign cleaner"),
  });

  return (
    <div>
      <PageHeader
        title="Appointments"
        subtitle="Manage every booking from deposit to completion"
        action={
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44 rounded-xl bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {bookings.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (bookings.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">No bookings found for this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Reference</th>
                  <th className="px-5 py-3 font-medium">Service</th>
                  <th className="px-5 py-3 font-medium">Date & time</th>
                  <th className="px-5 py-3 font-medium">Address</th>
                  <th className="px-5 py-3 font-medium">Total / Deposit</th>
                  <th className="px-5 py-3 font-medium">Cleaner</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(bookings.data ?? []).map(b => (
                  <tr key={b.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-3.5 font-mono text-xs font-semibold text-primary">{b.reference}</td>
                    <td className="px-5 py-3.5">
                      {SERVICE_LABELS[b.serviceType] ?? b.serviceType}
                      <span className="block text-xs text-muted-foreground">{b.frequency}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      {fmtDate(b.scheduledDate)}
                      <span className="block text-xs text-muted-foreground">{b.scheduledTime}</span>
                    </td>
                    <td className="max-w-44 truncate px-5 py-3.5 text-xs text-muted-foreground">
                      {b.addressLine}, {b.city}
                      {b.sqftMismatch ? (
                        <span
                          className="mt-1 block w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                          title={`Customer-entered size was lower — price corrected to verified ${b.verifiedSqft?.toLocaleString() ?? "?"} sq ft from county records`}
                        >
                          Sqft corrected · {b.verifiedSqft?.toLocaleString()} ft² verified
                        </span>
                      ) : b.verifiedSqft ? (
                        <span
                          className="mt-1 block w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800"
                          title="Square footage matched public county records"
                        >
                          {b.verifiedSqft.toLocaleString()} ft² verified
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-semibold">{fmtMoney(b.totalAmount)}</span>
                      <span className="block text-xs text-muted-foreground">dep. {fmtMoney(b.depositAmount)}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <Select
                        value={b.employeeId ? String(b.employeeId) : "none"}
                        onValueChange={v =>
                          assign.mutate({ bookingId: b.id, employeeId: v === "none" ? null : Number(v) })
                        }
                      >
                        <SelectTrigger className="h-8 w-32 rounded-lg text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {(employees.data ?? []).map(e => (
                            <SelectItem key={e.id} value={String(e.id)}>
                              {e.firstName} {e.lastName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-5 py-3.5">
                      <Select
                        value={b.status}
                        onValueChange={v => updateStatus.mutate({ id: b.id, status: v as (typeof STATUSES)[number] })}
                      >
                        <SelectTrigger className="h-8 w-36 rounded-lg text-xs">
                          <SelectValue>
                            <StatusBadge status={b.status} />
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {STATUSES.map(s => (
                            <SelectItem key={s} value={s} className="capitalize">
                              {s.replace(/_/g, " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
