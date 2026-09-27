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
 * "Moved" is judged against the checkout date the feed LAST reported
 * (bookings.icalSourceDate), never against the date the cleaning sits on: an
 * owner may deliberately clean the day after checkout, and a poll that only
 * compared scheduledDate would drag the job back every hour. One unit checks
 * out once per day, so a second reservation landing on a checkout day that
 * already has a live turnover is the same clean seen twice and is skipped.
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
import { holdsCalendarSlot } from "@shared/bookingStatus";
import type { ConnectedProperty } from "../drizzle/schema";
import * as db from "./db";
import {
  buildAutoCleanCancelledAlert,
  buildAutoCleanCancelledEmail,
  buildAutoCleanScheduledEmail,
  buildFeedFailureAlert,
  buildUnplacedCleanAlert,
  deliverEmail,
  sendCleanerRescheduleNotice,
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
  /** Reservations skipped because the property already has a live turnover on that checkout day. */
  duplicates: number;
}

/**
 * The checkout date the feed last reported for a booking. Rows written before
 * icalSourceDate existed fall back to their scheduled date, which is exactly
 * what they used to be compared by.
 */
function feedDateOf(row: { icalSourceDate: string | null; scheduledDate: string | null }): string | null {
  return row.icalSourceDate ?? row.scheduledDate;
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
    duplicates: 0,
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
  // Mutable copies: a reservation cancelled earlier in this poll must count as
  // cancelled for the rest of it — the same-day guard below reads status.
  const existing = (await db.listAutoBookingsForProperty(property.id)).map(row => ({ ...row }));
  const byUid = new Map(existing.map(row => [row.icalUid, row]));
  const feedUids = new Set(parsed.reservations.map(r => r.uid));

  if (property.autoBook) {
    // Vanished reservations first: the guest cancelled. Cancel the cleaning —
    // but only while it is still ahead of us, and only if no human intervened.
    // Cancellations run before creations so a replacement reservation on the
    // same checkout day can take the cancelled one's place within one poll.
    for (const row of existing) {
      if (!row.icalUid || feedUids.has(row.icalUid)) continue;
      if (row.status !== "confirmed") continue;
      const stillAhead = row.scheduledDate === null || row.scheduledDate >= today;
      if (!stillAhead) continue;
      await db.updateBooking(row.id, { status: "cancelled" });
      row.status = "cancelled";
      summary.cancelled += 1;
      // Somebody has to be told. Cancelling silently leaves the host assuming a
      // clean is booked for a unit that may now be occupied or unsold, and
      // leaves the crew watching a job vanish from the schedule with no
      // explanation. Both notices are best-effort: a mail failure must not stop
      // the rest of the reconciliation.
      await notifyTurnoverCancelled(property, row);
    }

    // Only future checkouts become work; a feed shows history rolling off its
    // window, and yesterday is not schedulable.
    const future = parsed.reservations.filter(r => r.checkoutDate >= today);
    for (const reservation of future) {
      const current = byUid.get(reservation.uid);
      if (!current) {
        // One unit checks out once per day. A second reservation UID on a
        // checkout day that already has a live turnover is the same clean seen
        // twice — a re-issued reservation, a cross-listed feed — never a second
        // crew. Skipped and counted; re-evaluated every poll, so once the first
        // booking is cancelled the newcomer takes its place.
        const twin = existing.find(
          row =>
            row.icalUid !== reservation.uid &&
            holdsCalendarSlot(row.status) &&
            feedDateOf(row) === reservation.checkoutDate
        );
        if (twin) {
          summary.duplicates += 1;
          continue;
        }
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

      const lastSeen = feedDateOf(current);
      if (lastSeen === reservation.checkoutDate) {
        // The host's date is unchanged — whatever day the cleaning sits on.
        if (current.icalSourceDate == null) {
          // One quiet backfill for rows from before this column was written,
          // so the next hand move of this booking is respected too.
          await db.updateBooking(current.id, { icalSourceDate: reservation.checkoutDate });
          current.icalSourceDate = reservation.checkoutDate;
        }
        // If it never found a slot, keep trying — space frees up — but quietly:
        // the owner was alerted when it first failed. The retry lands on the
        // booking's own date, which may be one the owner chose by hand.
        if (current.scheduledDate === null || current.scheduledTime === null) {
          const placed = await placeBooking(
            property,
            current.id,
            { date: current.scheduledDate ?? reservation.checkoutDate, sourceDate: reservation.checkoutDate },
            { quiet: true }
          );
          if (placed === "placed") summary.moved += 1;
        }
        continue;
      }
      // The host's calendar moved the checkout: follow it.
      const target = { date: reservation.checkoutDate, sourceDate: reservation.checkoutDate };
      if (current.scheduledDate === null) {
        // A dateless legacy row whose reservation moved: place it on the new day.
        const placed = await placeBooking(property, current.id, target, { quiet: true });
        if (placed === "placed") summary.moved += 1;
        else summary.unplaced += 1;
        continue;
      }
      const moved = await placeBooking(property, current.id, target, {
        quiet: false,
        reference: current.reference,
      });
      if (moved === "placed") summary.moved += 1;
      else summary.unplaced += 1;
    }
  }

  await db.updateConnectedProperty(property.id, {
    consecutiveFailures: 0,
    lastSyncAt: now,
    lastSuccessfulSyncAt: now,
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
    icalSourceDate: reservation.checkoutDate,
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

  // The checkout day is always known, even when no start time fits: an
  // unplaced turnover is inserted date-known/time-pending, so it shows on the
  // calendar as "time to be decided" rather than vanishing until someone
  // places it. Holding no time, it holds no inventory (slotKey stays NULL).
  const insert = async (slot: { date: string; time: string | null }) =>
    db.createBooking({ ...base, scheduledDate: slot.date, scheduledTime: slot.time });

  let unplacedReason: string | null = null;
  if (time) {
    try {
      const id = await insert({ date: reservation.checkoutDate, time });
      await sendTurnoverScheduledNotice(property, id, reservation.checkoutDate, time, false);
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

  let unplacedId: number;
  try {
    unplacedId = await insert({ date: reservation.checkoutDate, time: null });
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
  // The host still hears that the checkout is covered — the date is known even
  // when the time is not, and the template says so rather than implying a slot.
  await sendTurnoverScheduledNotice(property, unplacedId, reservation.checkoutDate, null, false);
  return "unplaced";
}

/**
 * (Re-)place an existing auto booking on a day — the moved-reservation and
 * retry-unplaced paths. `quiet` suppresses the owner alert for the silent
 * hourly retry of an already-alerted booking.
 *
 * `target.date` is where the cleaning goes; `target.sourceDate` is the checkout
 * the feed reported and is what the next poll compares against. They differ
 * when a quiet retry places a turnover the owner moved by hand: the cleaning
 * stays on the owner's day while the row keeps remembering the host's.
 */
async function placeBooking(
  property: ConnectedProperty,
  bookingId: number,
  target: { date: string; sourceDate: string },
  options: { quiet: boolean; reference?: string }
): Promise<"placed" | "unplaced"> {
  const { date, sourceDate } = target;
  const before = await db.getBookingById(bookingId);
  if (!before || before.status !== "confirmed") return "unplaced";
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
      const moved = await db.moveBookingSchedule({
        bookingId,
        toDate: date,
        toTime: time,
        estimatedHours: jobHours,
        icalSourceDate: sourceDate,
        actorType: "ical",
        actorLabel: property.label,
        action: options.quiet ? "ical_retry_placed" : "ical_moved",
        note: options.quiet ? `Turnover placed at ${time} on ${date}.` : `Airbnb checkout moved to ${date}.`,
      });
      if (moved.outcome !== "moved") return "unplaced";
      // `quiet` marks the hourly retry of an already-announced turnover. The
      // date-keyed claim inside the notice is what actually prevents a repeat,
      // but the flag carries the intent: a retry landing on the SAME date is
      // silent, while a reservation that genuinely MOVED is a reschedule and
      // says so.
      await sendTurnoverScheduledNotice(property, bookingId, date, time, !options.quiet);
      await notifyAssignedCleanerOfIcalMove(moved.before, moved.after, property.label);
      return "placed";
    } catch (error) {
      if (!db.isSlotTakenError(error)) throw error;
    }
  }
  const pending = await db.moveBookingSchedule({
    bookingId,
    toDate: date,
    toTime: null,
    estimatedHours: jobHours,
    icalSourceDate: sourceDate,
    actorType: "ical",
    actorLabel: property.label,
    action: "ical_pending_time",
    note: `Airbnb checkout moved to ${date}; no legal start time is available yet.`,
  });
  if (pending.outcome === "moved") {
    await sendTurnoverScheduledNotice(property, bookingId, date, null, !options.quiet);
    await notifyAssignedCleanerOfIcalMove(pending.before, pending.after, property.label);
  }
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

async function notifyAssignedCleanerOfIcalMove(
  before: NonNullable<Awaited<ReturnType<typeof db.getBookingById>>>,
  after: NonNullable<Awaited<ReturnType<typeof db.getBookingById>>>,
  label: string
): Promise<void> {
  if (!after.employeeId) return;
  const employee = await db.getEmployeeById(after.employeeId);
  if (!employee?.email) return;
  await sendCleanerRescheduleNotice({
    bookingId: after.id,
    reference: after.reference,
    customerName: "",
    locale: "en",
    fromDate: before.scheduledDate,
    fromTime: before.scheduledTime,
    toDate: after.scheduledDate ?? "",
    toTime: after.scheduledTime,
    note: `Airbnb calendar update for ${label}.`,
    employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
    employeeEmail: employee.email,
  });
}

/**
 * Tells the host a turnover is on the schedule — ALWAYS, and at most once per
 * scheduled date.
 *
 * Unconditional by design: scheduling confirmation is not a per-clean report,
 * so `perCleanEmails` does not gate it. "Your next guest is covered" is the one
 * message a host actually needs from this system, and a host who declined
 * running commentary on each clean has not declined that.
 *
 * The dedupe is a date-keyed claim rather than a boolean flag, because the
 * hourly sweep re-places turnovers that could not find a slot. Claiming the
 * date means: same date, already announced → silent; new date → this is a
 * reschedule and the host hears it. The claim is also the race guard for two
 * syncs hitting one reservation.
 */
async function sendTurnoverScheduledNotice(
  property: ConnectedProperty,
  bookingId: number,
  date: string,
  time: string | null,
  rescheduled: boolean
): Promise<void> {
  try {
    if (!(await db.claimTurnoverNotice(bookingId, date))) return;
    const customer = await db.getCustomerById(property.customerId);
    if (!customer?.email) return;
    const locale = (customer.preferredLocale as "en" | "es") ?? "en";
    const { subject, body } = buildAutoCleanScheduledEmail({
      label: property.label,
      date,
      time,
      customerName: customer.firstName,
      locale,
      rescheduled,
      addressLine: property.addressLine,
    });
    await deliverEmail(customer.email, subject, body, undefined, {
      emailType: rescheduled ? "ical_turnover_moved" : "ical_turnover_scheduled",
      bookingId,
    });
  } catch (error) {
    // One host's mail problem must not abort the reconciliation of the rest of
    // the feed — the booking itself is already correct in the database.
    console.error(`[iCalSync] Turnover notice failed for booking ${bookingId}:`, error);
  }
}

/**
 * Tells the host, and the owner, that a cancelled reservation took its cleaning
 * off the schedule.
 *
 * Also unconditional, for the same reason as the scheduling notice: the crew is
 * no longer coming, and silence there is the expensive kind. The owner alert
 * rides the existing owner-alert path so it lands wherever the other operational
 * alerts land.
 */
async function notifyTurnoverCancelled(
  property: ConnectedProperty,
  row: { id: number; reference: string; scheduledDate: string | null; scheduledTime: string | null }
): Promise<void> {
  try {
    const customer = await db.getCustomerById(property.customerId);
    if (customer?.email) {
      const locale = (customer.preferredLocale as "en" | "es") ?? "en";
      const { subject, body } = buildAutoCleanCancelledEmail({
        label: property.label,
        date: row.scheduledDate,
        time: row.scheduledTime,
        customerName: customer.firstName,
        locale,
      });
      await deliverEmail(customer.email, subject, body, undefined, {
        emailType: "ical_turnover_cancelled",
        bookingId: row.id,
      });
    }
    const alert = buildAutoCleanCancelledAlert({
      label: property.label,
      reference: row.reference,
      date: row.scheduledDate,
      time: row.scheduledTime,
    });
    await sendOwnerAlert(alert.title, alert.content);
  } catch (error) {
    console.error(`[iCalSync] Cancellation notice failed for booking ${row.id}:`, error);
  }
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
        duplicates: 0,
      });
    }
  }
  return summaries;
}

/** What the setup-confirmation email needs, resolved from the property. */
export function propertyServiceName(property: ConnectedProperty, locale: "en" | "es"): string {
  return SERVICE_NAMES[property.serviceType]?.[locale] ?? property.serviceType;
}
