import { useMemo, useState } from "react";
import { Link, Route, Switch, useLocation, useRoute } from "wouter";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Loader2,
  LogOut,
  MapPin,
  Menu,
  Phone,
  Sparkles,
  SunMedium,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch as ToggleSwitch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ASSETS } from "@/lib/assets";
import { PageHeader, StatusBadge, SERVICE_LABELS, fmtMoney, fmtDate } from "../admin/adminShared";
import StaffJoin from "./StaffJoin";

const NAV_ITEMS = [
  { path: "/staff", label: "My Day", icon: SunMedium, exact: true },
  { path: "/staff/jobs", label: "Jobs", icon: ClipboardList },
  { path: "/staff/calendar", label: "Calendar", icon: CalendarDays },
];

function money(cents: number | null | undefined) {
  return fmtMoney(cents);
}

type StaffBookingRow = {
  booking: {
    id: number;
    reference: string;
    serviceType: string;
    scheduledDate: string;
    scheduledTime: string;
    bedrooms: number;
    bathrooms: number;
    sqft: number;
    extras: string | null;
    addressLine: string | null;
    city: string | null;
    zip: string | null;
    notes: string | null;
    totalAmount: number;
    depositAmount: number;
    status: string;
    employeeId: number | null;
  };
  customer: { firstName: string; lastName: string; phone: string | null; email: string } | null;
};

function JobCard({ row, onStatusChange }: { row: StaffBookingRow; onStatusChange?: () => void }) {
  const { booking, customer } = row;
  const utils = trpc.useUtils();
  const update = trpc.staff.updateJobStatus.useMutation({
    onSuccess: () => {
      toast.success("Job status updated");
      utils.staff.invalidate();
      onStatusChange?.();
    },
    onError: (e) => toast.error(e.message),
  });
  const extras: string[] = booking.extras ? (JSON.parse(booking.extras) as string[]) : [];
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-display text-base font-bold text-foreground">
              {SERVICE_LABELS[booking.serviceType] ?? booking.serviceType}
            </p>
            <StatusBadge status={booking.status} />
          </div>
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">
            {booking.reference} · {fmtDate(booking.scheduledDate)} at {booking.scheduledTime}
          </p>
        </div>
        <p className="text-sm font-bold text-foreground">{money(booking.totalAmount)}</p>
      </div>
      <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <p>
          <span className="font-semibold text-foreground">
            {customer ? `${customer.firstName} ${customer.lastName}` : "Customer"}
          </span>
        </p>
        {customer?.phone && (
          <a href={`tel:${customer.phone}`} className="flex items-center gap-1.5 text-primary hover:underline">
            <Phone className="h-3.5 w-3.5" /> {customer.phone}
          </a>
        )}
        {(booking.addressLine || booking.city) && (
          <p className="flex items-center gap-1.5 sm:col-span-2">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            {[booking.addressLine, booking.city, booking.zip].filter(Boolean).join(", ")}
          </p>
        )}
        <p className="sm:col-span-2">
          {booking.bedrooms} bd · {booking.bathrooms} ba · {booking.sqft.toLocaleString()} sq ft
          {extras.length > 0 && <> · Extras: {extras.join(", ")}</>}
        </p>
        {booking.notes && <p className="rounded-xl bg-muted/60 p-2.5 text-xs sm:col-span-2">“{booking.notes}”</p>}
      </div>
      {(booking.status === "confirmed" || booking.status === "in_progress") && (
        <div className="mt-4 flex gap-2">
          {booking.status === "confirmed" && (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full bg-card"
              disabled={update.isPending}
              onClick={() => update.mutate({ bookingId: booking.id, status: "in_progress" })}
            >
              Start job
            </Button>
          )}
          <Button
            size="sm"
            className="rounded-full"
            disabled={update.isPending}
            onClick={() => update.mutate({ bookingId: booking.id, status: "completed" })}
          >
            Mark completed
          </Button>
        </div>
      )}
    </div>
  );
}

function StaffToday() {
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const { data: overview } = trpc.staff.overview.useQuery();
  const { data: jobs, isLoading } = trpc.staff.bookings.useQuery({ date: today });
  const active = (jobs ?? []).filter((j) => j.booking.status !== "cancelled");
  return (
    <div>
      <PageHeader
        title="My Day"
        subtitle={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
      />
      <div className="mb-6 grid grid-cols-3 gap-3">
        {[
          { label: "Jobs today", value: overview?.todayCount ?? "—" },
          { label: "Upcoming", value: overview?.upcomingCount ?? "—" },
          { label: "Assigned to me", value: overview?.myUpcomingCount ?? "—" },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-2xl border border-border bg-card p-4 text-center shadow-sm">
            <p className="font-display text-2xl font-bold text-foreground">{kpi.value}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{kpi.label}</p>
          </div>
        ))}
      </div>
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : active.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-primary" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">No jobs scheduled for today. Enjoy the calm!</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {active.map((row) => (
            <JobCard key={row.booking.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function StaffJobs() {
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const { data: jobs, isLoading } = trpc.staff.bookings.useQuery({
    status: status === "all" ? undefined : (status as never),
    mineOnly,
  });
  return (
    <div>
      <PageHeader title="Jobs" subtitle="All bookings — filter by status or view only jobs assigned to you" />
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44 rounded-full bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending_deposit">Pending deposit</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ToggleSwitch checked={mineOnly} onCheckedChange={setMineOnly} /> My jobs only
        </label>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 p-10 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            {mineOnly
              ? "No jobs assigned to you yet. Ask an admin to link your account on the Employees page."
              : "No bookings match this filter."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(jobs ?? []).map((row) => (
            <JobCard key={row.booking.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function StaffCalendar() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const monthStr = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`;
  const { data: rows, isLoading } = trpc.staff.schedule.useQuery({ month: monthStr });
  const byDate = useMemo(() => {
    const map: Record<string, StaffBookingRow[]> = {};
    (rows ?? []).forEach((r) => {
      (map[r.booking.scheduledDate] ??= []).push(r as StaffBookingRow);
    });
    return map;
  }, [rows]);
  const firstDay = new Date(cursor.y, cursor.m, 1).getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthLabel = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Monthly schedule of all cleanings"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-card"
              onClick={() => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <p className="w-40 text-center text-sm font-bold text-foreground">{monthLabel}</p>
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-card"
              onClick={() => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="grid min-w-[640px] grid-cols-7 gap-1.5">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <p key={d} className="pb-2 text-center text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {d}
              </p>
            ))}
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${monthStr}-${String(day).padStart(2, "0")}`;
              const jobs = byDate[dateStr] ?? [];
              const isToday = dateStr === todayStr;
              return (
                <div
                  key={dateStr}
                  className={`min-h-24 rounded-xl border p-1.5 ${
                    isToday ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background"
                  }`}
                >
                  <p className={`text-xs font-bold ${isToday ? "text-primary" : "text-muted-foreground"}`}>{day}</p>
                  <div className="mt-1 space-y-1">
                    {jobs.slice(0, 3).map((j) => (
                      <div
                        key={j.booking.id}
                        className="truncate rounded-md bg-secondary/15 px-1.5 py-0.5 text-[10px] font-semibold text-secondary"
                        title={`${j.booking.scheduledTime} ${SERVICE_LABELS[j.booking.serviceType] ?? j.booking.serviceType} — ${j.customer ? `${j.customer.firstName} ${j.customer.lastName}` : ""}`}
                      >
                        {j.booking.scheduledTime} {SERVICE_LABELS[j.booking.serviceType] ?? j.booking.serviceType}
                      </div>
                    ))}
                    {jobs.length > 3 && <p className="text-[10px] font-medium text-muted-foreground">+{jobs.length - 3} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StaffShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activeItem = NAV_ITEMS.find((item) =>
    item.exact ? location === item.path : location.startsWith(item.path)
  );
  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-card lg:flex">
        <div className="flex items-center gap-2.5 border-b border-border px-6 py-5">
          <img src={ASSETS.logo} alt="Grapefruit Cleaning Co." className="h-9 w-auto" />
          <div>
            <p className="text-sm font-bold leading-tight text-foreground">Grapefruit</p>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Staff</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const active = item.exact ? location === item.path : location.startsWith(item.path);
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{user?.name ?? "Staff"}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => logout()} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-3 border-b border-border bg-card px-4 py-3 lg:hidden">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="shrink-0 rounded-xl" aria-label="Open navigation menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b border-border px-6 py-5 text-left">
              <SheetTitle className="flex items-center gap-2.5">
                <img src={ASSETS.logo} alt="Grapefruit Cleaning Co." className="h-9 w-auto" />
                <span>
                  <span className="block text-sm font-bold leading-tight text-foreground">Grapefruit</span>
                  <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Staff
                  </span>
                </span>
              </SheetTitle>
            </SheetHeader>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
              {NAV_ITEMS.map((item) => {
                const active = item.exact ? location === item.path : location.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{user?.name ?? "Staff"}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => logout()} aria-label="Sign out">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 items-center gap-2">
          {activeItem ? <activeItem.icon className="h-4 w-4 shrink-0 text-primary" /> : null}
          <p className="truncate text-sm font-semibold text-foreground">{activeItem?.label ?? "Staff"}</p>
        </div>
      </div>
      <main className="flex-1 px-4 pb-16 pt-20 lg:ml-60 lg:px-10 lg:pt-10">{children}</main>
    </div>
  );
}

export default function StaffRoutes() {
  const { user, loading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: true });
  // Invite links must work for accounts that don't have the staff role yet —
  // accepting the invite is what grants it. Render the join page before gating.
  const [isJoin, joinParams] = useRoute("/staff/join/:token");
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!isAuthenticated) return null;
  if (isJoin && joinParams?.token) {
    return <StaffJoin token={joinParams.token} />;
  }
  if (user?.role !== "staff" && user?.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="max-w-md rounded-3xl bg-card p-10 text-center shadow-lg">
          <Sparkles className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-4 font-display text-2xl font-bold text-foreground">Staff access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This area is for Grapefruit Cleaning Co. team members. If you're part of the team, ask an
            administrator to grant your account staff access from the Employees page.
          </p>
          <Button asChild className="mt-6 rounded-full px-6">
            <Link href="/en">Back to website</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <StaffShell>
      <Switch>
        <Route path="/staff" component={StaffToday} />
        <Route path="/staff/jobs" component={StaffJobs} />
        <Route path="/staff/calendar" component={StaffCalendar} />
        <Route component={StaffToday} />
      </Switch>
    </StaffShell>
  );
}
