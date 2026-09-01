/**
 * Calendar month-view event chips have to be readable.
 *
 * Both calendars painted their chip text in the same token as the chip's own
 * background fill. On the staff calendar that was `text-secondary` on
 * `bg-secondary/15`: near-white on near-white, 1.08:1, invisible in every cell
 * that was not today's. The admin calendar had the milder version of the same
 * mistake, coral on a coral tint at 2.9:1.
 *
 * A source check rather than a render test (no DOM here, and no computed styles
 * either). What it pins is the rule that was broken: the chip's text token is
 * never the fill token, always the dark `-foreground` pairing meant to sit on
 * it. Contrast ratios in the comments were measured from the oklch values in
 * client/src/index.css.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CALENDARS = [
  ["staff", fileURLToPath(new URL("../client/src/pages/staff/StaffRoutes.tsx", import.meta.url))],
  ["admin", fileURLToPath(new URL("../client/src/pages/admin/AdminCalendar.tsx", import.meta.url))],
] as const;

/** The className of the month-view event chip on a calendar page. */
function chipClasses(path: string): string {
  const source = readFileSync(path, "utf-8");
  const match =
    source.match(/className="(truncate rounded-md bg-[^"]+)"/) ??
    source.match(/className=\{`(truncate rounded-md[\s\S]*?)`\}/);
  expect(match, `no month-view event chip found in ${path}`).toBeTruthy();
  return match![1]!;
}

describe("month-view event chips", () => {
  it.each(CALENDARS)("%s chip text uses a dark foreground token", (_name, path) => {
    // staff: secondary-foreground reads 9.1:1 on the chip, 9.0:1 in today's
    // cell. admin: accent-foreground reads 5.8:1 and 5.5:1. Both clear the
    // 4.5:1 floor, in light and dark themes alike.
    expect(chipClasses(path)).toMatch(/text-(secondary|accent|card|popover|primary)-foreground|text-foreground/);
  });

  it.each(CALENDARS)("%s chip never paints its text in its own fill token", (_name, path) => {
    const classes = chipClasses(path);
    const fill = classes.match(/bg-([a-z]+)\//)?.[1];
    expect(fill, "chip should have a tinted fill").toBeTruthy();
    // `text-secondary` next to `bg-secondary/15` is the exact bug: the same
    // token for ink and paper. `text-secondary-foreground` is fine.
    expect(classes).not.toMatch(new RegExp(`text-${fill}(?![\\w-])`));
  });

  it.each(CALENDARS)("%s chip keeps its tinted background and its size", (_name, path) => {
    // This was a contrast fix, not a restyle — the chip should look the same.
    const classes = chipClasses(path);
    expect(classes).toContain("truncate");
    expect(classes).toContain("rounded-md");
    expect(classes).toContain("text-[10px]");
    expect(classes).toMatch(/bg-\w+\/\d+/);
  });

  it("today's cell is still only a tint, so the chips sit on the same near-white", () => {
    // Both calendars highlight today with bg-primary/5. If that ever became a
    // solid fill, the chip contrast measured above would no longer hold.
    for (const [, path] of CALENDARS) {
      expect(readFileSync(path, "utf-8")).toContain("bg-primary/5");
    }
  });
});
