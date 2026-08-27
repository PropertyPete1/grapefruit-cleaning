import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  DEFAULT_PRICING,
  MAX_TIERS_PER_SERVICE,
  serializePricingConfig,
  tierRangeLabel,
  type ExtraId,
  type Frequency,
  type PricingConfig,
  type PricingTier,
  type TieredType,
} from "@shared/pricing";
import {
  DEFAULT_DURATIONS,
  DURATION_FLAT_TYPES,
  DURATION_LADDER_TYPES,
  MAX_DURATION_HOURS,
  MAX_DURATION_TIERS_PER_SERVICE,
  durationRangeLabel,
  serializeDurationConfig,
  type DurationConfig,
  type DurationTier,
} from "@shared/duration";
import { PageHeader, SERVICE_LABELS, TableOrCards } from "./adminShared";
import { AddonCatalogManager } from "./AddonCatalogManager";

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

const TIER_LABELS = { under: "Under", over: "Over", sqft: "sq ft", anySize: "Any size" };

function tierRange(tier: PricingTier, prev?: PricingTier): string {
  return tierRangeLabel(tier, prev, TIER_LABELS);
}

/**
 * Client-side mirror of the server's tier rules, so an admin sees the problem
 * inline instead of a rejected save. The server re-checks everything.
 */
function tierProblems(tiers: PricingTier[], service: string): string[] {
  const problems: string[] = [];
  const label = SERVICE_LABELS[service] ?? service;
  if (tiers.length === 0) problems.push(`${label}: needs at least one tier`);
  if (tiers.length > MAX_TIERS_PER_SERVICE)
    problems.push(`${label}: at most ${MAX_TIERS_PER_SERVICE} tiers (currently ${tiers.length})`);
  const unbounded = tiers.filter(t => t.maxSqft === Infinity).length;
  if (unbounded !== 1 || tiers[tiers.length - 1]?.maxSqft !== Infinity)
    problems.push(`${label}: the last tier must be the only open-ended one`);
  let previous = 0;
  tiers.forEach((tier, idx) => {
    if (tier.maxSqft === Infinity) return;
    if (!Number.isInteger(tier.maxSqft) || tier.maxSqft <= 0) {
      problems.push(`${label} tier ${idx + 1}: max sq ft must be a whole number above 0`);
      return;
    }
    if (tier.maxSqft <= previous) {
      problems.push(`${label} tier ${idx + 1}: ${tier.maxSqft.toLocaleString("en-US")} must be larger than ${previous.toLocaleString("en-US")}`);
      return;
    }
    previous = tier.maxSqft;
  });
  return problems;
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

/**
 * Client-side mirror of the server's duration-ladder rules, so an admin sees
 * the problem inline instead of a rejected save. The server re-checks all of it.
 */
function durationProblems(bands: DurationTier[], service: string): string[] {
  const problems: string[] = [];
  const label = SERVICE_LABELS[service] ?? service;
  if (bands.length === 0) problems.push(`${label}: needs at least one band`);
  if (bands.length > MAX_DURATION_TIERS_PER_SERVICE)
    problems.push(`${label}: at most ${MAX_DURATION_TIERS_PER_SERVICE} bands (currently ${bands.length})`);
  const unbounded = bands.filter(b => b.maxSqft === Infinity).length;
  if (unbounded !== 1 || bands[bands.length - 1]?.maxSqft !== Infinity)
    problems.push(`${label}: the last band must be the only open-ended one`);
  let previous = 0;
  bands.forEach((band, idx) => {
    if (!Number.isInteger(band.hours) || band.hours < 1 || band.hours > MAX_DURATION_HOURS) {
      problems.push(`${label} band ${idx + 1}: hours must be a whole number from 1 to ${MAX_DURATION_HOURS}`);
    }
    if (band.maxSqft === Infinity) return;
    if (!Number.isInteger(band.maxSqft) || band.maxSqft <= 0) {
      problems.push(`${label} band ${idx + 1}: max sq ft must be a whole number above 0`);
      return;
    }
    if (band.maxSqft <= previous) {
      problems.push(
        `${label} band ${idx + 1}: ${band.maxSqft.toLocaleString("en-US")} must be larger than ${previous.toLocaleString("en-US")}`
      );
      return;
    }
    previous = band.maxSqft;
  });
  return problems;
}

function cloneDurations(cfg: DurationConfig): DurationConfig {
  return {
    ladders: {
      residential: cfg.ladders.residential.map(b => ({ ...b })),
      deep: cfg.ladders.deep.map(b => ({ ...b })),
      moveinout: cfg.ladders.moveinout.map(b => ({ ...b })),
    },
    flatHours: { ...cfg.flatHours },
  };
}

/**
 * How much of the calendar each job blocks.
 *
 * Sits with the pricing ladders because it is the same shape of decision keyed
 * off the same square footage — but saves to its own setting, so a pricing save
 * from a stale tab can never revert a duration change.
 */
function JobDurationsSection() {
  const utils = trpc.useUtils();
  const configQuery = trpc.admin.durationConfig.useQuery(undefined, { staleTime: 0 });
  const [draft, setDraft] = useState<DurationConfig | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (configQuery.data && !draft) setDraft(cloneDurations(configQuery.data));
  }, [configQuery.data, draft]);

  const save = trpc.admin.saveDurationConfig.useMutation({
    onSuccess: () => {
      utils.admin.durationConfig.invalidate();
      utils.booking.availability.invalidate();
      setDirty(false);
      toast.success("Job durations saved — the booking calendar blocks these spans now");
    },
    onError: e => toast.error(e.message || "Could not save job durations"),
  });

  if (!draft) {
    return (
      <div className="mt-6 flex items-center gap-2 rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm ring-1 ring-border">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading job durations…
      </div>
    );
  }

  const update = (fn: (cfg: DurationConfig) => void) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = cloneDurations(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const problems = DURATION_LADDER_TYPES.flatMap(svc => durationProblems(draft.ladders[svc], svc));

  const hoursInput = (value: number, onChange: (n: number) => void, ariaLabel: string) => (
    <Input
      aria-label={ariaLabel}
      type="number"
      inputMode="numeric"
      min={1}
      max={MAX_DURATION_HOURS}
      step="1"
      className="h-9 w-20 text-right text-sm"
      value={value}
      onChange={e => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.round(n));
      }}
    />
  );

  const addBand = (svc: (typeof DURATION_LADDER_TYPES)[number]) => {
    update(cfg => {
      const bands = cfg.ladders[svc];
      const lastBoundedIdx = bands.length - 2;
      const lastBounded = lastBoundedIdx >= 0 ? bands[lastBoundedIdx] : undefined;
      const maxSqft = lastBounded ? lastBounded.maxSqft + 500 : 1000;
      const hours = lastBounded ? Math.min(MAX_DURATION_HOURS, lastBounded.hours + 1) : 2;
      bands.splice(Math.max(0, bands.length - 1), 0, { maxSqft, hours });
    });
  };

  return (
    <div className="mt-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-display text-lg font-bold text-foreground">Job durations</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            How long a crew is on site, by service and home size. A booking blocks every hour it runs, so a
            4-hour job starting at 11:00 takes 11, 12 and 1 off the calendar and leaves 2 free. Jobs are only
            offered a start time they can finish by closing.
          </p>
        </div>
        <Button
          onClick={() => save.mutate({ config: serializeDurationConfig(draft) })}
          disabled={!dirty || save.isPending || problems.length > 0}
          className="press"
        >
          {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save durations
        </Button>
        <Button
          variant="outline"
          className="press bg-card"
          disabled={save.isPending}
          onClick={() => {
            setDraft(cloneDurations(DEFAULT_DURATIONS));
            setDirty(true);
            toast.info("Reset to default durations — click Save to apply");
          }}
        >
          <RotateCcw className="mr-1.5 h-4 w-4" /> Reset
        </Button>
      </div>
      {problems.length > 0 ? (
        <p className="mb-3 text-xs font-medium text-destructive">{problems[0]}</p>
      ) : (
        dirty && <p className="mb-3 text-xs font-medium text-amber-600">Unsaved changes</p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {DURATION_LADDER_TYPES.map(svc => {
          const bands = draft.ladders[svc];
          return (
            <div key={svc} className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4 lg:px-6">
                <div>
                  <h3 className="font-semibold text-foreground">{SERVICE_LABELS[svc] ?? svc} — hours by size</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {bands.length} bands · each row covers up to its max sq ft
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="press h-8 rounded-lg bg-card text-xs"
                  disabled={bands.length >= MAX_DURATION_TIERS_PER_SERVICE}
                  onClick={() => addBand(svc)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add band
                </Button>
              </div>
              <TableOrCards
                table={
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-6 py-2 font-medium">Range</th>
                        <th className="px-2 py-2 font-medium">Max sq ft</th>
                        <th className="px-2 py-2 text-right font-medium">Hours</th>
                        <th className="w-10 px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {bands.map((band, idx) => (
                        <tr key={idx} className="border-b border-border/60 last:border-0">
                          <td className="px-6 py-2 text-xs text-muted-foreground">
                            {durationRangeLabel(band, bands[idx - 1])}
                          </td>
                          <td className="px-2 py-2">
                            {band.maxSqft === Infinity ? (
                              <span className="text-xs text-muted-foreground">Open-ended</span>
                            ) : (
                              <Input
                                aria-label={`${SERVICE_LABELS[svc] ?? svc} band ${idx + 1} max sq ft`}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step="1"
                                className="h-9 w-24 text-right text-sm"
                                value={band.maxSqft}
                                onChange={e => {
                                  const n = Number(e.target.value);
                                  if (Number.isFinite(n))
                                    update(cfg => {
                                      cfg.ladders[svc][idx]!.maxSqft = Math.round(n);
                                    });
                                }}
                              />
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {hoursInput(
                              band.hours,
                              n =>
                                update(cfg => {
                                  cfg.ladders[svc][idx]!.hours = n;
                                }),
                              `${SERVICE_LABELS[svc] ?? svc} band ${idx + 1} hours`
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {bands.length > 1 && band.maxSqft !== Infinity && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                aria-label={`Remove ${SERVICE_LABELS[svc] ?? svc} band ${idx + 1}`}
                                onClick={() =>
                                  update(cfg => {
                                    cfg.ladders[svc].splice(idx, 1);
                                  })
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                }
                cards={bands.map((band, idx) => (
                  <div key={idx} className="space-y-2 px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {durationRangeLabel(band, bands[idx - 1])}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Max sq ft (mobile)
                        {band.maxSqft === Infinity ? (
                          <span className="text-xs">Open-ended</span>
                        ) : (
                          <Input
                            aria-label={`${SERVICE_LABELS[svc] ?? svc} band ${idx + 1} max sq ft`}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step="1"
                            className="h-9 w-24 text-right text-sm"
                            value={band.maxSqft}
                            onChange={e => {
                              const n = Number(e.target.value);
                              if (Number.isFinite(n))
                                update(cfg => {
                                  cfg.ladders[svc][idx]!.maxSqft = Math.round(n);
                                });
                            }}
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Hours
                        {hoursInput(
                          band.hours,
                          n =>
                            update(cfg => {
                              cfg.ladders[svc][idx]!.hours = n;
                            }),
                          `${SERVICE_LABELS[svc] ?? svc} band ${idx + 1} hours`
                        )}
                      </label>
                      {bands.length > 1 && band.maxSqft !== Infinity && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs"
                          aria-label={`Remove ${SERVICE_LABELS[svc] ?? svc} band ${idx + 1}`}
                          onClick={() =>
                            update(cfg => {
                              cfg.ladders[svc].splice(idx, 1);
                            })
                          }
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              />
            </div>
          );
        })}

        <div className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
          <div className="border-b border-border px-4 py-4 lg:px-6">
            <h3 className="font-semibold text-foreground">Other services — flat block</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Commercial and office jobs vary too much for square footage to predict, so they book a fixed block.
            </p>
          </div>
          {DURATION_FLAT_TYPES.map(svc => (
            <div key={svc} className="flex items-center justify-between border-b border-border/60 px-6 py-3 text-sm last:border-0">
              <span className="font-medium text-foreground">{SERVICE_LABELS[svc] ?? svc}</span>
              {hoursInput(
                draft.flatHours[svc],
                n =>
                  update(cfg => {
                    cfg.flatHours[svc] = n;
                  }),
                `${SERVICE_LABELS[svc] ?? svc} hours`
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-6 rounded-2xl bg-muted/50 p-4 text-xs leading-relaxed text-muted-foreground">
        New bookings block the span these ladders give them. Bookings already taken keep the duration they were
        booked with, so changing a ladder never reshuffles a job a customer has already paid for.
      </p>
    </div>
  );
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

  const save = trpc.admin.savePricingConfig.useMutation({
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

  const problems = TIERED.flatMap(svc => tierProblems(draft.tiers[svc], svc));

  const handleSave = () => {
    // Basic sanity: deposit rate 0–100%. Zero is a real mode — no deposit is
    // collected and bookings confirm without a Stripe step.
    if (draft.depositRate < 0 || draft.depositRate > 1) {
      toast.error("Deposit rate must be between 0% and 100%");
      return;
    }
    if (problems.length > 0) {
      toast.error(problems[0]);
      return;
    }
    save.mutate({ config: serializePricingConfig(draft) });
  };

  /** Inserts a tier above the open-ended one, halfway between its neighbours. */
  const addTier = (svc: TieredType) => {
    update(cfg => {
      const tiers = cfg.tiers[svc];
      const lastBoundedIdx = tiers.length - 2;
      const lastBounded = lastBoundedIdx >= 0 ? tiers[lastBoundedIdx] : undefined;
      const previous = lastBoundedIdx >= 1 ? tiers[lastBoundedIdx - 1] : undefined;
      const step = lastBounded && previous ? Math.max(100, lastBounded.maxSqft - previous.maxSqft) : 200;
      const maxSqft = lastBounded ? lastBounded.maxSqft + step : 700;
      const price = lastBounded ? Math.round((lastBounded.price + 20) * 100) / 100 : 99.99;
      tiers.splice(Math.max(0, tiers.length - 1), 0, { maxSqft, price });
    });
  };

  const removeTier = (svc: TieredType, idx: number) => {
    update(cfg => {
      cfg.tiers[svc].splice(idx, 1);
    });
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
        <Button onClick={handleSave} disabled={!dirty || save.isPending || problems.length > 0} className="press">
          {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save pricing
        </Button>
        <Button variant="outline" onClick={handleReset} disabled={save.isPending} className="press bg-card">
          <RotateCcw className="mr-1.5 h-4 w-4" /> Reset to defaults
        </Button>
        {problems.length > 0 ? (
          <span className="text-xs font-medium text-destructive">
            {problems.length} tier {problems.length === 1 ? "problem" : "problems"} to fix before saving
          </span>
        ) : (
          dirty && <span className="text-xs font-medium text-amber-600">Unsaved changes</span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {TIERED.map(svc => {
            const tiers = draft.tiers[svc];
            const topPricedIdx = tiers.reduce((acc, t, i) => (t.customQuote ? acc : i), -1);
            const svcProblems = tierProblems(tiers, svc);
            return (
              <div key={svc} className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4 lg:px-6">
                  <div>
                    <h2 className="font-semibold text-foreground">{SERVICE_LABELS[svc] ?? svc} — rates by size</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {tiers.length} tiers · each row covers up to its max sq ft
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="press h-8 rounded-lg bg-card text-xs"
                    disabled={tiers.length >= MAX_TIERS_PER_SERVICE}
                    onClick={() => addTier(svc)}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add tier
                  </Button>
                </div>
                <TableOrCards
                  table={
                  <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-6 py-2 font-medium">Range</th>
                      <th className="px-2 py-2 font-medium">Max sq ft</th>
                      <th className="px-2 py-2 text-right font-medium">Price</th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tiers.map((tier, idx, arr) => (
                      <tr key={idx} className="border-b border-border/60 last:border-0">
                        <td className="px-6 py-2.5 text-xs font-medium text-foreground">
                          {tierRange(tier, idx > 0 ? arr[idx - 1] : undefined)}
                          {idx === topPricedIdx && (
                            <label className="mt-1 flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                              <input
                                type="checkbox"
                                className="h-3 w-3 accent-primary"
                                checked={Boolean(tier.startingAt)}
                                onChange={e => {
                                  const on = e.target.checked;
                                  update(cfg => {
                                    cfg.tiers[svc][idx].startingAt = on || undefined;
                                  });
                                }}
                              />
                              show as "starting at"
                            </label>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {tier.maxSqft === Infinity ? (
                            <span className="text-xs text-muted-foreground">and up</span>
                          ) : (
                            <Input
                              aria-label={`${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1} max sq ft`}
                              type="number"
                              min={1}
                              step={50}
                              className="h-9 w-24 text-right text-sm"
                              value={tier.maxSqft}
                              onChange={e => {
                                const n = Number(e.target.value);
                                if (Number.isFinite(n)) {
                                  update(cfg => {
                                    cfg.tiers[svc][idx].maxSqft = Math.round(n);
                                  });
                                }
                              }}
                            />
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
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
                        <td className="px-2 py-2.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1}`}
                            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive"
                            disabled={tiers.length <= 1}
                            onClick={() => removeTier(svc, idx)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                  }
                  cards={tiers.map((tier, idx, arr) => (
                    <div key={idx} className="space-y-3 px-4 py-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">
                          {tierRange(tier, idx > 0 ? arr[idx - 1] : undefined)}
                        </p>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1}`}
                          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                          disabled={tiers.length <= 1}
                          onClick={() => removeTier(svc, idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Max sq ft</Label>
                          {tier.maxSqft === Infinity ? (
                            <p className="mt-1.5 h-9 text-xs leading-9 text-muted-foreground">and up</p>
                          ) : (
                            <Input
                              aria-label={`${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1} max sq ft (mobile)`}
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={50}
                              className="mt-1.5 h-9 w-full text-sm"
                              value={tier.maxSqft}
                              onChange={e => {
                                const n = Number(e.target.value);
                                if (Number.isFinite(n)) {
                                  update(cfg => {
                                    cfg.tiers[svc][idx].maxSqft = Math.round(n);
                                  });
                                }
                              }}
                            />
                          )}
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Price</Label>
                          {tier.customQuote ? (
                            <p className="mt-1.5 h-9 text-xs leading-9 text-muted-foreground">Custom quote</p>
                          ) : (
                            <div className="relative mt-1.5">
                              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                $
                              </span>
                              <Input
                                aria-label={`${SERVICE_LABELS[svc] ?? svc} tier ${idx + 1} price (mobile)`}
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="0.01"
                                className="h-9 w-full pl-6 text-right text-sm"
                                value={tier.price}
                                onChange={e => {
                                  const n = parsePrice(e.target.value);
                                  if (n !== null)
                                    update(cfg => {
                                      cfg.tiers[svc][idx].price = n;
                                    });
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                      {idx === topPricedIdx && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-primary"
                            checked={Boolean(tier.startingAt)}
                            onChange={e => {
                              const on = e.target.checked;
                              update(cfg => {
                                cfg.tiers[svc][idx].startingAt = on || undefined;
                              });
                            }}
                          />
                          show as "starting at"
                        </label>
                      )}
                    </div>
                  ))}
                />
                {svcProblems.length > 0 && (
                  <ul className="space-y-1 border-t border-border bg-destructive/5 px-6 py-3 text-xs text-destructive">
                    {svcProblems.map(problem => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

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
              <p className="mt-0.5 text-xs text-muted-foreground">
                Percentage of the estimated total collected at booking via Stripe. Set to 0% to turn deposits off —
                bookings then confirm without payment and the full amount is billed at completion.
              </p>
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

      <JobDurationsSection />
      <AddonCatalogManager />
    </div>
  );
}
