import { lazy, Suspense } from "react";
import { useState } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import {
  BarChart3,
  CalendarDays,
  CreditCard,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  Newspaper,
  Settings as SettingsIcon,
  Sparkles,
  Star,
  Tag,
  Ticket,
  Users,
  UsersRound,
  ClipboardList,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ASSETS } from "@/lib/assets";

const AdminDashboard = lazy(() => import("./AdminDashboard"));
const AdminAppointments = lazy(() => import("./AdminAppointments"));
const AdminCustomers = lazy(() => import("./AdminCustomers"));
const AdminInvoices = lazy(() => import("./AdminInvoices"));
const AdminPayments = lazy(() => import("./AdminPayments"));
const AdminEmployees = lazy(() => import("./AdminEmployees"));
const AdminCalendar = lazy(() => import("./AdminCalendar"));
const AdminStatistics = lazy(() => import("./AdminStatistics"));
const AdminReviews = lazy(() => import("./AdminReviews"));
const AdminGallery = lazy(() => import("./AdminGallery"));
const AdminServices = lazy(() => import("./AdminServices"));
const AdminCoupons = lazy(() => import("./AdminCoupons"));
const AdminSettings = lazy(() => import("./AdminSettings"));
const AdminMessages = lazy(() => import("./AdminMessages"));
const AdminBlog = lazy(() => import("./AdminBlog"));

const NAV_ITEMS = [
  { path: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { path: "/admin/appointments", label: "Appointments", icon: ClipboardList },
  { path: "/admin/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/admin/customers", label: "Customers", icon: Users },
  { path: "/admin/messages", label: "Messages", icon: MessageSquare },
  { path: "/admin/invoices", label: "Invoices", icon: FileText },
  { path: "/admin/payments", label: "Payments", icon: CreditCard },
  { path: "/admin/employees", label: "Employees", icon: UsersRound },
  { path: "/admin/statistics", label: "Statistics", icon: BarChart3 },
  { path: "/admin/reviews", label: "Reviews", icon: Star },
  { path: "/admin/gallery", label: "Gallery", icon: ImageIcon },
  { path: "/admin/services", label: "Services & Pricing", icon: Tag },
  { path: "/admin/blog", label: "Blog", icon: Newspaper },
  { path: "/admin/coupons", label: "Coupons", icon: Ticket },
  { path: "/admin/settings", label: "Settings", icon: SettingsIcon },
];

function AdminShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activeItem = NAV_ITEMS.find(item =>
    item.exact ? location === item.path : location.startsWith(item.path)
  );

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="flex items-center gap-2.5 border-b border-border px-6 py-5">
          <img src={ASSETS.logo} alt="Grapefruit Cleaning Co." className="h-9 w-auto" />
          <div>
            <p className="text-sm font-bold leading-tight text-foreground">Grapefruit</p>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Admin</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map(item => {
            const active = item.exact ? location === item.path : location.startsWith(item.path);
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
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
              <p className="truncate text-sm font-medium text-foreground">{user?.name ?? "Admin"}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => logout()} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar: hamburger + current section */}
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
                    Admin
                  </span>
                </span>
              </SheetTitle>
            </SheetHeader>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
              {NAV_ITEMS.map(item => {
                const active = item.exact ? location === item.path : location.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    onClick={() => setDrawerOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
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
                  <p className="truncate text-sm font-medium text-foreground">{user?.name ?? "Admin"}</p>
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
          <p className="truncate text-sm font-semibold text-foreground">{activeItem?.label ?? "Admin"}</p>
        </div>
      </div>

      <main className="flex-1 px-4 pb-16 pt-20 lg:ml-64 lg:px-10 lg:pt-10">{children}</main>
    </div>
  );
}

export default function AdminRoutes() {
  const { user, loading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: true });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) return null; // useAuth redirects to login

  if (user?.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="max-w-md rounded-3xl bg-card p-10 text-center shadow-lg">
          <Sparkles className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-4 font-display text-2xl font-bold text-foreground">Admin access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This area is reserved for Grapefruit Cleaning Co. administrators. If you believe you should have
            access, please contact the site owner.
          </p>
          <Button asChild className="mt-6 rounded-full px-6">
            <Link href="/en">Back to website</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AdminShell>
      <Suspense
        fallback={
          <div className="flex min-h-[50vh] items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </div>
        }
      >
        <Switch>
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/appointments" component={AdminAppointments} />
          <Route path="/admin/calendar" component={AdminCalendar} />
          <Route path="/admin/customers" component={AdminCustomers} />
          <Route path="/admin/messages" component={AdminMessages} />
          <Route path="/admin/invoices" component={AdminInvoices} />
          <Route path="/admin/payments" component={AdminPayments} />
          <Route path="/admin/employees" component={AdminEmployees} />
          <Route path="/admin/statistics" component={AdminStatistics} />
          <Route path="/admin/reviews" component={AdminReviews} />
          <Route path="/admin/gallery" component={AdminGallery} />
          <Route path="/admin/services" component={AdminServices} />
          <Route path="/admin/blog" component={AdminBlog} />
          <Route path="/admin/coupons" component={AdminCoupons} />
          <Route path="/admin/settings" component={AdminSettings} />
          <Route component={AdminDashboard} />
        </Switch>
      </Suspense>
    </AdminShell>
  );
}
