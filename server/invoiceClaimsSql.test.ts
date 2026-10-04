/**
 * The REAL conditional UPDATEs behind the double-charge fix, evaluated.
 *
 * No MySQL runs in this suite, so instead of trusting a hand-written stand-in
 * for each db.ts claim, this harness hands db.ts a fake drizzle whose
 * update/select/insert render the actual WHERE clause through drizzle's MySQL
 * dialect and evaluate it against in-memory rows — with SQL's three-valued
 * NULL logic, which is exactly where a `<> ?` on a NULL column silently
 * matches nothing. The behavioural fakes in paymentTestKit.ts mirror these
 * same clauses; this file is what keeps the two honest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlHarness = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = { invoices: [], payments: [], invoice_checkout_sessions: [] };
  const statements: string[] = [];

  /** Normalizes a value for comparison: dates (and drizzle's rendered timestamps) to epoch ms, booleans to 0/1. */
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) {
      return Date.parse(v.replace(" ", "T") + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? "" : "Z"));
    }
    return v;
  };

  type Tri = boolean | null;
  const and3 = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
  const or3 = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);

  /** Evaluates drizzle-rendered MySQL WHERE text against one row. */
  function evaluate(sqlText: string, params: unknown[], row: Row): Tri {
    let pos = 0;
    let p = 0;
    const src = sqlText;
    const ws = () => {
      while (src[pos] === " ") pos += 1;
    };
    const eat = (token: string) => {
      ws();
      if (src.startsWith(token, pos)) {
        pos += token.length;
        return true;
      }
      return false;
    };
    const column = (): string => {
      ws();
      const m = /^`[^`]+`\.`([^`]+)`/.exec(src.slice(pos));
      if (!m) throw new Error(`unparsed SQL at ${pos}: ${src.slice(pos, pos + 40)}`);
      pos += m[0].length;
      return m[1]!;
    };
    const predicate = (): Tri => {
      const col = column();
      const value = row[col] === undefined ? null : row[col];
      const v = norm(value);
      if (eat("is not null")) return value !== null;
      if (eat("is null")) return value === null;
      const listOf = () => {
        eat("(");
        const items: unknown[] = [];
        while (!eat(")")) {
          eat(",");
          if (eat("?")) items.push(norm(params[p++]));
        }
        return items;
      };
      if (eat("not in")) {
        const items = listOf();
        return value === null ? null : !items.includes(v);
      }
      if (eat("in")) {
        const items = listOf();
        return value === null ? null : items.includes(v);
      }
      for (const op of ["<>", "<=", ">=", "=", "<", ">"]) {
        if (eat(op)) {
          eat("?");
          const rhs = norm(params[p++]);
          if (value === null || rhs === null) return null;
          const a = v as number;
          const b = rhs as number;
          switch (op) {
            case "<>":
              return a !== b;
            case "<=":
              return a <= b;
            case ">=":
              return a >= b;
            case "=":
              return a === b;
            case "<":
              return a < b;
            default:
              return a > b;
          }
        }
      }
      throw new Error(`unknown operator at ${pos}: ${src.slice(pos, pos + 30)}`);
    };
    const term = (): Tri => {
      if (eat("(")) {
        const value = expr();
        if (!eat(")")) throw new Error(`expected ) at ${pos}`);
        return value;
      }
      return predicate();
    };
    const expr = (): Tri => {
      let value = term();
      for (;;) {
        if (eat(" and ") || eat("and ")) value = and3(value, term());
        else if (eat(" or ") || eat("or ")) value = or3(value, term());
        else return value;
      }
    };
    const result = expr();
    ws();
    if (pos !== src.length) throw new Error(`trailing SQL: ${src.slice(pos)}`);
    return result;
  }

  return { tables, statements, evaluate };
});

vi.mock("drizzle-orm/mysql2", async () => {
  const { getTableName } = await import("drizzle-orm");
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  type Row = Record<string, unknown>;
  const matches = (where: unknown, row: Row): boolean => {
    if (!where) return true;
    const { sql, params } = dialect.sqlToQuery(where as never);
    sqlHarness.statements.push(sql);
    return sqlHarness.evaluate(sql, params, row) === true;
  };
  const rowsOf = (table: unknown) => sqlHarness.tables[getTableName(table as never)]!;

  const selectQuery = () => {
    let source: Row[] = [];
    let where: unknown;
    let limit = Infinity;
    const query = {
      from: (table: unknown) => ((source = rowsOf(table)), query),
      leftJoin: () => query,
      where: (cond: unknown) => ((where = cond), query),
      orderBy: () => query,
      limit: (n: number) => ((limit = n), query),
      then: (resolve: (rows: Row[]) => unknown, reject: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(resolve(source.filter(row => matches(where, row)).slice(0, limit).map(row => ({ ...row }))));
        } catch (error) {
          return Promise.resolve(reject(error));
        }
      },
    };
    return query;
  };

  const db = {
    select: () => selectQuery(),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: async (cond: unknown) => {
          let affectedRows = 0;
          for (const row of rowsOf(table)) {
            if (matches(cond, row)) {
              Object.assign(row, patch);
              affectedRows += 1;
            }
          }
          return [{ affectedRows }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Row) => {
        const list = rowsOf(table);
        list.push({ id: list.length + 1, ...row });
        return [{ insertId: list.length }];
      },
    }),
    transaction: async <T,>(work: (tx: typeof db) => Promise<T>) => work(db),
  };
  return { drizzle: () => db };
});

import * as db from "./db";

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  number: "INV-SQL-1",
  status: "sent",
  payToken: "tok",
  checkoutAttempt: 0,
  checkoutClaimedAt: null,
  stripeSessionId: null,
  stripeSessionExpiresAt: null,
  paymentProcessingAt: null,
  paymentProcessingIntentId: null,
  stripePaymentIntentId: null,
  lastDuplicateIntentId: null,
  refundNeeded: false,
  reminderCount: 0,
  reminderExhaustedAlertAt: null,
  linkExpiresAt: new Date(Date.now() + 86_400_000),
  ...over,
});

const inv = () => sqlHarness.tables.invoices[0] as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "mysql://sql-claims-test");
  sqlHarness.tables.invoices = [invoiceRow()];
  sqlHarness.tables.payments = [];
  sqlHarness.tables.invoice_checkout_sessions = [];
  sqlHarness.statements.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("settleUnpaidInvoice — only the payment in flight may settle a processing invoice", () => {
  it("settles an open invoice and clears processing in the same write", async () => {
    expect(await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe", stripePaymentIntentId: "pi_1" })).toBe(true);
    expect(inv()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_1", paymentProcessingIntentId: null });
    // The real rendered WHERE, not a stand-in, decided it.
    expect(sqlHarness.statements.at(-1)).toContain(
      "(`invoices`.`paymentProcessingIntentId` is null or `invoices`.`paymentProcessingIntentId` = ?)"
    );
  });
  it("lets the processing payment settle", async () => {
    Object.assign(inv(), { paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    expect(await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe", stripePaymentIntentId: "pi_ach" })).toBe(true);
    expect(inv()).toMatchObject({ status: "paid", paymentProcessingAt: null, paymentProcessingIntentId: null });
  });
  it("refuses a DIFFERENT payment while one is processing", async () => {
    Object.assign(inv(), { paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    expect(await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe", stripePaymentIntentId: "pi_other" })).toBe(false);
    expect(inv().status).toBe("sent");
  });
  it("refuses an intent-less settlement while one is processing", async () => {
    Object.assign(inv(), { paymentProcessingIntentId: "pi_ach" });
    expect(await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe" })).toBe(false);
  });
  it("never settles twice", async () => {
    await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe", stripePaymentIntentId: "pi_1" });
    expect(await db.settleUnpaidInvoice(1, { paidAt: new Date(), paidVia: "stripe", stripePaymentIntentId: "pi_2" })).toBe(false);
    expect(inv().stripePaymentIntentId).toBe("pi_1");
  });
});

describe("flagInvoiceDuplicatePayment — once per intent, never over the settling intent", () => {
  it("flags a first duplicate even though lastDuplicateIntentId starts NULL (the <> NULL trap)", async () => {
    Object.assign(inv(), { status: "paid", stripePaymentIntentId: "pi_A" });
    expect(await db.flagInvoiceDuplicatePayment(1, "pi_B")).toBe(true);
    expect(inv()).toMatchObject({ refundNeeded: true, lastDuplicateIntentId: "pi_B", stripePaymentIntentId: "pi_A" });
  });
  it("loses on a redelivery of the same duplicate", async () => {
    Object.assign(inv(), { status: "paid", stripePaymentIntentId: "pi_A" });
    await db.flagInvoiceDuplicatePayment(1, "pi_B");
    expect(await db.flagInvoiceDuplicatePayment(1, "pi_B")).toBe(false);
  });
  it("claims again for a third, distinct payment", async () => {
    Object.assign(inv(), { status: "paid", stripePaymentIntentId: "pi_A" });
    await db.flagInvoiceDuplicatePayment(1, "pi_B");
    expect(await db.flagInvoiceDuplicatePayment(1, "pi_C")).toBe(true);
    expect(inv().lastDuplicateIntentId).toBe("pi_C");
  });
  it("never flags the settling payment itself, even when no stripe intent was ever recorded (manual settle)", async () => {
    Object.assign(inv(), { status: "paid", stripePaymentIntentId: "pi_A" });
    expect(await db.flagInvoiceDuplicatePayment(1, "pi_A")).toBe(false);
    Object.assign(inv(), { stripePaymentIntentId: null });
    expect(await db.flagInvoiceDuplicatePayment(1, "pi_late")).toBe(true);
  });
  it("keys an intent-less duplicate on the refund flag itself", async () => {
    Object.assign(inv(), { status: "paid" });
    expect(await db.flagInvoiceDuplicatePayment(1, null)).toBe(true);
    expect(await db.flagInvoiceDuplicatePayment(1, null)).toBe(false);
  });
});

describe("processing state", () => {
  it("the first payment to start processing owns the invoice; a second cannot take it over", async () => {
    expect(await db.markInvoicePaymentProcessing(1, "pi_A")).toBe(true);
    expect(await db.markInvoicePaymentProcessing(1, "pi_B")).toBe(false);
    expect(inv().paymentProcessingIntentId).toBe("pi_A");
  });
  it("is never set on a paid or voided invoice", async () => {
    Object.assign(inv(), { status: "paid" });
    expect(await db.markInvoicePaymentProcessing(1, "pi_A")).toBe(false);
    Object.assign(inv(), { status: "void" });
    expect(await db.markInvoicePaymentProcessing(1, "pi_A")).toBe(false);
  });
  it("restarts the reminder sequence only on an open invoice with nothing processing", async () => {
    Object.assign(inv(), { reminderCount: 2, lastReminderAt: new Date(), reminderExhaustedAlertAt: new Date(), paymentProcessingIntentId: "pi_B" });
    const now = new Date("2026-10-04T15:00:00Z");
    expect(await db.restartBalanceReminders(1, now)).toBe(false);
    Object.assign(inv(), { paymentProcessingIntentId: null });
    expect(await db.restartBalanceReminders(1, now)).toBe(true);
    expect(inv()).toMatchObject({ linkSentAt: now, reminderCount: 0, lastReminderAt: null, reminderExhaustedAlertAt: null });
    Object.assign(inv(), { status: "paid", reminderCount: 2 });
    expect(await db.restartBalanceReminders(1, now)).toBe(false);
  });

  it("lists every duplicate still held on an invoice, oldest first", async () => {
    sqlHarness.tables.payments.push(
      { id: 1, invoiceId: 1, stripePaymentIntentId: "pi_B", duplicate: true, status: "succeeded" },
      { id: 2, invoiceId: 1, stripePaymentIntentId: "pi_C", duplicate: true, status: "refunded" },
      { id: 3, invoiceId: 1, stripePaymentIntentId: "pi_D", duplicate: true, status: "succeeded" },
      { id: 4, invoiceId: 1, stripePaymentIntentId: "pi_A", duplicate: false, status: "succeeded" }
    );
    expect((await db.listHeldDuplicatePayments(1)).map(r => r.stripePaymentIntentId)).toEqual(["pi_B", "pi_D"]);
  });

  it("refuses to record money by hand while a bank payment is processing", async () => {
    Object.assign(inv(), { amount: 180, amountCents: 18000, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" });
    const result = await db.recordOfflineInvoicePayment({
      invoiceId: 1,
      amountCents: 18000,
      method: "cash",
      tipAmountCents: 0,
      receivedOn: "2026-10-04",
      recordedByUserId: 9,
    });
    expect(result).toEqual({ outcome: "payment_processing", paymentIntentId: "pi_ach" });
    expect(inv().status).toBe("sent");
    expect(sqlHarness.tables.payments).toHaveLength(0);
  });

  it("only THAT payment's failure clears it, and the clear renews the link window", async () => {
    await db.markInvoicePaymentProcessing(1, "pi_A");
    const window = { linkExpiresAt: new Date(Date.now() + 7 * 86_400_000), dueDate: "2026-10-11" };
    expect(await db.clearInvoicePaymentProcessing(1, "pi_other", window)).toBe(false);
    expect(inv().paymentProcessingIntentId).toBe("pi_A");
    expect(await db.clearInvoicePaymentProcessing(1, "pi_A", window)).toBe(true);
    expect(inv()).toMatchObject({ paymentProcessingAt: null, paymentProcessingIntentId: null, dueDate: "2026-10-11" });
  });
  it("promotes only the duplicate on file, only while the failed payment is still the one processing — clearing it in the same write", async () => {
    Object.assign(inv(), { refundNeeded: true, lastDuplicateIntentId: "pi_B", paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_A" });
    sqlHarness.tables.payments.push({ id: 1, invoiceId: 1, stripePaymentIntentId: "pi_B", duplicate: true, status: "succeeded" });
    expect(await db.promoteDuplicatePayment(1, "pi_B", "pi_other", { paidAt: new Date() })).toBe(false); // a different payment is processing
    expect(await db.promoteDuplicatePayment(1, "pi_B", "pi_A", { paidAt: new Date(), paidMethod: "card" })).toBe(true);
    expect(await db.promoteDuplicatePayment(1, "pi_B", "pi_A", { paidAt: new Date() })).toBe(false); // already promoted
    expect(inv()).toMatchObject({
      status: "paid",
      stripePaymentIntentId: "pi_B",
      refundNeeded: false,
      lastDuplicateIntentId: null,
      paymentProcessingAt: null,
      paymentProcessingIntentId: null,
    });
    expect(sqlHarness.tables.payments[0]!.duplicate).toBe(false);
  });

  it("keeps the refund flag up when another duplicate still waits on a refund", async () => {
    Object.assign(inv(), { refundNeeded: true, lastDuplicateIntentId: "pi_C", paymentProcessingIntentId: "pi_A" });
    sqlHarness.tables.payments.push(
      { id: 1, invoiceId: 1, stripePaymentIntentId: "pi_B", duplicate: true, status: "succeeded" },
      { id: 2, invoiceId: 1, stripePaymentIntentId: "pi_C", duplicate: true, status: "succeeded" }
    );
    expect(await db.promoteDuplicatePayment(1, "pi_C", "pi_A", { paidAt: new Date() })).toBe(true);
    expect(inv().refundNeeded).toBe(true);
  });

  it("marks a refunded duplicate and drops the flag once none is left waiting", async () => {
    Object.assign(inv(), { status: "paid", refundNeeded: true, lastDuplicateIntentId: "pi_B" });
    sqlHarness.tables.payments.push({ id: 1, invoiceId: 1, stripePaymentIntentId: "pi_B", duplicate: true, status: "succeeded" });
    await db.markDuplicatePaymentRefunded(1, "pi_B");
    expect(sqlHarness.tables.payments[0]!.status).toBe("refunded");
    expect(inv()).toMatchObject({ refundNeeded: false, lastDuplicateIntentId: null });
  });
});

describe("the minting claim", () => {
  it("is a compare-and-set on the attempt: of two racers reading attempt 0, exactly one wins", async () => {
    const [a, b] = await Promise.all([db.claimInvoiceCheckoutAttempt(1, 0, null), db.claimInvoiceCheckoutAttempt(1, 0, null)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(inv().checkoutAttempt).toBe(1);
  });
  it("clears the old session pointer, so a loser sees 'being minted', not 'reuse this'", async () => {
    Object.assign(inv(), { stripeSessionId: "cs_old", stripeSessionExpiresAt: new Date() });
    expect(await db.claimInvoiceCheckoutAttempt(1, 0, "cs_old")).toBe(true);
    expect(inv()).toMatchObject({ stripeSessionId: null, stripeSessionExpiresAt: null });
  });
  it("is also a compare-and-set on the session pointer: a session recorded since the read is never dropped", async () => {
    // A visit read the row with no session (a claim's lease had lapsed); before it
    // claimed, the slow original minter recorded cs_live at the same attempt.
    Object.assign(inv(), { checkoutAttempt: 1, stripeSessionId: "cs_live" });
    expect(await db.claimInvoiceCheckoutAttempt(1, 1, null)).toBe(false);
    expect(inv().stripeSessionId).toBe("cs_live");
  });
  it("is refused while a payment is processing, or once the invoice is settled", async () => {
    Object.assign(inv(), { paymentProcessingIntentId: "pi_ach" });
    expect(await db.claimInvoiceCheckoutAttempt(1, 0, null)).toBe(false);
    Object.assign(inv(), { paymentProcessingIntentId: null, status: "paid" });
    expect(await db.claimInvoiceCheckoutAttempt(1, 0, null)).toBe(false);
    Object.assign(inv(), { status: "void" });
    expect(await db.claimInvoiceCheckoutAttempt(1, 0, null)).toBe(false);
  });
  it("stores the minted session only while its attempt is current, and always logs it", async () => {
    await db.claimInvoiceCheckoutAttempt(1, 0, null);
    const expiresAt = new Date(Date.now() + 86_400_000);
    expect(await db.recordInvoiceCheckoutSession(1, 1, { stripeSessionId: "cs_1", expiresAt })).toBe(true);
    expect(inv()).toMatchObject({ stripeSessionId: "cs_1" });
    expect(await db.recordInvoiceCheckoutSession(1, 7, { stripeSessionId: "cs_stale", expiresAt })).toBe(false);
    expect(inv().stripeSessionId).toBe("cs_1");
    expect(sqlHarness.tables.invoice_checkout_sessions.map(r => r.stripeSessionId)).toEqual(["cs_1", "cs_stale"]);
  });
  it("never stores a fresh session on an invoice that was settled, voided or started processing while Stripe answered", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    for (const change of [{ status: "paid" }, { status: "void" }, { paymentProcessingIntentId: "pi_ach" }]) {
      sqlHarness.tables.invoices = [invoiceRow()];
      await db.claimInvoiceCheckoutAttempt(1, 0, null);
      Object.assign(inv(), change);
      expect(await db.recordInvoiceCheckoutSession(1, 1, { stripeSessionId: "cs_late", expiresAt })).toBe(false);
      expect(inv().stripeSessionId).toBeNull();
    }
  });
  it("a released claim frees only the claimant's own, still-empty attempt", async () => {
    await db.claimInvoiceCheckoutAttempt(1, 0, null);
    await db.releaseInvoiceCheckoutClaim(1, 1);
    expect(inv().checkoutClaimedAt).toBeNull();
    Object.assign(inv(), { checkoutClaimedAt: new Date(), stripeSessionId: "cs_1" });
    await db.releaseInvoiceCheckoutClaim(1, 1);
    expect(inv().checkoutClaimedAt).not.toBeNull();
  });
  it("ends a session in the history once, at the first sighting", async () => {
    sqlHarness.tables.invoice_checkout_sessions.push({ id: 1, stripeSessionId: "cs_1", endedAt: null, endReason: null });
    const first = new Date("2026-10-01T00:00:00Z");
    await db.endInvoiceCheckoutSession("cs_1", "expired", first);
    await db.endInvoiceCheckoutSession("cs_1", "closed", new Date());
    expect(sqlHarness.tables.invoice_checkout_sessions[0]).toMatchObject({ endReason: "expired", endedAt: first });
  });
});

describe("reminders and health never chase a payment in flight", () => {
  it("leaves processing invoices off the reminder worklist", async () => {
    sqlHarness.tables.invoices.push(invoiceRow({ id: 2, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_ach" }));
    const list = await db.listSentBalanceInvoices();
    expect(list.map(r => r.id)).toEqual([1]);
  });
  it("refuses the reminder claim (and the exhausted alert) once processing starts mid-sweep", async () => {
    Object.assign(inv(), { paymentProcessingAt: new Date() });
    expect(await db.claimBalanceReminder(1, 0, { linkExpiresAt: new Date(), dueDate: "2026-10-11" })).toBe(false);
    expect(await db.claimBalanceReminderExhaustedAlert(1)).toBe(false);
    Object.assign(inv(), { paymentProcessingAt: null });
    expect(await db.claimBalanceReminder(1, 0, { linkExpiresAt: new Date(), dueDate: "2026-10-11" })).toBe(true);
  });
  it("does not report a processing invoice's lapsed window as a dead link", async () => {
    Object.assign(inv(), { linkExpiresAt: new Date(Date.now() - 86_400_000), paymentProcessingAt: new Date() });
    expect(await db.findInvoicesWithDeadLinks(new Date())).toHaveLength(0);
    Object.assign(inv(), { paymentProcessingAt: null });
    expect(await db.findInvoicesWithDeadLinks(new Date())).toHaveLength(1);
  });
  it("finds a payment stuck processing past the cutoff, and only that", async () => {
    Object.assign(inv(), { paymentProcessingAt: new Date("2026-09-01T00:00:00Z"), paymentProcessingIntentId: "pi_old" });
    sqlHarness.tables.invoices.push(invoiceRow({ id: 2, paymentProcessingAt: new Date(), paymentProcessingIntentId: "pi_new" }));
    const stuck = await db.listStuckProcessingInvoices(new Date("2026-09-20T00:00:00Z"));
    expect(stuck.map(r => r.paymentProcessingIntentId)).toEqual(["pi_old"]);
  });
});

it("the harness evaluated real db.ts SQL, not nothing", () => {
  // Guards the guard: if the fake ever stopped rendering WHERE clauses, every
  // claim above would match unconditionally and these tests would pass empty.
  expect(sqlHarness.evaluate("(`invoices`.`a` <> ?)", ["x"], { a: null })).toBeNull();
  expect(sqlHarness.evaluate("(`invoices`.`a` is null or `invoices`.`a` <> ?)", ["x"], { a: null })).toBe(true);
});
