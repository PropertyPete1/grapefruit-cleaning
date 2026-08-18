/**
 * iCal parsing against the feeds as Airbnb and VRBO actually emit them —
 * folded lines, all-day exclusive DTENDs, UTC timestamps that cross midnight
 * in Texas, and the "Not available" blocks that share a shape with real
 * reservations and must never become cleanings.
 */
import { describe, expect, it } from "vitest";
import { icalDateInBookingZone, parseIcalFeed, unfoldIcalLines } from "./ical";

/** A feed as Airbnb emits it: CRLF, folded DESCRIPTION, mixed event kinds. */
const AIRBNB_FEED = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN",
  "CALSCALE:GREGORIAN",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTAMP:20260810T120000Z",
  "DTSTART;VALUE=DATE:20260901",
  "DTEND;VALUE=DATE:20260905",
  "SUMMARY:Reserved",
  "UID:1418e1eb2f83-8d1f8526a2a25b4a1b9df3a3@airbnb.com",
  "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de",
  " tails/HMABCDE123\\nPhone Number (Last 4 Digits): 1234",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260810T120000Z",
  "DTSTART;VALUE=DATE:20260906",
  "DTEND;VALUE=DATE:20260910",
  "SUMMARY:Airbnb (Not available)",
  "UID:block-1@airbnb.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260810T120000Z",
  "DTSTART;VALUE=DATE:20260912",
  "DTEND;VALUE=DATE:20260915",
  "SUMMARY:Reserved",
  "UID:99aa1bb2cc3d-4e5f6a7b8c9d0e1f2a3b4c5d@airbnb.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("unfoldIcalLines", () => {
  it("joins RFC 5545 folded continuations, stripping one leading space each", () => {
    // "Hello" + "␣␣wor"(keeps 1 of 2 spaces) + "␣ld"(joins flush) = "Hello world"
    const lines = unfoldIcalLines("SUMMARY:Hello\r\n  wor\r\n ld\r\nUID:x");
    expect(lines[0]).toBe("SUMMARY:Hello world");
    expect(lines[1]).toBe("UID:x");
  });

  it("tolerates bare-LF and CR-only feeds", () => {
    expect(unfoldIcalLines("A:1\nB:2")).toEqual(["A:1", "B:2"]);
    expect(unfoldIcalLines("A:1\rB:2")).toEqual(["A:1", "B:2"]);
  });
});

describe("parseIcalFeed on a real-world Airbnb feed", () => {
  const parsed = parseIcalFeed(AIRBNB_FEED);

  it("counts every event but keeps only real reservations", () => {
    expect(parsed.eventCount).toBe(3);
    expect(parsed.reservations).toHaveLength(2);
    expect(parsed.reservations.map(r => r.uid)).toEqual([
      "1418e1eb2f83-8d1f8526a2a25b4a1b9df3a3@airbnb.com",
      "99aa1bb2cc3d-4e5f6a7b8c9d0e1f2a3b4c5d@airbnb.com",
    ]);
  });

  it("reads the EXCLUSIVE all-day DTEND as the checkout day", () => {
    // Guests staying Sep 1–4 nights have DTEND 20260905 — checkout morning.
    expect(parsed.reservations[0]).toMatchObject({
      startDate: "2026-09-01",
      checkoutDate: "2026-09-05",
    });
  });

  it("survives the folded DESCRIPTION without corrupting neighbours", () => {
    expect(parsed.reservations[0]!.summary).toBe("Reserved");
  });
});

describe("blocked-range filtering", () => {
  it("drops VRBO 'Blocked' and 'Unavailable' rows too", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:vrbo-blocked-1",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261003",
      "SUMMARY:Blocked",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:vrbo-res-1",
      "DTSTART;VALUE=DATE:20261005",
      "DTEND;VALUE=DATE:20261008",
      "SUMMARY:Reserved - Jane D.",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseIcalFeed(feed);
    expect(parsed.reservations.map(r => r.uid)).toEqual(["vrbo-res-1"]);
  });

  it("drops STATUS:CANCELLED events, belt and braces", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:cancelled-1",
      "STATUS:CANCELLED",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261003",
      "SUMMARY:Reserved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcalFeed(feed).reservations).toHaveLength(0);
  });

  it("skips malformed events without failing the feed", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Reserved",
      "DTSTART;VALUE=DATE:20261001",
      "END:VEVENT", // no UID, no DTEND
      "BEGIN:VEVENT",
      "UID:good-1",
      "DTSTART;VALUE=DATE:20261005",
      "DTEND;VALUE=DATE:20261007",
      "SUMMARY:Reserved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseIcalFeed(feed);
    expect(parsed.eventCount).toBe(2);
    expect(parsed.reservations.map(r => r.uid)).toEqual(["good-1"]);
  });
});

describe("timezone handling for DATE-TIME feeds (VRBO style)", () => {
  it("keeps a mid-day UTC checkout on the same Texas day", () => {
    // 16:00Z is 11:00 in Chicago (CDT) — same calendar day.
    expect(icalDateInBookingZone("20260905T160000Z", false)).toBe("2026-09-05");
  });

  it("moves an early-UTC checkout to the previous Texas day", () => {
    // 04:00Z on Sep 5 is 23:00 on Sep 4 in Chicago — the guest leaves on the
    // 4th, Texas time, and that is the day the crew cleans.
    expect(icalDateInBookingZone("20260905T040000Z", false)).toBe("2026-09-04");
  });

  it("takes floating/TZID-local times at face value", () => {
    expect(icalDateInBookingZone("20260905T110000", false)).toBe("2026-09-05");
  });

  it("takes VALUE=DATE literally — an all-day boundary has no instant", () => {
    expect(icalDateInBookingZone("20260905", true)).toBe("2026-09-05");
  });

  it("parses a whole DATE-TIME feed end to end", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:vrbo-dt-1",
      "DTSTART:20261101T210000Z",
      "DTEND:20261105T160000Z",
      "SUMMARY:Reserved - guest",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcalFeed(feed).reservations[0]).toMatchObject({
      checkoutDate: "2026-11-05",
    });
  });
});
