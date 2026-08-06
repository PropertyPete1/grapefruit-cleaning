/**
 * Guards the dashboard mobile-layout contract.
 *
 * The dashboards are installed as a home-screen app on a 390px phone, where a
 * six-column table used to push the whole page sideways. These are source
 * checks rather than render tests (no DOM in this suite), aimed at the two
 * regressions that are easy to reintroduce: dropping min-w-0 from the shell,
 * and adding a new data table without a mobile treatment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ADMIN_DIR = fileURLToPath(new URL("../client/src/pages/admin", import.meta.url));
const STAFF_DIR = fileURLToPath(new URL("../client/src/pages/staff", import.meta.url));
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

const SHELLS = [
  ["admin", join(ADMIN_DIR, "AdminRoutes.tsx")],
  ["staff", join(STAFF_DIR, "StaffRoutes.tsx")],
] as const;

describe("dashboard shell", () => {
  it.each(SHELLS)("%s <main> can shrink below its content", (_name, path) => {
    const main = readFileSync(path, "utf-8").match(/<main className="([^"]+)"/)?.[1];
    expect(main).toBeTruthy();
    // Without min-w-0 a flex item refuses to shrink below its intrinsic content
    // width, so a wide table widens the page instead of scrolling inside its
    // own container. This single class is what keeps the page from scrolling.
    expect(main).toContain("min-w-0");
  });

  it.each(SHELLS)("%s <main> keeps content clear of the iOS safe areas", (_name, path) => {
    const main = readFileSync(path, "utf-8").match(/<main className="([^"]+)"/)?.[1] ?? "";
    expect(main).toContain("env(safe-area-inset-top)");
    expect(main).toContain("env(safe-area-inset-bottom)");
    expect(main).toContain("env(safe-area-inset-left)");
  });

  it.each(SHELLS)("%s desktop padding and offset are untouched", (_name, path) => {
    const main = readFileSync(path, "utf-8").match(/<main className="([^"]+)"/)?.[1] ?? "";
    // Desktop must render exactly as before the mobile pass.
    expect(main).toContain("lg:px-10");
    expect(main).toContain("lg:pt-10");
    expect(main).toContain("lg:pb-16");
    expect(main).toMatch(/lg:ml-6[04]/);
  });

  it.each(SHELLS)("%s mobile top bar clears the status bar", (_name, path) => {
    expect(readFileSync(path, "utf-8")).toContain("pt-[calc(0.75rem+env(safe-area-inset-top))]");
  });
});

describe("every data table has a mobile treatment", () => {
  const pagesWithTables = readdirSync(ADMIN_DIR)
    .filter(f => f.endsWith(".tsx") && f !== "adminShared.tsx")
    .filter(f => read(ADMIN_DIR, f).includes("<table"));

  it("finds the dashboard tables to check", () => {
    expect(pagesWithTables.length).toBeGreaterThan(0);
  });

  it.each(pagesWithTables)("%s renders cards or a contained scroll on phones", file => {
    const source = read(ADMIN_DIR, file);
    // Either the row-to-card swap, or a table that scrolls inside its own card
    // with a visible affordance — never a table that widens the page.
    const handled = source.includes("TableOrCards") || source.includes("ScrollableTable");
    expect(handled).toBe(true);
  });

  it.each(pagesWithTables)("%s never leaves a bare overflow-x-auto wrapper", file => {
    // A bare wrapper was the old pattern: it only works if an ancestor can
    // shrink, which is exactly what used to fail.
    const source = read(ADMIN_DIR, file);
    expect(source).not.toContain('<div className="overflow-x-auto">');
  });
});

describe("shared responsive primitives", () => {
  const shared = read(ADMIN_DIR, "adminShared.tsx");

  it("shows the table only from lg up, and cards only below it", () => {
    const block = shared.slice(shared.indexOf("export function TableOrCards"));
    expect(block).toContain("hidden overflow-x-auto lg:block");
    expect(block).toContain("lg:hidden");
  });

  it("wraps long values in cards instead of overflowing", () => {
    const block = shared.slice(shared.indexOf("export function RowCard"));
    // Long emails and addresses must wrap, not push the card wide.
    expect(block).toContain("break-words");
    expect(block).toContain("min-w-0");
  });

  it("only hints at sideways scrolling when there is more to see", () => {
    const block = shared.slice(shared.indexOf("export function ScrollableTable"));
    expect(block).toContain("overflowing &&");
    expect(block).toContain("lg:hidden");
  });

  it("keeps card actions reachable rather than clipped", () => {
    const block = shared.slice(shared.indexOf("export function RowCard"));
    expect(block).toContain("flex-wrap");
  });
});

describe("tier editor on a phone", () => {
  const source = read(ADMIN_DIR, "AdminServices.tsx");

  it("stacks each tier into labelled fields below lg", () => {
    // Prices get edited from the field, so the editor cannot be a table that
    // scrolls sideways on a phone. It goes through the same table/cards split
    // as the other dashboards rather than hand-rolling its own.
    expect(source).toContain("TableOrCards");
    expect(source).toContain("Max sq ft");
    expect(source).toContain("mobile)");
  });

  it("gives each stacked tier its own remove control", () => {
    expect(source).toMatch(/Remove \$\{SERVICE_LABELS\[svc\] \?\? svc\} tier/);
  });

  it("uses numeric keypads for the numeric fields", () => {
    expect(source).toContain('inputMode="numeric"');
    expect(source).toContain('inputMode="decimal"');
  });
});
