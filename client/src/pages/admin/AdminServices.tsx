import { BASE_PRICES, EXTRA_PRICES, FREQUENCY_DISCOUNTS, PRICING_TIERS, type CleaningType, type PricingTier } from "@shared/pricing";
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

const TIERED: CleaningType[] = ["residential", "deep", "moveinout"];

function tierRange(tier: PricingTier, prev?: PricingTier): string {
  if (!prev) return "Under 1,000 sq ft";
  if (tier.maxSqft === Infinity) return `Over ${prev.maxSqft.toLocaleString("en-US")} sq ft`;
  return `${prev.maxSqft.toLocaleString("en-US")}–${tier.maxSqft.toLocaleString("en-US")} sq ft`;
}

export default function AdminServices() {
  return (
    <div>
      <PageHeader
        title="Services & Pricing"
        subtitle="The pricing engine used by the quote calculator and booking flow"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {TIERED.map((svc) => (
            <div key={svc} className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
              <div className="border-b border-border px-6 py-4">
                <h2 className="font-semibold text-foreground">{SERVICE_LABELS[svc] ?? svc} — fixed rates by size</h2>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {(PRICING_TIERS[svc] ?? []).map((tier, idx, arr) => (
                    <tr key={idx} className="border-b border-border/60 last:border-0">
                      <td className="px-6 py-3 font-medium text-foreground">{tierRange(tier, idx > 0 ? arr[idx - 1] : undefined)}</td>
                      <td className="px-6 py-3 text-right font-semibold text-foreground">
                        {tier.customQuote ? "Custom Quote" : `${tier.startingAt ? "Starting at " : ""}$${tier.price.toFixed(2)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="font-semibold text-foreground">Other services</h2>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-border/60">
                  <td className="px-6 py-3 font-medium text-foreground">Airbnb Cleaning</td>
                  <td className="px-6 py-3 text-right text-muted-foreground">Uses residential tier table</td>
                </tr>
                <tr className="border-b border-border/60">
                  <td className="px-6 py-3 font-medium text-foreground">Commercial Cleaning</td>
                  <td className="px-6 py-3 text-right font-semibold">Starting at ${BASE_PRICES.commercial.toFixed(2)} (custom quote)</td>
                </tr>
                <tr>
                  <td className="px-6 py-3 font-medium text-foreground">Office Cleaning</td>
                  <td className="px-6 py-3 text-right font-semibold">Starting at ${BASE_PRICES.office.toFixed(2)} (custom quote)</td>
                </tr>
              </tbody>
            </table>
          </div>
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
