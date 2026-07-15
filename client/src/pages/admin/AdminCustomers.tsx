import { useState } from "react";
import { Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader, SERVICE_LABELS, StatusBadge, fmtDate, fmtMoney } from "./adminShared";

export default function AdminCustomers() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const customers = trpc.admin.customers.useQuery({ search: search || undefined });
  const detail = trpc.admin.customerDetail.useQuery(
    { id: selectedId ?? 0 },
    { enabled: selectedId !== null }
  );

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Your client base with full booking history"
        action={
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search customers…"
              className="w-64 rounded-xl bg-card pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        }
      />

      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {customers.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (customers.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No customers yet. They'll appear here when bookings are made.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Name</th>
                  <th className="px-6 py-3 font-medium">Email</th>
                  <th className="px-6 py-3 font-medium">Phone</th>
                  <th className="px-6 py-3 font-medium">City</th>
                  <th className="px-6 py-3 font-medium">Language</th>
                  <th className="px-6 py-3 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {(customers.data ?? []).map(c => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-6 py-3.5 font-medium text-foreground">
                      {c.firstName} {c.lastName}
                    </td>
                    <td className="px-6 py-3.5 text-muted-foreground">{c.email}</td>
                    <td className="px-6 py-3.5 text-muted-foreground">{c.phone ?? "—"}</td>
                    <td className="px-6 py-3.5 text-muted-foreground">{c.city ?? "—"}</td>
                    <td className="px-6 py-3.5">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold uppercase">
                        {c.preferredLocale}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-muted-foreground">
                      {new Date(c.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={selectedId !== null} onOpenChange={open => !open && setSelectedId(null)}>
        <DialogContent className="max-w-2xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail.data ? `${detail.data.customer.firstName} ${detail.data.customer.lastName}` : "Customer"}
            </DialogTitle>
          </DialogHeader>
          {detail.isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : detail.data ? (
            <div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-muted/50 p-3 text-sm">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="font-medium">{detail.data.customer.email}</p>
                </div>
                <div className="rounded-xl bg-muted/50 p-3 text-sm">
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="font-medium">{detail.data.customer.phone ?? "—"}</p>
                </div>
                <div className="rounded-xl bg-muted/50 p-3 text-sm sm:col-span-2">
                  <p className="text-xs text-muted-foreground">Address</p>
                  <p className="font-medium">
                    {[detail.data.customer.address, detail.data.customer.city, detail.data.customer.zip]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </p>
                </div>
              </div>
              <h3 className="mt-5 text-sm font-semibold text-foreground">Booking history</h3>
              <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                {detail.data.bookings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No bookings yet.</p>
                ) : (
                  detail.data.bookings.map(b => (
                    <div key={b.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                      <div>
                        <span className="font-mono text-xs font-semibold text-primary">{b.reference}</span>
                        <p className="font-medium">{SERVICE_LABELS[b.serviceType] ?? b.serviceType}</p>
                        <p className="text-xs text-muted-foreground">
                          {fmtDate(b.scheduledDate)} · {b.scheduledTime}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{fmtMoney(b.totalAmount)}</p>
                        <StatusBadge status={b.status} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

