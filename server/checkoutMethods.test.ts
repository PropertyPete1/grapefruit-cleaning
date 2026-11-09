/**
 * Every Checkout Session the server mints names its payment methods.
 *
 * Left unnamed, Checkout offers whatever the Stripe Dashboard enables, and the
 * Dashboard had ACH on: deposits and tips completed "unpaid", were never
 * finalized or recorded, and stayed payable — a retry was a second debit. The
 * fix is one list (IMMEDIATE_PAYMENT_METHOD_TYPES, card only) spread into each
 * call. The per-surface tests (depositLink, paymentChoice, tip) pin what each
 * session is created with; this file pins that no Checkout call in server/
 * can be added — or lose its list — without a test going red.
 *
 * Balance invoices are the deliberate exception: bank transfer is worth
 * offering on a whole job balance, so that surface is meant to handle delayed
 * payments rather than refuse them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_DIR = import.meta.dirname;

/** Files allowed to mint a session on the Dashboard's methods, and why. */
const EXEMPT: Record<string, string> = {
  "balance.ts": "balance invoices keep bank transfer; their delayed-payment handling is its own change",
};

const CREATE_CALL = /checkout\.sessions\.create\(/g;
const IMMEDIATE_LIST = /payment_method_types:\s*\[\.\.\.IMMEDIATE_PAYMENT_METHOD_TYPES\]/g;

/** Every non-test .ts file under server/, relative to it, with / separators. */
function serverSources(dir = SERVER_DIR): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : serverSources(full);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) return [];
    return [path.relative(SERVER_DIR, full).split(path.sep).join("/")];
  });
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** Each file that calls checkout.sessions.create, with its call and list counts. */
const callers = serverSources()
  .map(file => {
    const text = readFileSync(path.join(SERVER_DIR, file), "utf8");
    return { file, creates: count(text, CREATE_CALL), lists: count(text, IMMEDIATE_LIST) };
  })
  .filter(row => row.creates > 0);

describe("Checkout payment methods", () => {
  it("finds the surfaces it is meant to guard (the scan is not blind)", () => {
    const files = callers.map(row => row.file);
    expect(files).toEqual(
      expect.arrayContaining(["routers/booking.ts", "routers/depositLink.ts", "tip.ts", "balance.ts"])
    );
  });

  it("every non-invoice Checkout Session is minted with the immediate-method list", () => {
    const unguarded = callers
      .filter(row => !(row.file in EXEMPT))
      .filter(row => row.lists < row.creates)
      .map(row => `${row.file}: ${row.creates} session create(s), ${row.lists} with payment_method_types`);
    expect(unguarded).toEqual([]);
  });
});
