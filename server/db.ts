import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  blogPosts,
  bookings,
  connectedProperties,
  contactMessages,
  coupons,
  customers,
  emailLog,
  employees,
  galleryItems,
  invoices,
  payments,
  reviews,
  siteSettings,
  users,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { blocksSlot, STALE_DEPOSIT_MINUTES } from "./bookingRules";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * Builds the insert/update halves of the Manus identity sync.
 *
 * `openId` is the authentication key. A provider email is accepted when the
 * row is first created, but deliberately omitted from the duplicate-key
 * update so an operator-managed display/notification email survives later
 * sign-ins. Name, login method and last-sign-in metadata may still refresh.
 */
export function buildUserUpsertPlan(user: InsertUser): {
  values: InsertUser;
  updateSet: Record<string, unknown>;
} {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const values: InsertUser = {
    openId: user.openId,
  };
  const updateSet: Record<string, unknown> = {};

  const mutableTextFields = ["name", "loginMethod"] as const;
  type MutableTextField = (typeof mutableTextFields)[number];

  const assignMutableNullable = (field: MutableTextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };

  mutableTextFields.forEach(assignMutableNullable);

  // Provider email seeds a brand-new row only. Existing rows may carry an
  // operator-managed display/notification address and must not be overwritten
  // by a later OAuth callback.
  if (user.email !== undefined) {
    values.email = user.email ?? null;
  }

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = 'admin';
    updateSet.role = 'admin';
  }

  if (!values.lastSignedIn) {
    values.lastSignedIn = new Date();
  }

  if (Object.keys(updateSet).length === 0) {
    updateSet.lastSignedIn = new Date();
  }

  return { values, updateSet };
}

export async function upsertUser(user: InsertUser): Promise<void> {
  const { values, updateSet } = buildUserUpsertPlan(user);

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

function requireDb<T>(db: T | null): T {
  if (!db) throw new Error("Database not available");
  return db;
}

/**
 * Rows an UPDATE actually changed. This is how the conditional-claim helpers
 * below tell the winner of a race from the loser, so it has to come from the
 * driver's result header rather than from anything read beforehand.
 */
function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

// ---------- Customers ----------
/**
 * Finds the customer this contact info belongs to, or creates them.
 *
 * Matched by email when there is one, by phone otherwise — a text lead the
 * owner enters with just a number must land on the same customer row next
 * time that number calls, not mint a duplicate. Callers guarantee at least
 * one of the two (the public form requires email; the admin form refuses to
 * submit without email or phone).
 *
 * Existing values are never clobbered by blanks: a phone-only re-entry of a
 * known customer keeps their email, and a missing last name keeps the one on
 * file.
 */
export async function findOrCreateCustomer(data: {
  firstName: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  address?: string;
  city?: string;
  zip?: string;
  preferredLocale?: "en" | "es";
}) {
  const db = requireDb(await getDb());
  const match = data.email
    ? eq(customers.email, data.email)
    : data.phone
      ? eq(customers.phone, data.phone)
      : null;
  const existing = match ? await db.select().from(customers).where(match).limit(1) : [];
  if (existing.length > 0) {
    await db
      .update(customers)
      .set({
        firstName: data.firstName,
        lastName: data.lastName || existing[0].lastName,
        email: data.email ?? existing[0].email,
        phone: data.phone ?? existing[0].phone,
        address: data.address ?? existing[0].address,
        city: data.city ?? existing[0].city,
        zip: data.zip ?? existing[0].zip,
        preferredLocale: data.preferredLocale ?? existing[0].preferredLocale,
      })
      .where(eq(customers.id, existing[0].id));
    return existing[0].id;
  }
  const result = await db.insert(customers).values({ ...data, lastName: data.lastName ?? "" });
  return Number(result[0].insertId);
}

export async function listCustomers(search?: string) {
  const db = requireDb(await getDb());
  if (search) {
    const q = `%${search}%`;
    return db
      .select()
      .from(customers)
      .where(or(like(customers.firstName, q), like(customers.lastName, q), like(customers.email, q)))
      .orderBy(desc(customers.createdAt))
      .limit(200);
  }
  return db.select().from(customers).orderBy(desc(customers.createdAt)).limit(200);
}

/** Customers by id, for attaching contact info to a bookings list in one query. */
export async function getCustomersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  const db = requireDb(await getDb());
  return db.select().from(customers).where(inArray(customers.id, ids));
}

export async function getCustomerById(id: number) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return rows[0];
}

export async function updateCustomer(id: number, data: Partial<typeof customers.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(customers).set(data).where(eq(customers.id, id));
}

// ---------- Bookings ----------
export async function createBooking(data: typeof bookings.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(bookings).values(data);
  return Number(result[0].insertId);
}

export async function getBookingById(id: number) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return rows[0];
}

export async function getBookingByReference(reference: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.reference, reference)).limit(1);
  return rows[0];
}

/**
 * Looks up a booking by its deposit-link token.
 *
 * Server-internal on purpose: this is the one read that returns the token
 * column, and every list path strips it (see stripPayToken).
 */
export async function getBookingByPayToken(token: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.payToken, token)).limit(1);
  return rows[0];
}

export async function getBookingByStripeSession(sessionId: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.stripeSessionId, sessionId)).limit(1);
  return rows[0];
}

export async function updateBooking(id: number, data: Partial<typeof bookings.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(bookings).set(data).where(eq(bookings.id, id));
}

/**
 * Claims an unpaid booking for confirmation, atomically.
 *
 * The status is part of the WHERE rather than something the caller checked
 * beforehand, so a webhook and a return-page confirmation arriving together
 * cannot both proceed: whichever UPDATE lands first flips the row out of the
 * matching set and the other affects zero rows. Returns true only for the
 * caller that actually made the change — the one that should then record the
 * payment, redeem the coupon, and send the emails.
 */
export async function confirmUnpaidBooking(
  id: number,
  data: { stripePaymentIntentId?: string; slotConflict: boolean }
): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ status: "confirmed", ...data })
    .where(and(eq(bookings.id, id), inArray(bookings.status, ["pending_deposit", "expired"])));
  return affectedRows(result) > 0;
}

/**
 * Marks a booking completed because its balance was paid, atomically.
 *
 * A paid balance invoice is proof the job happened — nobody bills a balance
 * for work that was not done. Admin-created bookings are routinely invoiced
 * without anyone first flipping the status in Admin → Appointments, which left
 * finished jobs sitting at `confirmed` and silently suppressed the tip ask,
 * whose gate reads the booking's status rather than the payment's.
 *
 * Only `confirmed` and `in_progress` are claimable. `cancelled` and `expired`
 * are deliberately excluded: a settled invoice against a cancelled booking is
 * a refund or an out-of-band void, and resurrecting it as completed would both
 * misstate the record and fire a tip request for a job that never happened.
 * `pending_deposit` is excluded too — a balance cannot legitimately settle
 * before the deposit that precedes it.
 *
 * Returns true only for the caller that actually made the change.
 */
export async function claimBookingCompletedBySettlement(id: number): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ status: "completed" })
    .where(and(eq(bookings.id, id), inArray(bookings.status, ["confirmed", "in_progress"])));
  return affectedRows(result) > 0;
}

/**
 * Claims the host's "cleaning scheduled" notice FOR A SPECIFIC DATE.
 *
 * Keyed on the date rather than on a boolean, because the hourly sweep re-places
 * turnovers that could not find a slot the first time. Re-announcing the same
 * date is noise; announcing a NEW date is the reschedule a host most needs to
 * hear about. `turnoverNoticeDate <> date` in the WHERE draws exactly that line,
 * and being a conditional UPDATE it also settles two syncs racing on one
 * reservation — only one can claim.
 *
 * An unplaced turnover is announced with its checkout date and no time, so the
 * date is always known even when the slot is not.
 */
export async function claimTurnoverNotice(id: number, date: string): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ turnoverNoticeDate: date })
    .where(
      and(
        eq(bookings.id, id),
        or(isNull(bookings.turnoverNoticeDate), ne(bookings.turnoverNoticeDate, date))
      )
    );
  return affectedRows(result) > 0;
}

/**
 * SQL for "this unpaid booking has held its slot for long enough".
 *
 * The window is per row — 24 hours for an admin-created booking, one for the
 * public flow — so the comparison has to happen in the database rather than
 * against a single precomputed cutoff. COALESCE covers rows written before the
 * column existed: every one of those came from the public flow, so the old
 * global constant is exactly right for them.
 *
 * This mirrors blocksSlot, which decides the same thing in application code for
 * rows already in hand. Both must agree, or a slot the calendar treats as free
 * would keep failing the unique index on insert.
 */
function bookingHoldElapsed(now: Date) {
  // TIMESTAMPDIFF rather than `createdAt + INTERVAL COALESCE(holdMinutes, 60)
  // MINUTE <= ?`, which reads more naturally but compiles to a placeholder
  // INSIDE the INTERVAL expression — a position MySQL's prepared-statement
  // parser rejects on some versions. Here both bound values sit in ordinary
  // argument positions.
  //
  // Whole minutes, truncated, and the boundary still lands where blocksSlot
  // puts it: blocksSlot holds while elapsed < window, so releasing at
  // elapsed >= window is the same instant from the other side.
  return sql`TIMESTAMPDIFF(MINUTE, ${bookings.createdAt}, ${now}) >= COALESCE(${bookings.holdMinutes}, ${STALE_DEPOSIT_MINUTES})`;
}

/**
 * Expires unpaid bookings that are still holding one specific slot past the
 * stale cutoff.
 *
 * getOccupiedBookings already treats those as free (see blocksSlot), but the row
 * keeps its slotKey until something actually changes its status — and the
 * unique index goes by the row, not by the clock. Releasing the slot for real
 * right before booking it keeps the database's view and the application's view
 * of "free" in agreement, instead of depending on when the daily cron last ran.
 */
export async function expireStaleBookingsForSlot(
  date: string,
  time: string,
  now: Date = new Date()
): Promise<number> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ status: "expired" })
    .where(
      and(
        eq(bookings.scheduledDate, date),
        eq(bookings.scheduledTime, time),
        eq(bookings.status, "pending_deposit"),
        bookingHoldElapsed(now)
      )
    );
  return affectedRows(result);
}

/**
 * True when a write failed because another booking already holds the slot.
 *
 * Matches on the slot index by name so a `reference` collision — the table's
 * other unique column — is never mistaken for a taken slot and reported to the
 * customer as one.
 */
export function isSlotTakenError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const isDuplicate = candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062;
    if (isDuplicate && typeof candidate.message === "string" && candidate.message.includes("slotKey")) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Drops the deposit-link token from a booking row.
 *
 * The token is a bearer credential: whoever holds it can open the pay page for
 * that booking. The list queries select the whole row, so without this it would
 * ride along in every admin table, staff schedule and calendar payload — and
 * those reach the browser. Link status is derived and sent instead (see
 * depositLinkStatus); the token itself only ever leaves the server inside the
 * URL the owner explicitly asks for.
 *
 * Applied inside the query functions rather than at the router, so a list
 * endpoint added later cannot forget it.
 */
export function stripPayToken<T extends { payToken?: string | null; tipToken?: string | null }>(
  row: T
): Omit<T, "payToken" | "tipToken"> & { hasPayToken: boolean } {
  const { payToken, tipToken, ...rest } = row;
  void tipToken; // Same bearer-credential rule: the tip page token never rides a list payload.
  // The boolean, not the token: whether a link exists is what the appointments
  // table needs in order to show its status, and it is not a credential.
  return { ...rest, hasPayToken: Boolean(payToken) };
}

/** The same, for the {booking, customer} shape the staff views select. */
function stripJoinedPayToken<T extends { booking: { payToken?: string | null } }>(row: T) {
  return { ...row, booking: stripPayToken(row.booking) };
}

/**
 * True when an insert failed because this reservation UID already has its
 * booking — two syncs racing on the same new reservation. The loser treats it
 * as "already created", which is the truth.
 */
export function isDuplicateUidError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const isDuplicate = candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062;
    if (isDuplicate && typeof candidate.message === "string" && candidate.message.includes("bookings_property_uid_unique")) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function listBookings(filter?: { status?: string; from?: string; to?: string }) {
  const db = requireDb(await getDb());
  const conditions = [];
  if (filter?.status) conditions.push(eq(bookings.status, filter.status as never));
  if (filter?.from) conditions.push(gte(bookings.scheduledDate, filter.from));
  if (filter?.to) conditions.push(lte(bookings.scheduledDate, filter.to));
  if (conditions.length > 0) {
    const rows = await db
      .select()
      .from(bookings)
      .where(and(...conditions))
      .orderBy(desc(bookings.scheduledDate))
      .limit(500);
    return rows.map(stripPayToken);
  }
  const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(500);
  return rows.map(stripPayToken);
}

export async function listBookingsForCustomer(customerId: number) {
  const db = requireDb(await getDb());
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.customerId, customerId))
    .orderBy(desc(bookings.createdAt));
  return rows.map(stripPayToken);
}

/**
 * Live bookings on a date, with everything needed to work out the span each one
 * occupies — a job blocks its whole duration, not just its starting hour.
 *
 * Cancelled and expired bookings are excluded by the query and stale unpaid
 * checkouts by blocksSlot, so a released booking frees its entire interval, not
 * only the slot it started in: the row simply stops being returned.
 *
 * `estimatedHours` is whatever was pinned at creation, and NULL for rows older
 * than that column. Resolving the fallback needs the duration ladder, which is
 * a settings read, so the caller does it.
 */
export async function getOccupiedBookings(date: string) {
  const db = requireDb(await getDb());
  const rows = await db
    .select({
      id: bookings.id,
      time: bookings.scheduledTime,
      serviceType: bookings.serviceType,
      sqft: bookings.sqft,
      estimatedHours: bookings.estimatedHours,
      status: bookings.status,
      createdAt: bookings.createdAt,
      holdMinutes: bookings.holdMinutes,
    })
    .from(bookings)
    .where(and(eq(bookings.scheduledDate, date), sql`${bookings.status} NOT IN ('cancelled', 'expired')`));
  const now = new Date();
  // The date filter can only match rows with a slot, and a slot is always
  // both halves — the narrowing is for the types, the filter is a no-op.
  return rows
    .filter((r): r is typeof r & { time: string } => r.time != null)
    .filter(r => blocksSlot(r, now));
}

/**
 * Marks unpaid (pending_deposit) bookings past their own hold window as expired
 * so they stop appearing as held slots. A late Stripe payment can still recover
 * an expired booking (finalizeBooking accepts both states).
 * Returns the number of bookings expired.
 */
export async function expireStaleDepositBookings(now: Date = new Date()): Promise<number> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ status: "expired" })
    .where(
      and(
        eq(bookings.status, "pending_deposit"),
        // A booking whose customer hasn't picked a time yet holds no slot, so
        // there is nothing here to release. Its deposit link dies by its own
        // token window instead (payTokenExpiresAt → depositLinkStatus
        // "expired"), which a resend renews. The hold clock starts, from
        // scratch, at the moment a slot is actually claimed.
        isNotNull(bookings.scheduledDate),
        isNotNull(bookings.scheduledTime),
        bookingHoldElapsed(now)
      )
    );
  return affectedRows(result);
}

/** Confirmed/in-progress bookings scheduled within the next 8 days (reminder scan window). */
export async function listUpcomingConfirmedBookings(today: string) {
  const db = requireDb(await getDb());
  const windowEnd = new Date(`${today}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 8);
  const endStr = windowEnd.toISOString().slice(0, 10);
  return db
    .select()
    .from(bookings)
    .where(
      and(
        or(eq(bookings.status, "confirmed"), eq(bookings.status, "in_progress")),
        gte(bookings.scheduledDate, today),
        lte(bookings.scheduledDate, endStr)
      )
    );
}

/**
 * Claims the once-per-booking "job started" email.
 *
 * Same conditional-UPDATE shape as confirmUnpaidBooking: the "not sent yet"
 * test lives in the WHERE, so a status flipped confirmed → in progress →
 * confirmed → in progress, or two dashboards pressing Start at once, can only
 * produce one email. Returns true for the caller that claimed it — the one that
 * should actually send.
 */
export async function claimJobStartedEmail(id: number, now: Date = new Date()): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ startedEmailSentAt: now })
    .where(and(eq(bookings.id, id), isNull(bookings.startedEmailSentAt)));
  return affectedRows(result) > 0;
}

/** Claims the once-per-booking "cleaning complete" thank-you. See above. */
export async function claimJobCompletedEmail(id: number, now: Date = new Date()): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ completedEmailSentAt: now })
    .where(and(eq(bookings.id, id), isNull(bookings.completedEmailSentAt)));
  return affectedRows(result) > 0;
}

/**
 * Claims the once-per-booking tip-request thank-you, minting its page token in
 * the same write.
 *
 * The WHERE also requires the plain "cleaning complete" thank-you to be
 * unsent: the tip email IS the thank-you now, and a booking that already got
 * the old one (completed before this feature shipped, say) must not be thanked
 * twice. completedEmailSentAt is set here too, closing the same door from the
 * other side — claimJobCompletedEmail can never fire after this does.
 */
export async function claimTipRequestEmail(
  id: number,
  tipToken: string,
  now: Date = new Date()
): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ tipEmailSentAt: now, completedEmailSentAt: now, tipToken })
    .where(and(eq(bookings.id, id), isNull(bookings.tipEmailSentAt), isNull(bookings.completedEmailSentAt)));
  return affectedRows(result) > 0;
}

/** Looks up a booking by its tip-page token. Server-internal, like getBookingByPayToken. */
export async function getBookingByTipToken(token: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.tipToken, token)).limit(1);
  return rows[0];
}

/**
 * Claims a tip payment, at most once. Same conditional-UPDATE shape as
 * settleUnpaidInvoice: Stripe redelivers events, and only the delivery that
 * lands this write records the payment and cheers the owner.
 */
export async function claimTipPayment(
  id: number,
  data: { amount: number; stripePaymentIntentId?: string },
  now: Date = new Date()
): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ tipPaidAt: now, tipAmount: data.amount, tipStripePaymentIntentId: data.stripePaymentIntentId })
    .where(and(eq(bookings.id, id), isNull(bookings.tipPaidAt)));
  return affectedRows(result) > 0;
}

/**
 * Marks the tip politely declined, unless a tip has already been paid or the
 * question already answered. Declining twice is a no-op, not an error — the
 * page just thanks them either way.
 */
export async function declineTip(id: number, now: Date = new Date()): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(bookings)
    .set({ tipDeclinedAt: now })
    .where(and(eq(bookings.id, id), isNull(bookings.tipPaidAt), isNull(bookings.tipDeclinedAt)));
  return affectedRows(result) > 0;
}

/** Records that a reminder email was sent so the cron never double-sends. */
export async function markReminderSent(bookingId: number, kind: "week" | "day") {
  const db = requireDb(await getDb());
  const patch = kind === "week" ? { weekReminderSentAt: new Date() } : { dayReminderSentAt: new Date() };
  await db.update(bookings).set(patch).where(eq(bookings.id, bookingId));
}

// ---------- Contact messages ----------
export async function createContactMessage(data: typeof contactMessages.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(contactMessages).values(data);
  return Number(result[0].insertId);
}

export async function listContactMessages() {
  const db = requireDb(await getDb());
  return db.select().from(contactMessages).orderBy(desc(contactMessages.createdAt)).limit(300);
}

export async function updateContactMessage(id: number, status: "new" | "replied" | "archived") {
  const db = requireDb(await getDb());
  await db.update(contactMessages).set({ status }).where(eq(contactMessages.id, id));
}

// ---------- Employees ----------
export async function listEmployees() {
  const db = requireDb(await getDb());
  return db.select().from(employees).orderBy(desc(employees.createdAt));
}

export async function getEmployeeByUserId(userId: number) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/** Find an employee by their invite token. */
export async function getEmployeeByInviteToken(token: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(employees).where(eq(employees.inviteToken, token)).limit(1);
  return rows[0] ?? null;
}

/** All auth users (for the admin staff-linking UI). */
export async function listAllUsers() {
  const db = requireDb(await getDb());
  return db.select().from(users).orderBy(desc(users.lastSignedIn)).limit(200);
}

export async function setUserRole(userId: number, role: "user" | "staff" | "admin") {
  const db = requireDb(await getDb());
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

/** Bookings joined with customer info for the staff dashboard (read-focused view). */
export async function listBookingsForStaff(filter: { status?: string; date?: string }) {
  const db = requireDb(await getDb());
  const conditions = [];
  if (filter.status) conditions.push(eq(bookings.status, filter.status as never));
  if (filter.date) conditions.push(eq(bookings.scheduledDate, filter.date));
  // Slotless admin-created bookings are excluded outright: a crew can act on
  // a job with a time, and only the owner (Admin → Appointments) tracks links
  // still waiting on the customer.
  conditions.push(isNotNull(bookings.scheduledDate));
  const base = db
    .select({ booking: bookings, customer: customers })
    .from(bookings)
    .leftJoin(customers, eq(bookings.customerId, customers.id));
  const rows =
    conditions.length > 0
      ? await base.where(and(...conditions)).orderBy(desc(bookings.scheduledDate)).limit(500)
      : await base.orderBy(desc(bookings.scheduledDate)).limit(500);
  return rows.map(stripJoinedPayToken);
}

/** All non-cancelled bookings within a YYYY-MM month for the staff calendar. */
export async function listBookingsForMonth(month: string) {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ booking: bookings, customer: customers })
    .from(bookings)
    .leftJoin(customers, eq(bookings.customerId, customers.id))
    .where(and(like(bookings.scheduledDate, `${month}%`), sql`${bookings.status} != 'cancelled'`))
    .orderBy(bookings.scheduledDate, bookings.scheduledTime);
  return rows.map(stripJoinedPayToken);
}

export async function createEmployee(data: typeof employees.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(employees).values(data);
  return Number(result[0].insertId);
}

export async function updateEmployee(id: number, data: Partial<typeof employees.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(employees).set(data).where(eq(employees.id, id));
}

export async function deleteEmployee(id: number) {
  const db = requireDb(await getDb());
  await db.delete(employees).where(eq(employees.id, id));
}

// ---------- Invoices ----------
export async function listInvoices() {
  const db = requireDb(await getDb());
  return db.select().from(invoices).orderBy(desc(invoices.createdAt)).limit(300);
}

export async function createInvoice(data: typeof invoices.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(invoices).values(data);
  return Number(result[0].insertId);
}

export async function updateInvoice(id: number, data: Partial<typeof invoices.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(invoices).set(data).where(eq(invoices.id, id));
}

/**
 * Marks an invoice paid, but only if it has not been settled already.
 *
 * Same shape as confirmUnpaidBooking: the status test lives in the WHERE, so
 * two deliveries of the same checkout.session.completed event cannot both
 * record a payment and both notify the owner. Returns true for the caller that
 * made the change.
 */
export async function settleUnpaidInvoice(
  id: number,
  data: { paidAt: Date; paidVia: "stripe"; stripePaymentIntentId?: string }
): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(invoices)
    .set({ status: "paid", ...data })
    .where(and(eq(invoices.id, id), notInArray(invoices.status, ["paid", "void"])));
  return affectedRows(result) > 0;
}

/**
 * Flags an already-settled invoice as needing a refund, at most once, so a
 * redelivered duplicate payment doesn't raise a second owner alert.
 */
export async function flagInvoiceRefundNeeded(id: number, stripePaymentIntentId?: string): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(invoices)
    .set({ refundNeeded: true, stripePaymentIntentId })
    .where(and(eq(invoices.id, id), eq(invoices.refundNeeded, false)));
  return affectedRows(result) > 0;
}

export async function getInvoiceById(id: number) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0];
}

/** Looks up the invoice behind an emailed balance payment link. */
export async function getInvoiceByPayToken(token: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(invoices).where(eq(invoices.payToken, token)).limit(1);
  return rows[0];
}

/**
 * Every invoice whose payment link is out and unpaid — the daily reminder
 * sweep's worklist.
 *
 * Deliberately NOT filtered by kind: manual invoices are billable and get
 * chased on the same schedule. Requiring a payToken is what keeps the sweep
 * honest — it selects only invoices that actually have a link to point at,
 * which excludes every pre-feature manual invoice (none were ever issued one)
 * without needing a created-after cutoff.
 */
export async function listSentBalanceInvoices() {
  const db = requireDb(await getDb());
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.status, "sent"), isNotNull(invoices.payToken)))
    .orderBy(invoices.createdAt)
    .limit(500);
}

/**
 * Claims one automatic balance reminder, atomically.
 *
 * The expected count is part of the WHERE alongside the status, so two
 * overlapping cron runs cannot both send reminder N — and a payment landing
 * mid-sweep (status no longer "sent") halts the sequence right here. The same
 * write renews the link's validity window, so the reminder never points at a
 * link that has already died of old age.
 */
export async function claimBalanceReminder(
  id: number,
  expectedCount: number,
  data: { linkExpiresAt: Date; dueDate: string },
  now: Date = new Date()
): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(invoices)
    .set({
      reminderCount: expectedCount + 1,
      lastReminderAt: now,
      linkExpiresAt: data.linkExpiresAt,
      dueDate: data.dueDate,
    })
    .where(
      and(eq(invoices.id, id), eq(invoices.status, "sent"), eq(invoices.reminderCount, expectedCount))
    );
  return affectedRows(result) > 0;
}

/**
 * Claims the once-per-sequence owner alert for a balance that outlived both
 * reminders unpaid. The alert field is nulled by a manual resend, which is
 * what re-arms the whole sequence.
 */
export async function claimBalanceReminderExhaustedAlert(id: number, now: Date = new Date()): Promise<boolean> {
  const db = requireDb(await getDb());
  const result = await db
    .update(invoices)
    .set({ reminderExhaustedAlertAt: now })
    .where(and(eq(invoices.id, id), eq(invoices.status, "sent"), isNull(invoices.reminderExhaustedAlertAt)));
  return affectedRows(result) > 0;
}

/**
 * Balance invoices waiting on an admin's review, oldest first — the approval
 * queue behind the Invoices badge.
 */
export async function listInvoicesAwaitingApproval() {
  const db = requireDb(await getDb());
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.kind, "balance"), eq(invoices.status, "awaiting_approval")))
    .orderBy(invoices.createdAt)
    .limit(200);
}

/**
 * The auto-generated balance invoice for a booking, if one exists. Used to keep
 * marking a booking completed idempotent — re-completing never issues a second
 * payment link. Manual invoices attached to the same booking are ignored.
 */
export async function getBalanceInvoiceForBooking(bookingId: number) {
  const db = requireDb(await getDb());
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.bookingId, bookingId), eq(invoices.kind, "balance")))
    .orderBy(desc(invoices.id))
    .limit(1);
  return rows[0];
}

// ---------- Payments ----------
export async function createPayment(data: typeof payments.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(payments).values(data);
  return Number(result[0].insertId);
}

export async function listPayments() {
  const db = requireDb(await getDb());
  return db.select().from(payments).orderBy(desc(payments.createdAt)).limit(300);
}

export async function updatePayment(id: number, data: Partial<typeof payments.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(payments).set(data).where(eq(payments.id, id));
}

// ---------- Reviews ----------
export async function listReviews(onlyApproved?: boolean) {
  const db = requireDb(await getDb());
  if (onlyApproved) {
    return db.select().from(reviews).where(eq(reviews.approved, true)).orderBy(desc(reviews.createdAt)).limit(100);
  }
  return db.select().from(reviews).orderBy(desc(reviews.createdAt)).limit(300);
}

export async function createReview(data: typeof reviews.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(reviews).values(data);
  return Number(result[0].insertId);
}

// ---------- Email log ----------
/**
 * Records one email attempt.
 *
 * Never throws, and deliberately does not use requireDb: this is
 * observability, and an observability failure must not be able to break the
 * thing it observes. A confirmation that went out unrecorded is a bad day; a
 * confirmation that failed BECAUSE the log insert failed is a worse one.
 */
export async function recordEmailAttempt(entry: typeof emailLog.$inferInsert): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(emailLog).values(entry);
  } catch (error) {
    console.warn("[EmailLog] Could not record send attempt:", error);
  }
}

/** Most recent attempts, newest first — backs the admin email log page. */
export async function listEmailLog(limit = 50) {
  const db = requireDb(await getDb());
  return db
    .select()
    .from(emailLog)
    .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/**
 * Records one email attempt and returns its row id, so the caller can come
 * back and mark it as the failure that raised the alert (or the one the cap
 * suppressed). Same never-throws contract as recordEmailAttempt: a null id
 * means "not recorded", which callers treat as "carry on".
 */
export async function recordEmailAttemptReturningId(
  entry: typeof emailLog.$inferInsert
): Promise<number | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const result = await db.insert(emailLog).values(entry);
    return Number(result[0].insertId) || null;
  } catch (error) {
    console.warn("[EmailLog] Could not record send attempt:", error);
    return null;
  }
}

/**
 * When the last failure alert actually went out, or null if never.
 *
 * Read from the table rather than a module-level timestamp because production
 * runs more than one instance: an in-memory clock would let every instance
 * send its own "hourly" alert, which is the flood the cap exists to prevent.
 * Never throws; an unreadable rate limit must not break the send path.
 */
export async function lastEmailAlertAt(): Promise<Date | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ alertSentAt: emailLog.alertSentAt })
      .from(emailLog)
      .where(isNotNull(emailLog.alertSentAt))
      .orderBy(desc(emailLog.alertSentAt))
      .limit(1);
    return rows[0]?.alertSentAt ?? null;
  } catch (error) {
    console.warn("[EmailLog] Could not read the last alert time:", error);
    return null;
  }
}

/** Marks a logged failure as the one that raised the owner alert. */
export async function markEmailAlertSent(id: number, at: Date): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.update(emailLog).set({ alertSentAt: at }).where(eq(emailLog.id, id));
  } catch (error) {
    console.warn("[EmailLog] Could not mark the alert as sent:", error);
  }
}

/** Marks a logged failure as one whose alert the hourly cap swallowed. */
export async function markEmailAlertSuppressed(id: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.update(emailLog).set({ alertSuppressed: true }).where(eq(emailLog.id, id));
  } catch (error) {
    console.warn("[EmailLog] Could not mark the alert as suppressed:", error);
  }
}

/** How many failures the cap has swallowed since a given moment — the outage's size. */
export async function countSuppressedSince(since: Date): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const rows = await db
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(and(eq(emailLog.alertSuppressed, true), gte(emailLog.createdAt, since)))
      .limit(1000);
    return rows.length;
  } catch (error) {
    console.warn("[EmailLog] Could not count suppressed alerts:", error);
    return 0;
  }
}

export async function updateReview(id: number, data: Partial<typeof reviews.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(reviews).set(data).where(eq(reviews.id, id));
}

export async function deleteReview(id: number) {
  const db = requireDb(await getDb());
  await db.delete(reviews).where(eq(reviews.id, id));
}

// ---------- Gallery ----------
export async function listGalleryItems(onlyVisible?: boolean) {
  const db = requireDb(await getDb());
  if (onlyVisible) {
    return db.select().from(galleryItems).where(eq(galleryItems.visible, true)).orderBy(galleryItems.sortOrder);
  }
  return db.select().from(galleryItems).orderBy(galleryItems.sortOrder);
}

export async function createGalleryItem(data: typeof galleryItems.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(galleryItems).values(data);
  return Number(result[0].insertId);
}

export async function updateGalleryItem(id: number, data: Partial<typeof galleryItems.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(galleryItems).set(data).where(eq(galleryItems.id, id));
}

export async function deleteGalleryItem(id: number) {
  const db = requireDb(await getDb());
  await db.delete(galleryItems).where(eq(galleryItems.id, id));
}

// ---------- Blog ----------
export async function listBlogPosts(onlyPublished?: boolean) {
  const db = requireDb(await getDb());
  if (onlyPublished) {
    return db
      .select()
      .from(blogPosts)
      .where(eq(blogPosts.published, true))
      .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id))
      .limit(200);
  }
  return db.select().from(blogPosts).orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id)).limit(500);
}

export async function getBlogPostBySlug(slug: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(blogPosts).where(eq(blogPosts.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function createBlogPost(data: typeof blogPosts.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(blogPosts).values(data);
  return Number(result[0].insertId);
}

export async function updateBlogPost(id: number, data: Partial<typeof blogPosts.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(blogPosts).set(data).where(eq(blogPosts.id, id));
}

export async function deleteBlogPost(id: number) {
  const db = requireDb(await getDb());
  await db.delete(blogPosts).where(eq(blogPosts.id, id));
}

// ---------- Coupons ----------
export async function listCoupons() {
  const db = requireDb(await getDb());
  return db.select().from(coupons).orderBy(desc(coupons.createdAt));
}

export async function getCouponByCode(code: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(coupons).where(eq(coupons.code, code)).limit(1);
  return rows[0];
}

export async function createCoupon(data: typeof coupons.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(coupons).values(data);
  return Number(result[0].insertId);
}

export async function updateCoupon(id: number, data: Partial<typeof coupons.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(coupons).set(data).where(eq(coupons.id, id));
}

export async function deleteCoupon(id: number) {
  const db = requireDb(await getDb());
  await db.delete(coupons).where(eq(coupons.id, id));
}

export async function incrementCouponRedemptions(id: number) {
  const db = requireDb(await getDb());
  await db
    .update(coupons)
    .set({ timesRedeemed: sql`${coupons.timesRedeemed} + 1` })
    .where(eq(coupons.id, id));
}

// ---------- Settings ----------
// ---------- Connected properties (Airbnb/VRBO auto-booking) ----------

export async function listConnectedProperties() {
  const db = requireDb(await getDb());
  return db
    .select({ property: connectedProperties, customer: customers })
    .from(connectedProperties)
    .leftJoin(customers, eq(connectedProperties.customerId, customers.id))
    .orderBy(desc(connectedProperties.createdAt));
}

export async function getConnectedPropertyById(id: number) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(connectedProperties).where(eq(connectedProperties.id, id)).limit(1);
  return rows[0];
}

export async function createConnectedProperty(data: typeof connectedProperties.$inferInsert) {
  const db = requireDb(await getDb());
  const result = await db.insert(connectedProperties).values(data);
  return Number(result[0].insertId);
}

export async function updateConnectedProperty(
  id: number,
  data: Partial<typeof connectedProperties.$inferInsert>
) {
  const db = requireDb(await getDb());
  await db.update(connectedProperties).set(data).where(eq(connectedProperties.id, id));
}

/** Every feed the hourly sync should poll. */
export async function listActiveSyncProperties() {
  const db = requireDb(await getDb());
  return db.select().from(connectedProperties).where(eq(connectedProperties.active, true));
}

/**
 * Every auto-created booking for one property, whatever its status — the sync
 * decides per row what may be touched (never in_progress/completed, never
 * resurrect cancelled).
 */
export async function listAutoBookingsForProperty(propertyId: number) {
  const db = requireDb(await getDb());
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.propertyId, propertyId), eq(bookings.kind, "ical_auto")));
}

/** The next synced cleans shown on the property card. */
export async function listUpcomingAutoBookings(propertyId: number, today: string, limit = 3) {
  const db = requireDb(await getDb());
  return db
    .select({
      id: bookings.id,
      scheduledDate: bookings.scheduledDate,
      scheduledTime: bookings.scheduledTime,
      status: bookings.status,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.propertyId, propertyId),
        eq(bookings.kind, "ical_auto"),
        notInArray(bookings.status, ["cancelled", "expired", "completed"]),
        or(isNull(bookings.scheduledDate), gte(bookings.scheduledDate, today))
      )
    )
    .orderBy(bookings.scheduledDate, bookings.scheduledTime)
    .limit(limit);
}

export async function getSetting(key: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(siteSettings).where(eq(siteSettings.settingKey, key)).limit(1);
  return rows[0]?.settingValue ?? null;
}

export async function setSetting(key: string, value: string) {
  const db = requireDb(await getDb());
  await db
    .insert(siteSettings)
    .values({ settingKey: key, settingValue: value })
    .onDuplicateKeyUpdate({ set: { settingValue: value } });
}

export async function listSettings() {
  const db = requireDb(await getDb());
  return db.select().from(siteSettings);
}

// ---------- Marketing (re-booking nudges) ----------

/**
 * Every customer the nudge sweep should consider, with the three facts the
 * decision turns on: when they last had a cleaning, whether they have one
 * coming, and whether they owe us anything.
 *
 * Computed in SQL as correlated subqueries rather than by loading bookings and
 * invoices into memory — the list grows with the business, and the sweep runs
 * daily forever. Customers with no email are excluded here rather than later:
 * there is no point carrying them through the cadence at all.
 *
 * Unsubscribed customers ARE returned, so the sweep can count and log them.
 * nudgeDecision refuses them; this keeps "we skipped 12 unsubscribed" visible
 * instead of silently invisible.
 */
export async function listNudgeCandidates(limit = 500) {
  const db = requireDb(await getDb());
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select({
      customerId: customers.id,
      firstName: customers.firstName,
      email: customers.email,
      preferredLocale: customers.preferredLocale,
      marketingUnsubscribedAt: customers.marketingUnsubscribedAt,
      marketingToken: customers.marketingToken,
      lastMarketingEmailAt: customers.lastMarketingEmailAt,
      marketingEmailCount: customers.marketingEmailCount,
      lastCompletedDate: sql<string | null>`(
        SELECT MAX(b.scheduledDate) FROM bookings b
        WHERE b.customerId = ${customers.id} AND b.status = 'completed'
      )`,
      upcomingCount: sql<number>`(
        SELECT COUNT(*) FROM bookings b
        WHERE b.customerId = ${customers.id}
          AND b.status IN ('pending_deposit','confirmed','in_progress')
          AND (b.scheduledDate IS NULL OR b.scheduledDate >= ${today})
      )`,
      openInvoiceCount: sql<number>`(
        SELECT COUNT(*) FROM invoices i
        WHERE i.customerId = ${customers.id}
          AND i.status IN ('sent','overdue','awaiting_approval','draft')
      )`,
    })
    .from(customers)
    .where(isNotNull(customers.email))
    .limit(limit);
}

/** The customer behind an unsubscribe link, or undefined for an unknown token. */
export async function getCustomerByMarketingToken(token: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(customers).where(eq(customers.marketingToken, token)).limit(1);
  return rows[0];
}

// ---------- Owner reporting (weekly digest + daily health check) ----------

/** Email volume for a period, grouped by flow and outcome. */
export async function emailStatsSince(since: Date) {
  const db = requireDb(await getDb());
  return db
    .select({
      emailType: emailLog.emailType,
      outcome: emailLog.outcome,
      count: sql<number>`COUNT(*)`,
    })
    .from(emailLog)
    .where(gte(emailLog.createdAt, since))
    .groupBy(emailLog.emailType, emailLog.outcome);
}

/**
 * Failures in the period, newest first — including the ones the hourly alert
 * cap swallowed. Those are the whole point: a failure that never raised an
 * alert is exactly the failure nobody has seen.
 */
export async function emailFailuresSince(since: Date, limit = 25) {
  const db = requireDb(await getDb());
  return db
    .select({
      createdAt: emailLog.createdAt,
      recipient: emailLog.recipient,
      subject: emailLog.subject,
      emailType: emailLog.emailType,
      outcome: emailLog.outcome,
      errorText: emailLog.errorText,
      alertSuppressed: emailLog.alertSuppressed,
      alertSentAt: emailLog.alertSentAt,
    })
    .from(emailLog)
    .where(and(gte(emailLog.createdAt, since), inArray(emailLog.outcome, ["error", "log_only"])))
    .orderBy(desc(emailLog.createdAt))
    .limit(limit);
}

/**
 * A paid invoice whose booking never reached "completed".
 *
 * This is the shape of the Daniel bug: money collected against a job the
 * system still thinks is pending, which silently suppresses the tip ask and
 * keeps the customer out of the re-booking cycle. The settle path now fixes
 * this going forward; the check catches anything that slips through another
 * route (a hand-edited row, a future code path).
 */
export async function findPaidInvoicesOnOpenBookings() {
  const db = requireDb(await getDb());
  return db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      amount: invoices.amount,
      bookingId: bookings.id,
      reference: bookings.reference,
      bookingStatus: bookings.status,
      scheduledDate: bookings.scheduledDate,
    })
    .from(invoices)
    .innerJoin(bookings, eq(invoices.bookingId, bookings.id))
    .where(and(eq(invoices.status, "paid"), notInArray(bookings.status, ["completed", "cancelled"])))
    .limit(50);
}

/**
 * An unpaid invoice whose payment link has expired: the customer cannot pay
 * even if they want to, and no automatic path will ever fix it. Someone has to
 * press Resend, which means someone has to know.
 */
export async function findInvoicesWithDeadLinks(now: Date = new Date()) {
  const db = requireDb(await getDb());
  return db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.number,
      amount: invoices.amount,
      customerId: invoices.customerId,
      linkExpiresAt: invoices.linkExpiresAt,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, ["sent", "overdue"]),
        isNotNull(invoices.linkExpiresAt),
        lte(invoices.linkExpiresAt, now)
      )
    )
    .limit(50);
}

/**
 * Customers with no email address. Not a fault in itself — a phone lead is a
 * real customer — but each one is silently excluded from every confirmation,
 * receipt and nudge, so the count is worth seeing.
 */
export async function findCustomersWithoutEmail() {
  const db = requireDb(await getDb());
  return db
    .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, phone: customers.phone })
    .from(customers)
    .where(isNull(customers.email))
    .limit(50);
}

/** Headline totals for the digest. */
export async function ownerTotals() {
  const db = requireDb(await getDb());
  const today = new Date().toISOString().slice(0, 10);
  const [bookingTotal] = await db.select({ count: sql<number>`COUNT(*)` }).from(bookings);
  const [upcoming] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ["pending_deposit", "confirmed", "in_progress"]),
        or(isNull(bookings.scheduledDate), gte(bookings.scheduledDate, today))
      )
    );
  const [unpaid] = await db
    .select({ count: sql<number>`COUNT(*)`, total: sql<number>`COALESCE(SUM(${invoices.amount}), 0)` })
    .from(invoices)
    .where(inArray(invoices.status, ["sent", "overdue", "awaiting_approval", "draft"]));
  const [customerTotal] = await db.select({ count: sql<number>`COUNT(*)` }).from(customers);
  return {
    bookings: Number(bookingTotal?.count ?? 0),
    upcomingBookings: Number(upcoming?.count ?? 0),
    unpaidInvoices: Number(unpaid?.count ?? 0),
    unpaidTotal: Number(unpaid?.total ?? 0),
    customers: Number(customerTotal?.count ?? 0),
  };
}

/**
 * Records that a nudge went out: bumps the count and stamps the clock, and
 * stores the unsubscribe token if this was the customer's first.
 *
 * The count is incremented in SQL rather than written from a value read
 * earlier, so two sweeps overlapping cannot both write "1".
 */
export async function recordMarketingEmailSent(
  customerId: number,
  marketingToken: string,
  now: Date = new Date()
): Promise<void> {
  const db = requireDb(await getDb());
  await db
    .update(customers)
    .set({
      lastMarketingEmailAt: now,
      marketingEmailCount: sql`${customers.marketingEmailCount} + 1`,
      marketingToken,
    })
    .where(eq(customers.id, customerId));
}

/**
 * Honours an unsubscribe. Idempotent, and deliberately one-way: nothing in the
 * automated paths ever clears this column, so consent withdrawn stays
 * withdrawn. Re-subscribing is a human action through the admin, by request.
 */
export async function unsubscribeFromMarketing(customerId: number, now: Date = new Date()): Promise<void> {
  const db = requireDb(await getDb());
  await db
    .update(customers)
    .set({ marketingUnsubscribedAt: now })
    .where(and(eq(customers.id, customerId), isNull(customers.marketingUnsubscribedAt)));
}

// ---------- Statistics ----------
export async function getDashboardStats() {
  const db = requireDb(await getDb());
  const [bookingCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(bookings);
  const [customerCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(customers);
  const [revenue] = await db
    .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(eq(payments.status, "succeeded"));
  const [pendingCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(bookings)
    .where(eq(bookings.status, "confirmed"));
  const [reviewAvg] = await db
    .select({ avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)` })
    .from(reviews)
    .where(eq(reviews.approved, true));
  return {
    totalBookings: Number(bookingCount.count),
    totalCustomers: Number(customerCount.count),
    totalRevenue: Number(revenue.total),
    upcomingBookings: Number(pendingCount.count),
    averageRating: Number(reviewAvg.avg),
  };
}

export async function getMonthlyRevenue() {
  const db = requireDb(await getDb());
  return db
    .select({
      month: sql<string>`DATE_FORMAT(${payments.createdAt}, '%Y-%m')`.as("month"),
      total: sql<number>`SUM(${payments.amount})`,
    })
    .from(payments)
    .where(eq(payments.status, "succeeded"))
    .groupBy(sql`month`)
    .orderBy(sql`month`);
}

export async function getBookingsByService() {
  const db = requireDb(await getDb());
  return db
    .select({
      serviceType: bookings.serviceType,
      count: sql<number>`COUNT(*)`,
    })
    .from(bookings)
    .groupBy(bookings.serviceType);
}

// ---------- Brain read API (paged, filtered reads — see server/brainRoutes.ts) ----------

/**
 * Each pager returns `{ rows, total }` where `total` is the full count under
 * the same filters, not the page size — the brain compares it against what it
 * received to detect a truncated read. Ordering is newest-first with `id` as
 * the tiebreak so offset pagination walks a stable sequence.
 */
export type BrainPageArgs = { limit: number; offset: number };

export async function pageCustomersForBrain({ limit, offset }: BrainPageArgs) {
  const db = requireDb(await getDb());
  const rows = await db
    .select()
    .from(customers)
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ total: sql<number>`COUNT(*)` }).from(customers);
  return { rows, total: Number(count?.total ?? 0) };
}

export async function pageBookingsForBrain({
  limit,
  offset,
  since,
  customerId,
}: BrainPageArgs & { since?: Date; customerId?: number }) {
  const db = requireDb(await getDb());
  const conditions = [];
  if (since) conditions.push(gte(bookings.createdAt, since));
  if (customerId !== undefined) conditions.push(eq(bookings.customerId, customerId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(bookings)
    .where(where)
    .orderBy(desc(bookings.createdAt), desc(bookings.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ total: sql<number>`COUNT(*)` }).from(bookings).where(where);
  return { rows, total: Number(count?.total ?? 0) };
}

export async function pageContactMessagesForBrain({
  limit,
  offset,
  since,
}: BrainPageArgs & { since?: Date }) {
  const db = requireDb(await getDb());
  const where = since ? gte(contactMessages.createdAt, since) : undefined;
  const rows = await db
    .select()
    .from(contactMessages)
    .where(where)
    .orderBy(desc(contactMessages.createdAt), desc(contactMessages.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ total: sql<number>`COUNT(*)` }).from(contactMessages).where(where);
  return { rows, total: Number(count?.total ?? 0) };
}

export async function pagePaymentsForBrain({
  limit,
  offset,
  since,
  customerId,
}: BrainPageArgs & { since?: Date; customerId?: number }) {
  const db = requireDb(await getDb());
  const conditions = [];
  if (since) conditions.push(gte(payments.createdAt, since));
  if (customerId !== undefined) conditions.push(eq(payments.customerId, customerId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ total: sql<number>`COUNT(*)` }).from(payments).where(where);
  return { rows, total: Number(count?.total ?? 0) };
}
