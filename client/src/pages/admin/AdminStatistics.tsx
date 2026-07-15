import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { trpc } from "@/lib/trpc";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SERVICE_LABELS, fmtMoney } from "./adminShared";

const PIE_COLORS = ["#f26649", "#2e7d5b", "#f2a03d", "#5b8def", "#a267d6", "#e05a8a"];

export default function AdminStatistics() {
  const stats = trpc.admin.stats.useQuery();
  const revenue = trpc.admin.monthlyRevenue.useQuery();
  const byService = trpc.admin.bookingsByService.useQuery();

  const revenueData = (revenue.data ?? []).map(r => ({ month: r.month, total: Number(r.total) }));
  const serviceData = (byService.data ?? []).map(s => ({
    name: SERVICE_LABELS[s.serviceType] ?? s.serviceType,
    value: Number(s.count),
  }));

  return (
    <div>
      <PageHeader title="Statistics" subtitle="Revenue and booking analytics" />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Lifetime revenue", value: stats.data ? fmtMoney(stats.data.totalRevenue) : null },
          { label: "Total bookings", value: stats.data ? String(stats.data.totalBookings) : null },
          { label: "Average rating", value: stats.data ? (stats.data.averageRating > 0 ? stats.data.averageRating.toFixed(1) : "—") : null },
        ].map(c => (
          <div key={c.label} className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            {c.value === null ? (
              <Skeleton className="mt-1 h-8 w-24" />
            ) : (
              <p className="mt-1 font-display text-3xl font-bold text-foreground">{c.value}</p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
          <h2 className="font-semibold text-foreground">Monthly revenue</h2>
          {revenue.isLoading ? (
            <Skeleton className="mt-4 h-64 w-full" />
          ) : revenueData.length === 0 ? (
            <p className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              Revenue data will appear when deposits are collected.
            </p>
          ) : (
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} />
                  <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Revenue"]} />
                  <Bar dataKey="total" fill="#f26649" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-border">
          <h2 className="font-semibold text-foreground">Bookings by service</h2>
          {byService.isLoading ? (
            <Skeleton className="mt-4 h-64 w-full" />
          ) : serviceData.length === 0 ? (
            <p className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              Booking distribution will appear once bookings come in.
            </p>
          ) : (
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={serviceData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3}>
                    {serviceData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 flex flex-wrap justify-center gap-3">
                {serviceData.map((s, i) => (
                  <span key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    {s.name} ({s.value})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
