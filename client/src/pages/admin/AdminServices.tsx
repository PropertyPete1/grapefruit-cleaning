import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import {
  DEFAULT_PRICING,
  PRICING_SETTING_KEY,
  serializePricingConfig,
  type ExtraId,
  type Frequency,
  type PricingConfig,
  type PricingTier,
  type TieredType,
} from "@shared/pricing";
import { PageHeader, SERVICE_LABELS } from "./adminShared";

const EXTRA_LABELS: Record<ExtraId, string> = {
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

const FREQ_LABELS: Record<Frequency, string> = {
  onetime: "One-time",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
};

const TIERED: TieredType[] = ["residential", "deep", "moveinout"];

function tierRange(tier: PricingTier, prev?: PricingTier): string {
  if (!prev) return `Under ${tier.maxSqft === Infinity ? "any size" : tier.maxSqft.toLocaleString("en-US") + " sq ft"}`;
  if (tier.maxSqft === Infinity) return `Over ${prev.maxSqft.toLocaleString("en-US")} sq ft`;
  return `${prev.maxSqft.toLocaleString("en-US")}–${tier.maxSqft.toLocaleString("en-US")} sq ft`;
}

/** Deep-clone a config so edits never mutate the query cache or defaults. */
function cloneConfig(cfg: PricingConfig): PricingConfig {
  return {
    tiers: {
      residential: cfg.tiers.residential.map(t => ({ ...t })),
      deep: cfg.tiers.deep.map(t => ({ ...t })),
      moveinout: cfg.tiers.moveinout.map(t => ({ ...t })),
    },
    basePrices: { ...cfg.basePrices },
    extras: { ...cfg.extras },
    frequencyDiscounts: { ...cfg.frequencyDiscounts },
    depositRate: cfg.depositRate,
  };
}

export default function AdminServices() {
  const utils = trpc.useUtils();
  const configQuery = trpc.booking.pricingConfig.useQuery(undefined, { staleTime: 0 });
  const [draft, setDraft] = useState<PricingConfig | null>(null);
  const [dirty, setDirty] = useState(false);

  // Initialize the editable draft once the live config arrives.
  useEffect(() => {
    if (configQuery.data && !draft) setDraft(cloneConfig(configQuery.data));
  }, [configQuery.data, draft]);

  const save = trpc.admin.saveSetting.useMutation({
    onSuccess: () => {
      utils.booking.pricingConfig.invalidate();
      utils.admin.settings.invalidate();
      setDirty(false);
      toast.success("Pricing saved — live on the site now");
    },
    onError: e => toast.error(e.message || "Could not save pricing"),
  });

  if (!draft) {
    return (
      <div>
        <PageHeader title="Services & Pricing" subtitle="Edit every price the site charges — changes apply everywhere at once" />
        <div className="flex items-center gap-2 rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm ring-1 ring-border">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pricing…
        </div>
      </div>
    );
  }

  const update = (fn: (cfg: PricingConfig) => void) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = cloneConfig(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const parsePrice = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  };

  const handleSave = () => {
    // Basic sanity: deposit rate 1–100%.
    if (draft.depositRate <= 0 || draft.depositRate > 1) {
      toast.error("Deposit rate must be between 1% and 100%");
      return;
    }
    save.mutate({ key: PRICING_SETTING_KEY, value: serializePricingConfig(draft) });
  };

  const handleReset = () => {
    setDraft(cloneConfig(DEFAULT_PRICING));
    setDirty(true);
    toast.info("Reset to default pricing — click Save to apply");
  };

  const priceInput = (value: number, onChange: (n: number) => void, ariaLabel: string) => (
    <div className="relative w-28">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
      <Input
        aria-label={ariaLabel}
        type="number"
        min={0}
        step="0.01"
        className="h-9 pl-6 text-right text-sm"
        value={value}
        onChange={e => {
          const n = parsePrice(e.target.value);
          if (n !== null) onChange(n);
        }}
      />
    </div>
  );

  const percentInput = (rate: number, onChange: (n: number) => void, ariaLabel: string) => (
    <div className="relative w-24">
      <Input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={95}
        step={1}
        className="h-9 pr-7 text-right text-sm"
        value={Math.round(rate * 100)}
        onChange={e => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 0 && n <= 95) onChange(n / 100);
        }}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Services & Pricing"
        subtitle="Edit every price the site charges — quote calculator, booking flow, and Stripe deposits all follow these values"
      />

      {/* Sticky action bar */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button onClick={handleSave} disabled={!dirty || save.isPending} className="press">
          {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save pricing
        </Button>
        <Button variant="outline" onClick={handleReset} disabled={save.isPending} className="press bg-card">
          <RotateCcw className="mr-1.5 h-4 w-4" /> Reset to defaults
        </Button>
        {dirty && <span className="text-xs font-medium text-amber-600">Unsaved changes</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {TIERED.map(svc => (
            <div key={svc} className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
              <div className="border-b border-border px-6 py-4">
                <h2 className="font-semibold text-foreground">{SERVICE_LABELS[svc] ?? svc} — rates by size</h2>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {draft.tiers[svc].map((tier, idx, arr) => (
                    <tr key={idx} className="border-b border-border/60 last:border-0">
                      <td className="px-6 py-2.5 font-medium text-foreground">
                        {tierRange(tier, idx > 0 ? arr[idx - 1] : undefined)}
                        {tier.startingAt && !tier.customQuote && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">starting at</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {tier.customQuote ? (
                          <span className="text-xs font-semibold text-muted-foreground">Custom Quote</span>
                        ) : (
                          <div className="flex justify-end">
                            {priceInput(
                              tier.price,
                              n => update(cfg => { cfg.tiers[svc][idx].price = n; }),
                              `${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1} price`
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="font-semibold text-foreground">Other services — service-visit minimums</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Airbnb follows the residential table; commercial &amp; office show "starting at" and use custom quotes.</p>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-border/60">
                  <td className="px-6 py-2.5 font-medium text-foreground">Airbnb Cleaning</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end">
                      {priceInput(draft.basePrices.airbnb, n => update(cfg => { cfg.basePrices.airbnb = n; }), "Airbnb base price")}
                    </div>
                  </td>
                </tr>
                <tr className="border-b border-border/60">
                  <td className="px-6 py-2.5 font-medium text-foreground">Commercial Cleaning</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end">
                      {priceInput(draft.basePrices.commercial, n => update(cfg => { cfg.basePrices.commercial = n; }), "Commercial base price")}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-2.5 font-medium text-foreground">Office Cleaning</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end">
                      {priceInput(draft.basePrices.office, n => update(cfg => { cfg.basePrices.office = n; }), "Office base price")}
                    </div>
                  </td>
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
                {(Object.keys(EXTRA_LABELS) as ExtraId[]).map(id => (
                  <tr key={id} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-2 text-foreground">{EXTRA_LABELS[id]}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end">
                        {priceInput(draft.extras[id], n => update(cfg => { cfg.extras[id] = n; }), `${EXTRA_LABELS[id]} price`)}
                      </div>
                    </td>
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
                {(Object.keys(FREQ_LABELS) as Frequency[]).map(freq => (
                  <tr key={freq} className="border-b border-border/60 last:border-0">
                    <td className="px-6 py-2 text-foreground">{FREQ_LABELS[freq]}</td>
                    <td className="px-4 py-2 text-right">
                      {freq === "onetime" ? (
                        <span className="pr-2 text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex justify-end">
                          {percentInput(
                            draft.frequencyDiscounts[freq],
                            n => update(cfg => { cfg.frequencyDiscounts[freq] = n; }),
                            `${FREQ_LABELS[freq]} discount`
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
            <div className="border-b border-border px-6 py-4">
              <h2 className="font-semibold text-foreground">Booking deposit</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Percentage of the estimated total collected at booking via Stripe.</p>
            </div>
            <div className="flex items-center justify-between px-6 py-3 text-sm">
              <span className="font-medium text-foreground">Deposit rate</span>
              {percentInput(draft.depositRate, n => update(cfg => { cfg.depositRate = n; }), "Deposit rate")}
            </div>
          </div>

          <p className="rounded-2xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
            Changes take effect immediately after saving — the public quote calculator, booking flow, and Stripe
            deposit amounts all read these values live. Bookings already created keep the price they were quoted.
          </p>
        </div>
      </div>
    </div>
  );
}
