import { Link } from "wouter";
import { ArrowUpRight, CalendarCheck, DollarSign, Star, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SERVICE_LABELS, StatusBadge, fmtDate, fmtMoney } from "./adminShared";

export default function AdminDashboard() {
  const stats = trpc.admin.stats.useQuery();
  const bookings = trpc.admin.bookings.useQuery({});

  const cards = [
    { label: "Total revenue", value: stats.data ? fmtMoney(stats.data.totalRevenue) : null, icon: DollarSign, tint: "bg-emerald-100 text-emerald-600" },
    { label: "Upcoming appointments", value: stats.data ? String(stats.data.upcomingBookings) : null, icon: CalendarCheck, tint: "bg-primary/10 text-primary" },
    { label: "Customers", value: stats.data ? String(stats.data.totalCustomers) : null, icon: Users, tint: "bg-blue-100 text-blue-600" },
    { label: "Average rating", value: stats.data ? (stats.data.averageRating > 0 ? stats.data.averageRating.toFixed(1) : "—") : null, icon: Star, tint: "bg-amber-100 text-amber-600" },
  ];

  const recent = (bookings.data ?? []).slice(0, 8);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Business at a glance" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(card => (
          <div key={card.label} className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
            <div className="flex items-center justify-between">
              <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.tint}`}>
                <card.icon className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">{card.label}</p>
            {card.value === null ? (
              <Skeleton className="mt-1 h-8 w-24" />
            ) : (
              <p className="mt-1 font-display text-3xl font-bold text-foreground">{card.value}</p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-2xl bg-card shadow-sm ring-1 ring-border">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="font-semibold text-foreground">Recent bookings</h2>
          <Link href="/admin/appointments" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            View all <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {bookings.isLoading ? (
          <div className="space-y-3 p-6">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No bookings yet. New reservations will appear here automatically.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3 font-medium">Reference</th>
                  <th className="px-6 py-3 font-medium">Service</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Time</th>
                  <th className="px-6 py-3 font-medium">Total</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(b => (
                  <tr key={b.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-6 py-3.5 font-mono text-xs font-semibold text-primary">{b.reference}</td>
                    <td className="px-6 py-3.5">{SERVICE_LABELS[b.serviceType] ?? b.serviceType}</td>
                    <td className="px-6 py-3.5">{fmtDate(b.scheduledDate)}</td>
                    <td className="px-6 py-3.5">{b.scheduledTime}</td>
                    <td className="px-6 py-3.5 font-semibold">{fmtMoney(b.totalAmount)}</td>
                    <td className="px-6 py-3.5"><StatusBadge status={b.status} /></td>
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
