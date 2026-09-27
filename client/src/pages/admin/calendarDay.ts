/**
 * Pure helpers behind the calendar's day panel — kept free of React so the
 * ordering and the date label can be pinned by the server-side test suite.
 */

/** Timed jobs in start order; jobs whose time is still to be decided go last. */
export function sortDayBookings<T extends { scheduledTime: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.scheduledTime ?? "99:99").localeCompare(b.scheduledTime ?? "99:99"));
}

/**
 * "Tuesday, September 30, 2026" for a YYYY-MM-DD. Anchored at noon so the
 * label can never slip a day through a timezone conversion.
 */
export function longDateLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
