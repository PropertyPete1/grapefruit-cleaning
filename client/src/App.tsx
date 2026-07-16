import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { useEffect } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LocaleProvider, detectPreferredLocale } from "./i18n/LocaleContext";
import { ROUTE_SLUGS, type Locale } from "./i18n/types";
import { SiteLayout } from "./components/SiteLayout";
import Home from "./pages/Home";
import About from "./pages/About";
import Services from "./pages/Services";
import ServiceDetail from "./pages/ServiceDetail";
import Pricing from "./pages/Pricing";
import Gallery from "./pages/Gallery";
import Testimonials from "./pages/Testimonials";
import Faq from "./pages/Faq";
import Contact from "./pages/Contact";
import Quote from "./pages/Quote";
import Booking from "./pages/Booking";
import Blog from "./pages/Blog";
import BlogPost from "./pages/BlogPost";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import NotFound from "./pages/NotFound";
import AdminRoutes from "./pages/admin/AdminRoutes";
import StaffRoutes from "./pages/staff/StaffRoutes";

/** Redirects "/" (and unknown bare paths) to the preferred locale home. */
function RootRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => {
    // If the user was heading somewhere gated (e.g. /staff or /admin) before
    // being sent through OAuth, restore that destination now — the OAuth
    // callback always lands back at "/".
    try {
      const saved = localStorage.getItem("gfc-post-login-redirect");
      if (saved && (saved.startsWith("/staff") || saved.startsWith("/admin"))) {
        localStorage.removeItem("gfc-post-login-redirect");
        navigate(saved, { replace: true });
        return;
      }
    } catch {}
    navigate(`/${detectPreferredLocale()}`, { replace: true });
  }, [navigate]);
  return null;
}

function LocalizedRoutes({ locale }: { locale: Locale }) {
  const s = (routeId: string) =>
    `/${locale}${ROUTE_SLUGS[routeId][locale] ? `/${ROUTE_SLUGS[routeId][locale]}` : ""}`;
  return (
    <LocaleProvider locale={locale}>
      <SiteLayout>
        <Switch>
          <Route path={s("home")} component={Home} />
          <Route path={s("about")} component={About} />
          <Route path={s("services")} component={Services} />
          <Route path={s("residential")}>{() => <ServiceDetail serviceId="residential" />}</Route>
          <Route path={s("commercial")}>{() => <ServiceDetail serviceId="commercial" />}</Route>
          <Route path={s("airbnb")}>{() => <ServiceDetail serviceId="airbnb" />}</Route>
          <Route path={s("moveinout")}>{() => <ServiceDetail serviceId="moveinout" />}</Route>
          <Route path={s("deep")}>{() => <ServiceDetail serviceId="deep" />}</Route>
          <Route path={s("office")}>{() => <ServiceDetail serviceId="office" />}</Route>
          <Route path={s("pricing")} component={Pricing} />
          <Route path={s("gallery")} component={Gallery} />
          <Route path={s("testimonials")} component={Testimonials} />
          <Route path={s("faq")} component={Faq} />
          <Route path={s("contact")} component={Contact} />
          <Route path={s("quote")} component={Quote} />
          <Route path={s("booking")} component={Booking} />
          <Route path={s("blog")} component={Blog} />
          <Route path={`${s("blog")}/:slug`}>{(params: { slug: string }) => <BlogPost slug={params.slug} />}</Route>
          <Route path={s("privacy")} component={Privacy} />
          <Route path={s("terms")} component={Terms} />
          <Route component={NotFound} />
        </Switch>
      </SiteLayout>
    </LocaleProvider>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootRedirect} />
      <Route path="/admin/*?" component={AdminRoutes} />
      <Route path="/staff/*?" component={StaffRoutes} />
      <Route path="/en/*?">
        <LocalizedRoutes locale="en" />
      </Route>
      <Route path="/es/*?">
        <LocalizedRoutes locale="es" />
      </Route>
      <Route path="/home">
        <Redirect to="/en" replace />
      </Route>
      {/* Final fallback route */}
      <Route component={RootRedirect} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
