import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

const quote = read("client/src/pages/Quote.tsx");
const booking = read("client/src/pages/Booking.tsx");
const addons = read("client/src/components/AddonCatalogPicker.tsx");
const services = read("client/src/pages/admin/AdminServices.tsx");
const appointments = read("client/src/pages/admin/AdminAppointments.tsx");
const scheduled = read("server/scheduledRoutes.ts");

describe("quote-to-booking flow repairs", () => {
  it("marks a quote handoff explicitly and starts Booking after the repeated service step", () => {
    expect(quote).toContain('source: "quote"');
    expect(booking).toContain('params.get("source") === "quote"');
    expect(booking).toContain("const firstStep = fromQuote ? 1 : 0");
    expect(booking).toContain("const visibleSteps = fromQuote ? [1, 2, 3, 4] : [0, 1, 2, 3, 4]");
  });

  it("resets both wizards to the top whenever their visible step changes", () => {
    expect(quote).toContain('window.scrollTo({ top: 0, behavior: "auto" })');
    expect(booking).toContain('window.scrollTo({ top: 0, behavior: "auto" })');
    expect(quote).toMatch(/window\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]*?\}, \[step\]\);/);
    expect(booking).toMatch(/window\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]*?\}, \[step\]\);/);
  });

  it("keeps availability fresh so an admin cancellation releases an already-open calendar", () => {
    expect(booking).toContain("staleTime: 0");
    expect(booking).toContain("refetchOnWindowFocus: true");
    expect(booking).toContain("refetchInterval: 15_000");
  });

  it("uses Spanish month and weekday labels in the Spanish calendar", () => {
    expect(booking).toContain('import { es } from "date-fns/locale"');
    expect(booking).toContain('locale={locale === "es" ? es : undefined}');
  });

  it("does not render a confusing zero add-on subtotal", () => {
    expect(addons).toContain('none: "No add-ons selected"');
    expect(addons).toContain('none: "No se seleccionaron servicios adicionales"');
    expect(addons).toContain("selected.length > 0 && (");
    expect(addons).not.toContain('selected.length === 0 && <span>$0.00</span>');
  });
});

describe("admin and automation release contracts", () => {
  it("exposes the settings-backed Booking Hours editor in Services & Pricing", () => {
    expect(services).toContain('import { BookingHoursSection } from "./AdminSettings"');
    expect(services).toContain("<BookingHoursSection />");
  });

  it("invalidates public availability and confirms immediate slot release after cancellation", () => {
    expect(appointments).toContain("utils.booking.availability.invalidate()");
    expect(appointments).toContain("Booking released — the slot is available again");
  });

  it("mounts a cron-only five-minute checkout-hold release endpoint", () => {
    expect(scheduled).toContain('app.post("/api/scheduled/checkoutHolds", checkoutHoldsHandler)');
    expect(scheduled).toContain('error: "cron-only endpoint"');
  });
});
