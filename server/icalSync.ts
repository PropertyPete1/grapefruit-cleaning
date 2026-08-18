/**
 * The Airbnb/VRBO sync engine: every reservation's checkout day becomes a
 * cleaning, unattended.
 *
 * Idempotency is the whole design. The reservation UID from the feed is the
 * identity of a turnover; each poll reconciles the feed against the bookings
 * carrying those UIDs:
 *
 *   new UID          → create a cleaning on the checkout day
 *   moved checkout   → move that booking (slot rules apply, fresh placement)
 *   vanished UID     → cancel the booking, if it is still in the future
 *   unchanged        → touch nothing
 *
 * Bookings that have started or finished are never touched — the feed is the
 * source of truth for the future only. Cancelled bookings are never
 * resurrected: an owner who cancelled by hand outranks the calendar.
 *
 * These are trusted recurring clients, so bookings go straight to CONFIRMED
 * with no deposit; the existing completion → approval → balance-link machinery
 * bills each clean afterward (balance = full price, since nothing was paid up
 * front). Lead time is exempt — a same-day reservation still deserves its
 * turnover — but every physical rule holds: open hours, the lunch break,
 * other jobs' spans, finishing before close.
 */
import {
  bookableSlots,
  isSlotBookable,
  type AvailabilityContext,
} from "@shared/availability";
import { durationHoursFor } from "@shared/duration";
import { todayInBookingZone } from "@shared/leadTime";
import { calculateQuote, generateBookingReference } from "@shared/pricing";
import { slotHour } from "@shared/availability";
import type { ConnectedProperty } from "../drizzle/schema";
import * as db from "./db";
import {
  buildAutoCleanScheduledEmail,
  buildFeedFailureAlert,
  buildUnplacedCleanAlert,
  deliverEmail,
  sendOwnerAlert,
} from "./emails";
import { parseIcalFeed, type IcalReservation } from "./ical";
import { loadPricingConfig, loadSchedulingRules, occupiedIntervals, SERVICE_NAMES } from "./routers/booking";

const FEED_TIMEOUT_MS = 10_000;

/**
 * Consecutive failures before the owner hears about a feed. Feeds flake —
 * Airbnb rate-limits, DNS hiccups — and an alert per blip trains the owner to
 * ignore alerts. Three misses on an hourly poll is three hours dark: real.
 */
export const FEED_FAILURE_ALERT_THRESHOLD = 3;

/** Fetch a feed's raw text, with the same posture as the county lookups. */
export async function fetchIcalFeed(url: string): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/calendar, text/plain, */*" },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `Feed responded ${res.status}` };
    const raw = await res.text();
    if (!raw.includes("BEGIN:VCALENDAR")) return { ok: false, error: "Response is not an iCalendar document" };
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network failure" };
  }
}

/**
 * Fetch + parse for the admin save path: a typo'd or revoked URL should
 * bounce at save time with a readable message, not fail silently every hour.
 */
export async function validateIcalFeed(url: string): Promise<{ reservationCount: number; eventCount: number }> {
  const fetched = await fetchIcalFeed(url);
  if (!fetched.ok) throw new Error(`Could not read the calendar feed: ${fetched.error}`);
  const parsed = parseIcalFeed(fetched.raw);
  return { reservationCount: parsed.reservations.length, eventCount: parsed.eventCount };
}

/**
 * Pick the slot for a checkout-day cleaning: the property's preferred time,
 * or failing that the nearest LATER slot. Earlier is never offered — the
 * default sits at guest checkout, and a slot before it is a crew walking in
 * on packing guests. Lead time is 0 by design; everything physical applies.
 */
export function pickAutoSlot(args: {
  date: string;
  jobHours: number;
  defaultTime: string;
  context: Omit<AvailabilityContext, "date" | "jobHours" | "leadTimeHours">;
}): string | null {
  const context: AvailabilityContext = {
    ...args.context,
    date: args.date,
    jobHours: args.jobHours,
    leadTimeHours: 0,
  };
  if (isSlotBookable(context, args.defaultTime)) return args.defaultTime;
  const defaultHour = slotHour(args.defaultTime);
  const later = bookableSlots(context)
    .filter(time => slotHour(time) > defaultHour)
    .sort((a, b) => slotHour(a) - slotHour(b));
  return later[0] ?? null;
}

export interface SyncSummary {
  propertyId: number;
  ok: boolean;
  error?: string;
  reservations: number;
  created: number;
  moved: number;
  cancelled: number;
  unplaced: number;
}

/**
 * Reconcile one property's feed. The workhorse — called hourly for every
 * active property, and on demand from the admin "Sync now" button.
 */
export async function syncConnectedProperty(
  property: ConnectedProperty,
  now: Date = new Date()
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    propertyId: property.id,
    ok: false,
    reservations: 0,
    created: 0,
    moved: 0,
    cancelled: 0,
    unplaced: 0,
  };

  const fetched = await fetchIcalFeed(property.icalUrl);
  if (!fetched.ok) {
    const failures = property.consecutiveFailures + 1;
    await db.updateConnectedProperty(property.id, {
      consecutiveFailures: failures,
      lastSyncAt: now,
      lastSyncStatus: fetched.error,
    });
    // Alert exactly once, when the streak crosses the threshold — not on the
    // first blip, and not again every hour after.
    if (failures === FEED_FAILURE_ALERT_THRESHOLD) {
      const alert = buildFeedFailureAlert({
        label: property.label,
        failures,
        lastError: fetched.error,
      });
      await sendOwnerAlert(alert.title, alert.content);
    }
    summary.error = fetched.error;
    return summary;
  }

  const parsed = parseIcalFeed(fetched.raw);
  summary.reservations = parsed.reservations.length;

  const today = todayInBookingZone(now);
  const existing = await db.listAutoBookingsForProperty(property.id);
  const byUid = new Map(existing.map(row => [row.icalUid, row]));
  const feedUids = new Set(parsed.reservations.map(r => r.uid));

  if (property.autoBook) {
    // Only future checkouts become work; a feed shows history rolling off its
    // window, and yesterday is not schedulable.
    const future = parsed.reservations.filter(r => r.checkoutDate >= today);
    for (const reservation of future) {
      const current = byUid.get(reservation.uid);
      if (!current) {
        const outcome = await createAutoBooking(property, reservation);
        if (outcome === "created") summary.created += 1;
        if (outcome === "unplaced") {
          summary.created += 1;
          summary.unplaced += 1;
        }
        continue;
      }
      // The feed governs the future only, and never overrides a human:
      // started/finished cleans are history, a hand-cancelled booking stays
      // cancelled.
      if (current.status !== "confirmed") continue;
      if (current.scheduledDate === reservation.checkoutDate) {
        // Date unchanged. If it never found a slot, keep trying — space frees
        // up — but quietly: the owner was alerted when it first failed.
        if (current.scheduledDate === null || current.scheduledTime === null) {
          const placed = await placeBooking(property, current.id, reservation.checkoutDate, { quiet: true });
          if (placed === "placed") summary.moved += 1;
        }
        continue;
      }
      if (current.scheduledDate === null) {
        // Unplaced booking whose reservation moved: place it on the new day.
        const placed = await placeBooking(property, current.id, reservation.checkoutDate, { quiet: true });
        if (placed === "placed") summary.moved += 1;
        else summary.unplaced += 1;
        continue;
      }
      const moved = await placeBooking(property, current.id, reservation.checkoutDate, {
        quiet: false,
        reference: current.reference,
      });
      if (moved === "placed") summary.moved += 1;
      else summary.unplaced += 1;
    }

    // Vanished reservations: the guest cancelled. Cancel the cleaning — but
    // only while it is still ahead of us, and only if no human intervened.
    for (const row of existing) {
      if (!row.icalUid || feedUids.has(row.icalUid)) continue;
      if (row.status !== "confirmed") continue;
      const stillAhead = row.scheduledDate === null || row.scheduledDate >= today;
      if (!stillAhead) continue;
      await db.updateBooking(row.id, { status: "cancelled" });
      summary.cancelled += 1;
    }
  }

  await db.updateConnectedProperty(property.id, {
    consecutiveFailures: 0,
    lastSyncAt: now,
    lastSyncStatus: "ok",
    reservationCount: parsed.reservations.length,
  });
  summary.ok = true;
  return summary;
}

/**
 * Create the cleaning for a new reservation: priced from the live config by
 * the property's stored facts, confirmed with no deposit, slot from
 * pickAutoSlot — or unscheduled plus an owner alert when the day is full.
 * A turnover is never silently dropped.
 */
async function createAutoBooking(
  property: ConnectedProperty,
  reservation: IcalReservation
): Promise<"created" | "unplaced"> {
  const pricing = await loadPricingConfig();
  const quote = calculateQuote(
    {
      type: property.serviceType,
      bedrooms: 2,
      bathrooms: 1,
      sqft: property.sqft,
      extras: [],
      frequency: "onetime",
    },
    pricing
  );
  const { schedule, lunchBreak, durations } = await loadSchedulingRules();
  const jobHours = durationHoursFor(property.serviceType, property.sqft, durations);
  const rows = await db.getOccupiedBookings(reservation.checkoutDate);
  const time = pickAutoSlot({
    date: reservation.checkoutDate,
    jobHours,
    defaultTime: property.defaultTime,
    context: { schedule, lunchBreak, occupied: occupiedIntervals(rows, durations) },
  });

  const reference = generateBookingReference();
  const base = {
    reference,
    customerId: property.customerId,
    propertyId: property.id,
    icalUid: reservation.uid,
    kind: "ical_auto" as const,
    serviceType: property.serviceType,
    frequency: "onetime" as const,
    bedrooms: 2,
    bathrooms: 1,
    sqft: property.sqft,
    estimatedHours: jobHours,
    extras: JSON.stringify([]),
    addressLine: property.addressLine,
    unitNumber: property.unitNumber,
    propertyType: property.propertyType,
    city: property.city,
    zip: property.zip,
    notes: `Auto-booked from ${property.label} calendar — guest checkout ${reservation.checkoutDate}.`,
    locale: "en" as const,
    totalAmount: quote.total,
    // No deposit, by design: trusted recurring hosts are billed in full by the
    // balance link after each clean.
    depositAmount: 0,
    status: "confirmed" as const,
  };

  const insert = async (slot: { date: string; time: string } | null) =>
    db.createBooking(
      slot
        ? { ...base, scheduledDate: slot.date, scheduledTime: slot.time }
        : { ...base, scheduledDate: null, scheduledTime: null }
    );

  let unplacedReason: string | null = null;
  if (time) {
    try {
      await insert({ date: reservation.checkoutDate, time });
      await maybeSendPerCleanNotice(property, reservation.checkoutDate, time);
      return "created";
    } catch (error) {
      // Two syncs racing on the same NEW reservation: the loser's insert hits
      // the (propertyId, icalUid) unique index. The booking exists — done.
      if (db.isDuplicateUidError(error)) return "created";
      if (!db.isSlotTakenError(error)) throw error;
      // A customer landed on the slot between the check and the write. The
      // turnover still exists — fall through to unscheduled, never dropped.
      unplacedReason = "The time was taken at the moment of booking.";
    }
  } else {
    unplacedReason = `No slot at or after ${property.defaultTime} fits a ${jobHours}h clean that day.`;
  }

  try {
    await insert(null);
  } catch (error) {
    if (db.isDuplicateUidError(error)) return "created";
    throw error;
  }
  const alert = buildUnplacedCleanAlert({
    label: property.label,
    reference,
    checkoutDate: reservation.checkoutDate,
    reason: unplacedReason ?? "No slot available.",
  });
  await sendOwnerAlert(alert.title, alert.content);
  await maybeSendPerCleanNotice(property, reservation.checkoutDate, null);
  return "unplaced";
}

/**
 * (Re-)place an existing auto booking on a day — the moved-reservation and
 * retry-unplaced paths. `quiet` suppresses the owner alert for the silent
 * hourly retry of an already-alerted booking.
 */
async function placeBooking(
  property: ConnectedProperty,
  bookingId: number,
  date: string,
  options: { quiet: boolean; reference?: string }
): Promise<"placed" | "unplaced"> {
  const { schedule, lunchBreak, durations } = await loadSchedulingRules();
  const jobHours = durationHoursFor(property.serviceType, property.sqft, durations);
  const rows = (await db.getOccupiedBookings(date)).filter(row => row.id !== bookingId);
  const time = pickAutoSlot({
    date,
    jobHours,
    defaultTime: property.defaultTime,
    context: { schedule, lunchBreak, occupied: occupiedIntervals(rows, durations) },
  });

  if (time) {
    try {
      await db.updateBooking(bookingId, { scheduledDate: date, scheduledTime: time, estimatedHours: jobHours });
      await maybeSendPerCleanNotice(property, date, time);
      return "placed";
    } catch (error) {
      if (!db.isSlotTakenError(error)) throw error;
    }
  }
  await db.updateBooking(bookingId, { scheduledDate: null, scheduledTime: null });
  if (!options.quiet) {
    const alert = buildUnplacedCleanAlert({
      label: property.label,
      reference: options.reference ?? String(bookingId),
      checkoutDate: date,
      reason: `The reservation moved to ${date}, and no slot at or after ${property.defaultTime} fits there.`,
    });
    await sendOwnerAlert(alert.title, alert.content);
  }
  return "unplaced";
}

/** The optional per-clean notice, for hosts who asked for one. */
async function maybeSendPerCleanNotice(
  property: ConnectedProperty,
  date: string,
  time: string | null
): Promise<void> {
  if (!property.perCleanEmails) return;
  const customer = await db.getCustomerById(property.customerId);
  if (!customer?.email) return;
  const locale = (customer.preferredLocale as "en" | "es") ?? "en";
  const { subject, body } = buildAutoCleanScheduledEmail({
    label: property.label,
    date,
    time,
    customerName: customer.firstName,
    locale,
  });
  await deliverEmail(customer.email, subject, body);
}

/** The hourly entry point: every active feed, one summary line each. */
export async function syncAllProperties(now: Date = new Date()): Promise<SyncSummary[]> {
  const properties = await db.listActiveSyncProperties();
  const summaries: SyncSummary[] = [];
  for (const property of properties) {
    try {
      summaries.push(await syncConnectedProperty(property, now));
    } catch (error) {
      // One property's surprise must not stop the rest of the fleet.
      console.error(`[iCalSync] Property ${property.id} failed:`, error);
      summaries.push({
        propertyId: property.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        reservations: 0,
        created: 0,
        moved: 0,
        cancelled: 0,
        unplaced: 0,
      });
    }
  }
  return summaries;
}

/** What the setup-confirmation email needs, resolved from the property. */
export function propertyServiceName(property: ConnectedProperty, locale: "en" | "es"): string {
  return SERVICE_NAMES[property.serviceType]?.[locale] ?? property.serviceType;
}
