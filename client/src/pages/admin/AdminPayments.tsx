import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, StatusBadge, fmtMoney } from "./adminShared";

export default function AdminPayments() {
  const payments = trpc.admin.payments.useQuery();

  return (
    <div>
      <PageHeader title="Payments" subtitle="Every deposit and payment recorded through Stripe" />
      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {payments.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (payments.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No payments yet. Deposits paid through the booking flow will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Booking</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Method</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(payments.data ?? []).map(p => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-6 py-3.5 text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-3.5">{p.bookingId ? `#${p.bookingId}` : "—"}</td>
                    <td className="px-6 py-3.5 capitalize">{p.kind}</td>
                    <td className="px-6 py-3.5 capitalize text-muted-foreground">{p.method}</td>
                    <td className="px-6 py-3.5 font-semibold">{fmtMoney(p.amount)}</td>
                    <td className="px-6 py-3.5">
                      <StatusBadge status={p.status} />
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
