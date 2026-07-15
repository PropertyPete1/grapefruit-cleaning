import { BASE_PRICES, EXTRA_PRICES, FREQUENCY_DISCOUNTS, PER_BATHROOM, PER_BEDROOM, PER_500_SQFT } from "@shared/pricing";
import { PageHeader, SERVICE_LABELS } from "./adminShared";

const EXTRA_LABELS: Record<string, string> = {
  pets: "Home with pets",
  deepClean: "Deep cleaning add-on",
  moveOut: "Move out condition",
  oven: "Inside oven",
  refrigerator: "Inside refrigerator",
  windows: "Interior windows",
  laundry: "Laundry & folding",
  garage: "Garage sweep",
  organization: "Home organization",
};

export default function AdminServices() {
  return (
    <div>
      <PageHeader
        title="Services & Pricing"
        subtitle="The pricing engine used by the quote calculator and booking flow"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
          <div className="border-b border-border px-6 py-4">
            <h2 className="font-semibold text-foreground">Base prices by service</h2>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(BASE_PRICES).map(([svc, price]) => (
                <tr key={svc} className="border-b border-border/60 last:border-0">
                  <td className="px-6 py-3 font-medium text-foreground">{SERVICE_LABELS[svc] ?? svc}</td>
                  <td className="px-6 py-3 text-right font-semibold text-foreground">${price}</td>
                </tr>
              ))}
              <tr className="border-b border-border/60">
                <td className="px-6 py-3 text-muted-foreground">Per bedroom</td>
                <td className="px-6 py-3 text-right font-semibold">${PER_BEDROOM}</td>
              </tr>
              <tr className="border-b border-border/60">
                <td className="px-6 py-3 text-muted-foreground">Per bathroom</td>
                <td className="px-6 py-3 text-right font-semibold">${PER_BATHROOM}</td>
              </tr>
              <tr>
                <td className="px-6 py-3 text-muted-foreground">Per 500 ft² above 1,000</td>
                <td className="px-6 py-3 text-right font-semibold">${PER_500_SQFT}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="font-semibold text-foreground">Extras</h2>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(EXTRA_PRICES).map(([id, price]) => (
                  <tr key={id} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-2.5 text-foreground">{EXTRA_LABELS[id] ?? id}</td>
                    <td className="px-6 py-2.5 text-right font-semibold">${price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="font-semibold text-foreground">Frequency discounts</h2>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(FREQUENCY_DISCOUNTS).map(([freq, rate]) => (
                  <tr key={freq} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-2.5 capitalize text-foreground">{freq}</td>
                    <td className="px-6 py-2.5 text-right font-semibold">
                      {rate > 0 ? `−${Math.round(rate * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="rounded-2xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
            Pricing rules live in <code className="rounded bg-muted px-1 py-0.5">shared/pricing.ts</code> so the
            quote calculator, booking flow, and server all charge identically. Ask your developer (or Manus) to
            adjust these values — changes apply everywhere at once.
          </p>
        </div>
      </div>
    </div>
  );
}
