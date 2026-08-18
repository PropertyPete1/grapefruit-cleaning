/**
 * Minimal iCalendar parsing for Airbnb/VRBO availability feeds.
 *
 * These feeds are small and stereotyped — a VCALENDAR of VEVENTs, one per
 * reservation or blocked range — and the only fact this business needs from
 * each is: WHICH reservation (UID) checks out on WHICH day. A full RFC 5545
 * implementation (recurrence, alarms, nested components) would be surface area
 * with no customer behind it; what lives here instead is careful handling of
 * the quirks these two feeds actually exhibit:
 *
 *   - folded lines (RFC 5545 §3.1: continuation lines start with a space/tab);
 *   - all-day ranges (DTEND;VALUE=DATE is EXCLUSIVE — it IS the checkout day);
 *   - date-times in UTC or with a TZID, which must land on the checkout date
 *     in the business's own timezone, not the server's;
 *   - Airbnb's "Not available" blocks and VRBO's "Blocked" rows, which share
 *     the VEVENT shape with real reservations and must never become cleanings.
 */
import { todayInBookingZone } from "@shared/leadTime";

export interface IcalReservation {
  uid: string;
  /** First night, "YYYY-MM-DD" in the business timezone. */
  startDate: string;
  /** CHECKOUT day, "YYYY-MM-DD" in the business timezone — the cleaning day. */
  checkoutDate: string;
  summary: string;
}

export interface IcalParseResult {
  /** Real reservations only — blocked/unavailable ranges are filtered here. */
  reservations: IcalReservation[];
  /** Every VEVENT seen, for the admin "found N events" display. */
  eventCount: number;
}

/**
 * Summaries that mark a VEVENT as a calendar block rather than a guest:
 * Airbnb writes "Airbnb (Not available)", VRBO writes "Blocked"/"Unavailable".
 * Matched loosely — a new phrasing that slips through creates a cleaning the
 * owner can cancel, which is the recoverable direction of the mistake; the
 * alternative (matching reservations allowlist-style) silently drops turnovers
 * when the wording shifts, which is the unrecoverable one.
 */
const NON_RESERVATION_SUMMARY = /not available|unavailable|blocked/i;

/** Unfold RFC 5545 folded lines and split into logical lines. */
export function unfoldIcalLines(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/** "20260901" → "2026-09-01". */
function formatDateValue(value: string): string | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * The business-timezone date a DTSTART/DTEND property lands on.
 *
 * VALUE=DATE is taken literally — an all-day boundary has no instant to
 * convert. A DATE-TIME (with Z, or any TZID — treated as UTC-or-close, which
 * is what these feeds emit) is converted to America/Chicago first: a checkout
 * stamped 04:00Z is still the previous day in Texas, and the crew cleans on
 * Texas days.
 */
export function icalDateInBookingZone(value: string, isDateValue: boolean): string | null {
  if (isDateValue) return formatDateValue(value);
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return formatDateValue(value);
  const [, y, mo, d, h, mi, s2, zulu] = match;
  if (zulu === "Z") {
    const instant = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s2));
    return todayInBookingZone(new Date(instant));
  }
  // Floating or TZID-local time: the wall-clock date is the intended date.
  return `${y}-${mo}-${d}`;
}

/** One raw VEVENT's properties, folded lines resolved, params kept. */
interface RawEvent {
  props: { name: string; params: string; value: string }[];
}

function propOf(event: RawEvent, name: string): { params: string; value: string } | undefined {
  return event.props.find(p => p.name === name);
}

/**
 * Parse an iCalendar document into reservations.
 *
 * Tolerant by design: an event missing a UID or with unparseable dates is
 * skipped (counted, not thrown), because one malformed row must not take down
 * the whole feed's sync. STATUS:CANCELLED events are dropped — both platforms
 * remove cancelled reservations outright, but belt and braces.
 */
export function parseIcalFeed(raw: string): IcalParseResult {
  const lines = unfoldIcalLines(raw);
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = { props: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const nameAndParams = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = nameAndParams.indexOf(";");
    const name = (semi === -1 ? nameAndParams : nameAndParams.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? "" : nameAndParams.slice(semi + 1).toUpperCase();
    current.props.push({ name, params, value });
  }

  const reservations: IcalReservation[] = [];
  for (const event of events) {
    const status = propOf(event, "STATUS")?.value.trim().toUpperCase();
    if (status === "CANCELLED") continue;

    const summary = (propOf(event, "SUMMARY")?.value ?? "")
      .replace(/\\([,;nN])/g, m => (m[1] === "n" || m[1] === "N" ? " " : m[1]!))
      .trim();
    if (NON_RESERVATION_SUMMARY.test(summary)) continue;

    const uid = propOf(event, "UID")?.value.trim();
    const dtstart = propOf(event, "DTSTART");
    const dtend = propOf(event, "DTEND");
    if (!uid || !dtstart || !dtend) continue;

    const startDate = icalDateInBookingZone(dtstart.value.trim(), dtstart.params.includes("VALUE=DATE"));
    const checkoutDate = icalDateInBookingZone(dtend.value.trim(), dtend.params.includes("VALUE=DATE"));
    if (!startDate || !checkoutDate) continue;

    reservations.push({ uid, startDate, checkoutDate, summary });
  }

  return { reservations, eventCount: events.length };
}
