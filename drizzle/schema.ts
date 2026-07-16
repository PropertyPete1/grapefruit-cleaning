import { boolean, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "staff", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** Customers (guest bookings allowed — not tied to auth users). */
export const customers = mysqlTable("customers", {
  id: int("id").autoincrement().primaryKey(),
  firstName: varchar("firstName", { length: 100 }).notNull(),
  lastName: varchar("lastName", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 40 }),
  address: varchar("address", { length: 255 }),
  city: varchar("city", { length: 100 }),
  zip: varchar("zip", { length: 20 }),
  preferredLocale: mysqlEnum("preferredLocale", ["en", "es"]).default("en").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Customer = typeof customers.$inferSelect;

export const bookings = mysqlTable("bookings", {
  id: int("id").autoincrement().primaryKey(),
  reference: varchar("reference", { length: 20 }).notNull().unique(),
  customerId: int("customerId").notNull(),
  serviceType: mysqlEnum("serviceType", ["residential", "commercial", "airbnb", "moveinout", "deep", "office"]).notNull(),
  frequency: mysqlEnum("frequency", ["onetime", "weekly", "biweekly", "monthly"]).default("onetime").notNull(),
  scheduledDate: varchar("scheduledDate", { length: 10 }).notNull(),
  scheduledTime: varchar("scheduledTime", { length: 5 }).notNull(),
  bedrooms: int("bedrooms").default(2).notNull(),
  bathrooms: int("bathrooms").default(1).notNull(),
  sqft: int("sqft").default(1000).notNull(),
  extras: text("extras"),
  addressLine: varchar("addressLine", { length: 255 }),
  city: varchar("city", { length: 100 }),
  zip: varchar("zip", { length: 20 }),
  notes: text("notes"),
  locale: mysqlEnum("locale", ["en", "es"]).default("en").notNull(),
  totalAmount: int("totalAmount").notNull(),
  depositAmount: int("depositAmount").notNull(),
  status: mysqlEnum("status", ["pending_deposit", "confirmed", "in_progress", "completed", "cancelled"])
    .default("pending_deposit")
    .notNull(),
  employeeId: int("employeeId"),
  couponCode: varchar("couponCode", { length: 40 }),
  discountApplied: int("discountApplied").default(0).notNull(),
  stripeSessionId: varchar("stripeSessionId", { length: 255 }),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  /** Timestamp when the 7-days-before reminder email was sent (null = not sent yet). */
  weekReminderSentAt: timestamp("weekReminderSentAt"),
  /** Timestamp when the 1-day-before reminder email was sent (null = not sent yet). */
  dayReminderSentAt: timestamp("dayReminderSentAt"),
  /** Square footage verified against public property records (null = no record found / not looked up). */
  verifiedSqft: int("verifiedSqft"),
  /** Source of the verified square footage, e.g. "bexar_gis". */
  sqftSource: varchar("sqftSource", { length: 30 }),
  /** True when the customer-entered sqft landed in a lower price tier than the verified record (price auto-corrected). */
  sqftMismatch: boolean("sqftMismatch").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Booking = typeof bookings.$inferSelect;

export const contactMessages = mysqlTable("contact_messages", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 40 }),
  subject: varchar("subject", { length: 255 }),
  message: text("message").notNull(),
  locale: mysqlEnum("locale", ["en", "es"]).default("en").notNull(),
  status: mysqlEnum("status", ["new", "replied", "archived"]).default("new").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ContactMessage = typeof contactMessages.$inferSelect;

export const employees = mysqlTable("employees", {
  id: int("id").autoincrement().primaryKey(),
  /** Optional link to users.id so this employee can sign in and access the staff dashboard. */
  userId: int("userId"),
  firstName: varchar("firstName", { length: 100 }).notNull(),
  lastName: varchar("lastName", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 40 }),
  role: varchar("role", { length: 100 }).default("Cleaner"),
  active: boolean("active").default(true).notNull(),
  /** Secure invite token for connecting this employee to a user account (null once accepted or revoked). */
  inviteToken: varchar("inviteToken", { length: 64 }),
  /** When the current invite token was generated. */
  inviteSentAt: timestamp("inviteSentAt"),
  /** When the employee accepted the invite and their account was linked. */
  inviteAcceptedAt: timestamp("inviteAcceptedAt"),
  hiredAt: timestamp("hiredAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Employee = typeof employees.$inferSelect;

export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  number: varchar("number", { length: 20 }).notNull().unique(),
  bookingId: int("bookingId"),
  customerId: int("customerId").notNull(),
  amount: int("amount").notNull(),
  status: mysqlEnum("status", ["draft", "sent", "paid", "overdue", "void"]).default("draft").notNull(),
  dueDate: varchar("dueDate", { length: 10 }),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Invoice = typeof invoices.$inferSelect;

export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  bookingId: int("bookingId"),
  invoiceId: int("invoiceId"),
  customerId: int("customerId"),
  amount: int("amount").notNull(),
  kind: mysqlEnum("kind", ["deposit", "balance", "full", "refund"]).default("deposit").notNull(),
  method: varchar("method", { length: 40 }).default("card"),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  status: mysqlEnum("status", ["pending", "succeeded", "failed", "refunded"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Payment = typeof payments.$inferSelect;

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  customerName: varchar("customerName", { length: 200 }).notNull(),
  bookingId: int("bookingId"),
  rating: int("rating").notNull(),
  text: text("text"),
  source: varchar("source", { length: 60 }).default("website"),
  approved: boolean("approved").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Review = typeof reviews.$inferSelect;

export const galleryItems = mysqlTable("gallery_items", {
  id: int("id").autoincrement().primaryKey(),
  url: varchar("url", { length: 500 }).notNull(),
  fileKey: varchar("fileKey", { length: 255 }),
  altEn: varchar("altEn", { length: 255 }),
  altEs: varchar("altEs", { length: 255 }),
  category: mysqlEnum("category", ["residential", "commercial", "airbnb", "deep"]).default("residential").notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  visible: boolean("visible").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type GalleryItem = typeof galleryItems.$inferSelect;

export const coupons = mysqlTable("coupons", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  description: varchar("description", { length: 255 }),
  percentOff: int("percentOff"),
  amountOff: int("amountOff"),
  active: boolean("active").default(true).notNull(),
  maxRedemptions: int("maxRedemptions"),
  timesRedeemed: int("timesRedeemed").default(0).notNull(),
  expiresAt: varchar("expiresAt", { length: 10 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Coupon = typeof coupons.$inferSelect;

export const siteSettings = mysqlTable("site_settings", {
  id: int("id").autoincrement().primaryKey(),
  settingKey: varchar("settingKey", { length: 100 }).notNull().unique(),
  settingValue: text("settingValue"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type SiteSetting = typeof siteSettings.$inferSelect;
