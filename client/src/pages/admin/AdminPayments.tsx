import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, RowCard, StatusBadge, TableOrCards, fmtMoney } from "./adminShared";
import { centsToDollars } from "@shared/money";

function paymentAmount(payment: { amount: number; amountCents: number | null }) {
  return centsToDollars(payment.amountCents ?? payment.amount * 100);
}

function paymentDate(payment: { source: "stripe" | "offline"; receivedOn: string | null; createdAt: Date }) {
  return payment.source === "offline" && payment.receivedOn
    ? new Date(`${payment.receivedOn}T12:00:00Z`)
    : new Date(payment.createdAt);
}

export default function AdminPayments() {
  const payments = trpc.admin.payments.useQuery();

  return (
    <div>
      <PageHeader title="Payments" subtitle="Stripe and offline collections, with a complete audit trail" />
      <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
        {payments.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (payments.data ?? []).length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No payments yet. Stripe and admin-recorded offline payments will appear here.
          </p>
        ) : (
          <TableOrCards
            table={
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Booking</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Source</th>
                  <th className="px-6 py-3 font-medium">Method</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(payments.data ?? []).map(p => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-6 py-3.5 text-muted-foreground">
                      {paymentDate(p).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-3.5">{p.bookingId ? `#${p.bookingId}` : "—"}</td>
                    <td className="px-6 py-3.5 capitalize">{p.kind}</td>
                    <td className="px-6 py-3.5">
                      <span className={p.source === "offline" ? "rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800" : "rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800"}>
                        {p.source === "offline" ? "Offline" : "Stripe"}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 capitalize text-muted-foreground">{p.method}</td>
                    <td className="px-6 py-3.5 font-semibold">{fmtMoney(paymentAmount(p))}</td>
                    <td className="px-6 py-3.5">
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            }
            cards={(payments.data ?? []).map(p => (
              <RowCard
                key={p.id}
                title={<span className="capitalize">{p.kind} payment</span>}
                subtitle={`${paymentDate(p).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${p.bookingId ? ` · booking #${p.bookingId}` : ""}`}
                amount={fmtMoney(paymentAmount(p))}
                badge={<StatusBadge status={p.status} />}
                details={[
                  { label: "Source", value: p.source === "offline" ? "Offline" : "Stripe" },
                  { label: "Method", value: <span className="capitalize">{p.method ?? "—"}</span> },
                  { label: "Booking", value: p.bookingId ? `#${p.bookingId}` : "—" },
                  { label: "Invoice", value: p.invoiceId ? `#${p.invoiceId}` : "—" },
                  ...(p.source === "offline"
                    ? [
                        { label: "Recorded by", value: p.recordedByName ?? p.recordedByEmail ?? `User #${p.recordedByUserId}` },
                        ...(p.note ? [{ label: "Note", value: p.note }] : []),
                      ]
                    : []),
                ]}
              />
            ))}
          />
        )}
      </div>
    </div>
  );
}
