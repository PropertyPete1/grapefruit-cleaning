/**
 * How long a job actually takes — the span a booking occupies on the calendar.
 *
 * Every booking used to occupy only the hour it started in, so a deep clean
 * running from 11:00 left 12:00 and 13:00 showing free and a second customer
 * could book straight into a crew that was still on site.
 *
 * Estimated duration comes from service type + square footage, on the same
 * shape of ladder as pricing: an ordered table of exclusive `maxSqft` upper
 * bounds ending in one unbounded tier. Thresholds are exclusive exactly as in
 * shared/pricing.ts, so a 1,000 sq ft home falls into the same band for its
 * duration as it does for its price — one mental model for both ladders.
 *
 * Stored under its own setting key rather than inside `pricing_config`, for
 * three reasons. The pricing editor saves by re-serializing the entire config
 * it loaded, so durations living in there would be silently reverted by a
 * pricing save from a stale tab. `booking.pricingConfig` is a public procedure
 * and duration is not customer-facing. And the two have genuinely different
 * lifecycles — a price change is a business decision, a duration change is an
 * operational one.
 *
 * Durations are whole hours. Slots are hourly, so a half hour would change
 * nothing about which slots a job blocks — only whether it is judged to fit
 * before closing, which is not worth the extra config surface.
 */

import { z } from "zod";
import type { CleaningType, TieredType } from "./pricing";

/** One duration band, keyed by exclusive max square footage. */
export interface DurationTier {
  /** Upper bound in sq ft; `sqft < maxSqft` matches. Infinity = top tier. */
  maxSqft: number;
  /** Whole hours a crew spends on site for a home in this band. */
  hours: number;
}

/**
 * Services booked as a flat block rather than off a size ladder. Commercial and
 * office spaces vary too widely for square footage to predict the work, exactly
 * as they do for pricing, where they take a custom-quote baseline.
 */
export type FlatDurationType = "commercial" | "office";

/** Everything the admin can edit about how long jobs take. */
export interface DurationConfig {
  /** Size ladders for the services that have them. Airbnb follows residential. */
  ladders: Record<TieredType, DurationTier[]>;
  /** Flat block for the services with no size ladder. */
  flatHours: Record<FlatDurationType, number>;
}

/** Setting key under which the duration override JSON is stored. */
export const DURATION_SETTING_KEY = "job_durations";

/** Longest single job the scheduler will accept — a full working day. */
export const MAX_DURATION_HOURS = 12;

/** Hard cap on bands per service, mirroring the pricing ladder's limit. */
export const MAX_DURATION_TIERS_PER_SERVICE = 25;

/**
 * Defaults: a standard clean runs 2 hours for a small home and 5 for the
 * largest; deep cleans and move in/outs run about an hour longer per band,
 * which is the 3–6 hour range those jobs take in practice. Commercial and
 * office work has no size ladder and books a flat half-day block.
 */
export const DEFAULT_DURATIONS: DurationConfig = {
  ladders: {
    residential: [
      { maxSqft: 1000, hours: 2 },
      { maxSqft: 2000, hours: 3 },
      { maxSqft: 3500, hours: 4 },
      { maxSqft: Infinity, hours: 5 },
    ],
    deep: [
      { maxSqft: 1000, hours: 3 },
      { maxSqft: 2000, hours: 4 },
      { maxSqft: 3500, hours: 5 },
      { maxSqft: Infinity, hours: 6 },
    ],
    moveinout: [
      { maxSqft: 1000, hours: 3 },
      { maxSqft: 2000, hours: 4 },
      { maxSqft: 3500, hours: 5 },
      { maxSqft: Infinity, hours: 6 },
    ],
  },
  flatHours: {
    commercial: 4,
    office: 4,
  },
};

/** Services that carry their own duration ladder. */
export const DURATION_LADDER_TYPES: TieredType[] = ["residential", "deep", "moveinout"];

/** Services booked as a flat block. */
export const DURATION_FLAT_TYPES: FlatDurationType[] = ["commercial", "office"];

/**
 * Last-resort duration for a service the config says nothing about — a type
 * added to the enum before its ladder was configured. Never silently zero:
 * a zero-hour job would block nothing, which is the bug this module exists to
 * fix.
 */
export const FALLBACK_DURATION_HOURS = 3;

// ---------------------------------------------------------------------------
// Read path — lenient, mirrors parsePricingConfig
// ---------------------------------------------------------------------------

/** JSON cannot encode Infinity, so the top band stores maxSqft: null. */
const tierSchema = z.object({
  maxSqft: z.union([z.number().positive(), z.null()]).transform(v => (v === null ? Infinity : v)),
  hours: z.number().min(1).max(MAX_DURATION_HOURS),
});

const ladderSchema = z
  .array(tierSchema)
  .min(1)
  .refine(table => table.some(t => !Number.isFinite(t.maxSqft)), {
    message: "duration ladder must end with an unbounded (null maxSqft) band",
  });

const flatHoursSchema = z.number().min(1).max(MAX_DURATION_HOURS);

const durationConfigSchema = z.object({
  ladders: z.object({
    residential: ladderSchema,
    deep: ladderSchema,
    moveinout: ladderSchema,
  }),
  flatHours: z.object({
    commercial: flatHoursSchema,
    office: flatHoursSchema,
  }),
});

/**
 * Parse a stored job_durations payload. Anything missing or invalid falls back
 * to the defaults, so a corrupt setting can never leave the scheduler without
 * a duration for a job — which would silently take the blocking back off.
 */
export function parseDurationConfig(raw: string | null | undefined): DurationConfig {
  if (!raw) return DEFAULT_DURATIONS;
  try {
    const parsed = durationConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_DURATIONS;
    const sort = (table: DurationTier[]) => [...table].sort((a, b) => a.maxSqft - b.maxSqft);
    return {
      ladders: {
        residential: sort(parsed.data.ladders.residential),
        deep: sort(parsed.data.ladders.deep),
        moveinout: sort(parsed.data.ladders.moveinout),
      },
      flatHours: parsed.data.flatHours,
    };
  } catch {
    return DEFAULT_DURATIONS;
  }
}

/** Serialize a DurationConfig to JSON (Infinity → null for the top bands). */
export function serializeDurationConfig(config: DurationConfig): string {
  return JSON.stringify(config, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? null : value
  );
}

// ---------------------------------------------------------------------------
// Write path — strict, mirrors validatePricingConfig
// ---------------------------------------------------------------------------

const storedTierSchema = z.object({
  maxSqft: z.union([z.number(), z.null()]),
  hours: z.number(),
});

type StoredDurationTier = z.infer<typeof storedTierSchema>;

/**
 * Enforces the ladder invariants the scheduler depends on: strictly increasing
 * whole-number thresholds, whole positive hours within the cap, and exactly one
 * unbounded band at the end so every home size resolves to a duration.
 *
 * The read path stays lenient on purpose. This runs on writes, where a bad
 * ladder must be refused rather than silently ignored.
 */
function validateLadder(table: StoredDurationTier[], ctx: z.RefinementCtx): void {
  const unboundedAt = table.flatMap((tier, index) => (tier.maxSqft === null ? [index] : []));
  if (unboundedAt.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "the last band must be unbounded (no max sq ft) so every home size has a duration",
    });
  } else if (unboundedAt.length > 1) {
    ctx.addIssue({ code: "custom", message: "only one unbounded band is allowed" });
  } else if (unboundedAt[0] !== table.length - 1) {
    ctx.addIssue({ code: "custom", message: "the unbounded band must be the last one in the ladder" });
  }

  let previous = 0;
  table.forEach((tier, index) => {
    if (!Number.isInteger(tier.hours) || tier.hours < 1 || tier.hours > MAX_DURATION_HOURS) {
      ctx.addIssue({
        code: "custom",
        path: [index, "hours"],
        message: `band ${index + 1}: hours must be a whole number between 1 and ${MAX_DURATION_HOURS}`,
      });
    }
    if (tier.maxSqft === null) return;
    if (!Number.isInteger(tier.maxSqft) || tier.maxSqft <= 0) {
      ctx.addIssue({
        code: "custom",
        path: [index, "maxSqft"],
        message: `band ${index + 1}: max sq ft must be a positive whole number`,
      });
      return;
    }
    if (tier.maxSqft <= previous) {
      ctx.addIssue({
        code: "custom",
        path: [index, "maxSqft"],
        message: `band ${index + 1}: max sq ft (${tier.maxSqft}) must be greater than the previous band's ${previous}`,
      });
      return;
    }
    previous = tier.maxSqft;
  });
}

const strictLadderSchema = z
  .array(storedTierSchema)
  .min(1, "at least one band is required")
  .max(MAX_DURATION_TIERS_PER_SERVICE, `at most ${MAX_DURATION_TIERS_PER_SERVICE} bands are allowed`)
  .superRefine(validateLadder)
  .transform(table => table.map(t => ({ ...t, maxSqft: t.maxSqft === null ? Infinity : t.maxSqft })));

const strictFlatHoursSchema = z
  .number()
  .int("must be a whole number of hours")
  .min(1, "must be at least 1 hour")
  .max(MAX_DURATION_HOURS, `must be at most ${MAX_DURATION_HOURS} hours`);

const strictDurationConfigSchema = z.object({
  ladders: z.object({
    residential: strictLadderSchema,
    deep: strictLadderSchema,
    moveinout: strictLadderSchema,
  }),
  flatHours: z.object({
    commercial: strictFlatHoursSchema,
    office: strictFlatHoursSchema,
  }),
});

export type DurationValidation =
  | { ok: true; config: DurationConfig }
  | { ok: false; errors: string[] };

/**
 * Validates a duration config on the way IN (admin save). Accepts a JSON string
 * or a plain object, and returns readable errors rather than falling back to
 * defaults, so an admin never saves a ladder the scheduler would then ignore.
 */
export function validateDurationConfig(raw: unknown): DurationValidation {
  let candidate = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["duration config is not valid JSON"] };
    }
  }
  const parsed = strictDurationConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(issue => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  return { ok: true, config: parsed.data };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Estimated hours on site for a job, from its service type and size.
 *
 * Airbnb turnovers follow the residential ladder, exactly as their price does.
 * Commercial and office work has no size ladder and takes its flat block.
 */
export function durationHoursFor(
  type: CleaningType | string,
  sqft: number,
  config: DurationConfig = DEFAULT_DURATIONS
): number {
  const key = type === "airbnb" ? "residential" : type;
  const ladder =
    key === "residential" || key === "deep" || key === "moveinout" ? config.ladders[key] : null;
  if (!ladder || ladder.length === 0) {
    return config.flatHours[type as FlatDurationType] ?? FALLBACK_DURATION_HOURS;
  }
  for (const tier of ladder) {
    if (sqft < tier.maxSqft) return tier.hours;
  }
  return ladder[ladder.length - 1]!.hours;
}

/**
 * Human label for a duration band's size range, derived from the band and the
 * one below it — never from hard-coded boundaries, so it stays correct however
 * the admin reshapes the ladder.
 */
export function durationRangeLabel(tier: DurationTier, previous: DurationTier | undefined): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (!previous) {
    return tier.maxSqft === Infinity ? "Any size" : `Under ${fmt(tier.maxSqft)} sq ft`;
  }
  if (tier.maxSqft === Infinity) return `Over ${fmt(previous.maxSqft)} sq ft`;
  return `${fmt(previous.maxSqft)}–${fmt(tier.maxSqft)} sq ft`;
}
