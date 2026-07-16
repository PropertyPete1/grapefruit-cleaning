import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  bookings,
  contactMessages,
  coupons,
  customers,
  employees,
  galleryItems,
  invoices,
  payments,
  reviews,
  siteSettings,
  users,
} from "../drizzle/schema";
import { ENV } from './_core/env';

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

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

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

// ---------- Customers ----------
export async function findOrCreateCustomer(data: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address?: string;
  city?: string;
  zip?: string;
  preferredLocale?: "en" | "es";
}) {
  const db = requireDb(await getDb());
  const existing = await db.select().from(customers).where(eq(customers.email, data.email)).limit(1);
  if (existing.length > 0) {
    await db
      .update(customers)
      .set({
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? existing[0].phone,
        address: data.address ?? existing[0].address,
        city: data.city ?? existing[0].city,
        zip: data.zip ?? existing[0].zip,
        preferredLocale: data.preferredLocale ?? existing[0].preferredLocale,
      })
      .where(eq(customers.id, existing[0].id));
    return existing[0].id;
  }
  const result = await db.insert(customers).values(data);
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

export async function getBookingByStripeSession(sessionId: string) {
  const db = requireDb(await getDb());
  const rows = await db.select().from(bookings).where(eq(bookings.stripeSessionId, sessionId)).limit(1);
  return rows[0];
}

export async function updateBooking(id: number, data: Partial<typeof bookings.$inferInsert>) {
  const db = requireDb(await getDb());
  await db.update(bookings).set(data).where(eq(bookings.id, id));
}

export async function listBookings(filter?: { status?: string; from?: string; to?: string }) {
  const db = requireDb(await getDb());
  const conditions = [];
  if (filter?.status) conditions.push(eq(bookings.status, filter.status as never));
  if (filter?.from) conditions.push(gte(bookings.scheduledDate, filter.from));
  if (filter?.to) conditions.push(lte(bookings.scheduledDate, filter.to));
  if (conditions.length > 0) {
    return db
      .select()
      .from(bookings)
      .where(and(...conditions))
      .orderBy(desc(bookings.scheduledDate))
      .limit(500);
  }
  return db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(500);
}

export async function listBookingsForCustomer(customerId: number) {
  const db = requireDb(await getDb());
  return db.select().from(bookings).where(eq(bookings.customerId, customerId)).orderBy(desc(bookings.createdAt));
}

/** Booked time slots for a given date (to grey out taken slots). */
export async function getBookedSlots(date: string) {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ time: bookings.scheduledTime })
    .from(bookings)
    .where(and(eq(bookings.scheduledDate, date), sql`${bookings.status} != 'cancelled'`));
  return rows.map(r => r.time);
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
  const base = db
    .select({ booking: bookings, customer: customers })
    .from(bookings)
    .leftJoin(customers, eq(bookings.customerId, customers.id));
  if (conditions.length > 0) {
    return base.where(and(...conditions)).orderBy(desc(bookings.scheduledDate)).limit(500);
  }
  return base.orderBy(desc(bookings.scheduledDate)).limit(500);
}

/** All non-cancelled bookings within a YYYY-MM month for the staff calendar. */
export async function listBookingsForMonth(month: string) {
  const db = requireDb(await getDb());
  return db
    .select({ booking: bookings, customer: customers })
    .from(bookings)
    .leftJoin(customers, eq(bookings.customerId, customers.id))
    .where(and(like(bookings.scheduledDate, `${month}%`), sql`${bookings.status} != 'cancelled'`))
    .orderBy(bookings.scheduledDate, bookings.scheduledTime);
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
      month: sql<string>`DATE_FORMAT(${payments.createdAt}, '%Y-%m')`,
      total: sql<number>`SUM(${payments.amount})`,
    })
    .from(payments)
    .where(eq(payments.status, "succeeded"))
    .groupBy(sql`DATE_FORMAT(${payments.createdAt}, '%Y-%m')`)
    .orderBy(sql`DATE_FORMAT(${payments.createdAt}, '%Y-%m')`);
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
