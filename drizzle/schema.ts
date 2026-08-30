import { sql } from "drizzle-orm";
import { boolean, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Booking statuses that occupy their calendar slot. Cancelled and expired
 * bookings release it, which is what makes a slot reusable.
 */
export const SLOT_HOLDING_STATUSES = ["pending_deposit", "confirmed", "in_progress", "completed"] as const;

/** Name of the unique index enforcing one live booking per slot. */
export const SLOT_UNIQUE_INDEX = "bookings_slotKey_unique";

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
  /**
   * NULL for a phone-only lead the owner entered by hand. Every email send
   * funnels through deliverEmail, which refuses an empty address, so a missing
   * one degrades to "no email goes out" rather than an error anywhere.
   */
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 40 }),
  address: varchar("address", { length: 255 }),
  city: varchar("city", { length: 100 }),
  zip: varchar("zip", { length: 20 }),
  preferredLocale: mysqlEnum("preferredLocale", ["en", "es"]).default("en").notNull(),
  notes: text("notes"),
  /**
   * Marketing consent and the state behind the re-booking nudges.
   *
   * `marketingUnsubscribedAt` is the one that carries legal weight: once set,
   * no automated path ever clears it, so an unsubscribe is honoured forever
   * rather than lapsing after some window. Transactional mail — invoices,
   * receipts, reminders about a job they actually booked — is unaffected, and
   * deliberately so: a customer cannot opt out of being told what they owe.
   *
   * `marketingToken` is the bearer credential in the unsubscribe URL, minted
   * with the first nudge and never rotated (an old email's link must keep
   * working years later). `lastMarketingEmailAt` enforces the 21-day floor
   * between marketing sends, and `marketingEmailCount` distinguishes the first
   * warm "we'd love to have you back" from the monthly ones that follow.
   */
  marketingUnsubscribedAt: timestamp("marketingUnsubscribedAt"),
  marketingToken: varchar("marketingToken", { length: 64 }).unique(),
  lastMarketingEmailAt: timestamp("lastMarketingEmailAt"),
  marketingEmailCount: int("marketingEmailCount").default(0).notNull(),
  repairNote: text("repairNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Customer = typeof customers.$inferSelect;

export const bookings = mysqlTable("bookings", {
  id: int("id").autoincrement().primaryKey(),
  reference: varchar("reference", { length: 20 }).notNull().unique(),
  customerId: int("customerId").notNull(),
  /**
   * NULL on an admin-created booking whose customer hasn't chosen yet. A phone
   * lead may be nothing but a name and a number; the missing facts are what
   * the deposit link asks the customer for. Self-serve bookings always have
   * one — the public form can't submit without it.
   */
  serviceType: mysqlEnum("serviceType", ["residential", "commercial", "airbnb", "moveinout", "deep", "office"]),
  frequency: mysqlEnum("frequency", ["onetime", "weekly", "biweekly", "monthly"]).default("onetime").notNull(),
  /**
   * Both NULL while an admin-created booking waits for the customer to pick a
   * time on their link. A slotless booking holds no inventory: slotKey is
   * generated from these via CONCAT, and CONCAT with a NULL argument is NULL,
   * so the unique index ignores the row until a slot is actually claimed.
   */
  scheduledDate: varchar("scheduledDate", { length: 10 }),
  scheduledTime: varchar("scheduledTime", { length: 5 }),
  bedrooms: int("bedrooms").default(2).notNull(),
  bathrooms: int("bathrooms").default(1).notNull(),
  /** NULL until a size is known — owner-entered, county-verified, or customer-chosen. */
  sqft: int("sqft"),
  extras: text("extras"),
  addressLine: varchar("addressLine", { length: 255 }),
  /**
   * "204", "5B", "Ste 300" — rendered into the address wherever it shows
   * (crew cards, emails, admin tables). "Apt 204" is the difference between a
   * cleaning and twenty minutes of knocking on doors.
   */
  unitNumber: varchar("unitNumber", { length: 20 }),
  /**
   * House or apartment/condo. County parcels are BUILDING-level, so apartment
   * bookings skip sqft verification entirely — a lookup for a unit either
   * fails or returns the whole complex, and the complex must never reprice a
   * one-bedroom upward. Houses verify as always.
   */
  propertyType: mysqlEnum("propertyType", ["house", "apartment"]).default("house").notNull(),
  city: varchar("city", { length: 100 }),
  zip: varchar("zip", { length: 20 }),
  notes: text("notes"),
  locale: mysqlEnum("locale", ["en", "es"]).default("en").notNull(),
  totalAmount: int("totalAmount").notNull(),
  depositAmount: int("depositAmount").notNull(),
  /** Exact monetary snapshots for new writes. Legacy dollar fields stay in place for rollback. */
  baseAmountCents: int("baseAmountCents"),
  addonsAmountCents: int("addonsAmountCents"),
  totalAmountCents: int("totalAmountCents"),
  depositAmountCents: int("depositAmountCents"),
  status: mysqlEnum("status", ["pending_deposit", "confirmed", "in_progress", "completed", "cancelled", "expired"])
    .default("pending_deposit")
    .notNull(),
  employeeId: int("employeeId"),
  couponCode: varchar("couponCode", { length: 40 }),
  discountApplied: int("discountApplied").default(0).notNull(),
  discountAppliedCents: int("discountAppliedCents"),
  stripeSessionId: varchar("stripeSessionId", { length: 255 }),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  /** Timestamp when the 7-days-before reminder email was sent (null = not sent yet). */
  weekReminderSentAt: timestamp("weekReminderSentAt"),
  /** Timestamp when the 1-day-before reminder email was sent (null = not sent yet). */
  dayReminderSentAt: timestamp("dayReminderSentAt"),
  /**
   * Timestamp when the "we've started your cleaning" email was sent (null = not
   * sent yet). This column, not the status, is what makes that email
   * once-per-booking: a job flipped back to confirmed and started again is a
   * correction, not a second cleaning to announce.
   */
  startedEmailSentAt: timestamp("startedEmailSentAt"),
  /** Timestamp when the standalone "cleaning complete" thank-you was sent (null = not sent yet). */
  completedEmailSentAt: timestamp("completedEmailSentAt"),
  /**
   * Secret token behind the tip page (/pay/tip/:token), minted when the
   * settled-and-complete thank-you goes out. Same bearer-token shape as the
   * deposit and balance links; the page computes every dollar server-side.
   */
  tipToken: varchar("tipToken", { length: 64 }),
  /**
   * When the tip-request thank-you was sent (null = not sent yet). This is the
   * once-per-booking claim for that email, exactly like startedEmailSentAt —
   * and the claim also requires completedEmailSentAt to be unset, so a booking
   * gets the tip email OR the plain thank-you, never both.
   */
  tipEmailSentAt: timestamp("tipEmailSentAt"),
  /** When a tip payment landed (null = none). The claim against double-recording a redelivered webhook. */
  tipPaidAt: timestamp("tipPaidAt"),
  /** The tip actually paid, in whole dollars. */
  tipAmount: int("tipAmount"),
  /** Exact tip amount for new Stripe and offline writes; null means read legacy `tipAmount * 100`. */
  tipAmountCents: int("tipAmountCents"),
  /** Payment intent that paid the tip — how a redelivered event is told from a genuine second payment. */
  tipStripePaymentIntentId: varchar("tipStripePaymentIntentId", { length: 255 }),
  /** Set when the customer tapped "no tip, just say thanks" — the page stops asking. */
  tipDeclinedAt: timestamp("tipDeclinedAt"),
  /**
   * Hours the crew is expected to be on site, pinned when the booking was made.
   *
   * Stored rather than recomputed so that editing the duration ladder later
   * cannot change the span a booking that is already paid for occupies —
   * lengthening residential by an hour would otherwise make two confirmed
   * neighbours overlap each other retroactively, with no fix but rescheduling
   * a customer. Same reasoning as totalAmount and depositAmount, which are
   * likewise frozen at their computed value.
   *
   * NULL on rows written before durations existed; the scheduler falls back to
   * the current ladder for those, so no backfill was needed.
   */
  estimatedHours: int("estimatedHours"),
  /** Square footage verified against public property records (null = no record found / not looked up). */
  verifiedSqft: int("verifiedSqft"),
  /** Source of the verified square footage, e.g. "bexar_gis". */
  sqftSource: varchar("sqftSource", { length: 30 }),
  /** True when the customer-entered sqft landed in a lower price tier than the verified record (price auto-corrected). */
  sqftMismatch: boolean("sqftMismatch").default(false).notNull(),
  /**
   * Set when a late payment recovered an expired booking whose date/time slot
   * had already been retaken by another booking — owner must reschedule one.
   */
  slotConflict: boolean("slotConflict").default(false).notNull(),
  /**
   * Which facts the OWNER supplied when creating a booking by hand, as a CSV
   * subset of "service,size,address,slot".
   *
   * This is the completion-state provenance: a fact the owner locked is shown
   * to the customer as settled and may not be changed through the deposit
   * link, while anything absent from this list is the customer's to fill in —
   * and to re-edit until they pay. Derivable from nothing else: once the
   * customer picks a service, the row looks identical to one where the owner
   * chose it, and the difference decides both what the page may edit and what
   * the owner's completion email highlights.
   *
   * NULL on self-serve bookings, where the question never arises.
   */
  adminProvided: varchar("adminProvided", { length: 60 }),
  /**
   * Who created this booking. "self_serve" is the public booking flow;
   * "admin" is the owner entering a phone or text lead by hand, which then
   * gets a personal deposit link the customer completes themselves.
   *
   * Not derivable from anything else on the row: an admin-created booking that
   * has been paid looks exactly like a self-serve one afterwards, and the
   * difference is what justifies its longer slot hold.
   */
  kind: mysqlEnum("kind", ["self_serve", "admin", "ical_auto"]).default("self_serve").notNull(),
  /**
   * Minutes this booking may hold its slot while the deposit is unpaid,
   * pinned at creation.
   *
   * A phone lead needs the evening to decide, so admin-created bookings hold
   * for 24 hours where the public flow holds for one. Stored per booking
   * rather than read from the setting at expiry time for the same reason
   * estimatedHours and totalAmount are: raising the window later must not
   * retroactively resurrect a slot that has already been released and rebooked.
   *
   * NULL on rows written before this existed; the rules fall back to
   * STALE_DEPOSIT_MINUTES for those, which is exactly what they used to do.
   */
  holdMinutes: int("holdMinutes"),
  /**
   * Secret token behind an admin-created booking's deposit link
   * (/pay/deposit/:token), where the customer picks their own extras and pays.
   *
   * Same shape as invoices.payToken: the page mints a fresh Stripe Checkout
   * Session per attempt, so the link outlives any single session and survives
   * the customer changing their mind about extras.
   *
   * Never returned by a list API — see stripPayToken in server/db.ts.
   */
  payToken: varchar("payToken", { length: 64 }),
  /** End of the deposit link's validity window (null = no link issued). */
  payTokenExpiresAt: timestamp("payTokenExpiresAt"),
  /**
   * The calendar slot this booking occupies, or NULL when it occupies none.
   *
   * MySQL has no partial unique indexes, but it does allow unlimited NULLs in a
   * unique one. So this resolves to "<date>T<time>" for the slot-holding
   * statuses and NULL for cancelled/expired, and a unique index over it means
   * exactly "at most one live booking per slot" — a real constraint rather than
   * a check the application has to remember to run.
   *
   * Generated by the database rather than maintained in application code, so it
   * can never go stale: it is recomputed on every write, including a plain
   * status change, and there is no code path that can forget to update it.
   */
  slotKey: varchar("slotKey", { length: 16 }).generatedAlwaysAs(
    sql`(case when \`status\` in ('cancelled','expired') then null else concat(\`scheduledDate\`, 'T', \`scheduledTime\`) end)`,
    { mode: "virtual" }
  ),
  /**
   * The connected property this booking was auto-created for (kind
   * "ical_auto"), or NULL for every hand- or self-made booking.
   */
  propertyId: int("propertyId"),
  /**
   * The reservation UID from the host's calendar feed. Idempotency lives
   * here: a re-poll finds the existing booking by (propertyId, icalUid)
   * instead of creating a twin, a date change moves that booking, and a
   * vanished UID cancels it. The unique index is the backstop for two syncs
   * racing — same philosophy as slotKey.
   */
  icalUid: varchar("icalUid", { length: 255 }),
  /**
   * The scheduled date the host was last told about for this turnover, or NULL
   * if they have not been told yet.
   *
   * This is what makes the scheduling notice deduped BY DATE rather than by a
   * boolean. An hourly sweep re-placing a turnover that could not find a slot
   * lands on the same date it already announced, so it stays quiet; a
   * reservation genuinely moving to a new checkout day is a different date, so
   * the host hears about it. A plain "notified" flag could not tell those two
   * apart, and would silence the reschedule — the one message the host most
   * needs.
   */
  turnoverNoticeDate: varchar("turnoverNoticeDate", { length: 10 }),
  repairNote: text("repairNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex(SLOT_UNIQUE_INDEX).on(table.slotKey),
  uniqueIndex("bookings_property_uid_unique").on(table.propertyId, table.icalUid),
]);
export type Booking = typeof bookings.$inferSelect;

// ---------- Dynamic add-on catalog ----------

export const addonCategories = mysqlTable("addon_categories", {
  id: int("id").autoincrement().primaryKey(),
  /** Immutable public/admin identity; labels may change, keys never do. */
  key: varchar("key", { length: 80 }).notNull().unique(),
  nameEn: varchar("nameEn", { length: 160 }).notNull(),
  nameEs: varchar("nameEs", { length: 160 }).notNull(),
  descriptionEn: text("descriptionEn"),
  descriptionEs: text("descriptionEs"),
  noteEn: text("noteEn"),
  noteEs: text("noteEs"),
  sortOrder: int("sortOrder").default(0).notNull(),
  isEnabled: boolean("isEnabled").default(true).notNull(),
  /** False for the migrated nine so their public presentation stays unchanged. */
  showPublicHeading: boolean("showPublicHeading").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type AddonCategory = typeof addonCategories.$inferSelect;

export const addons = mysqlTable("addons", {
  id: int("id").autoincrement().primaryKey(),
  categoryId: int("categoryId"),
  /** Immutable stable key used by clients and legacy-compatible booking JSON. */
  key: varchar("key", { length: 100 }).notNull().unique(),
  nameEn: varchar("nameEn", { length: 180 }).notNull(),
  nameEs: varchar("nameEs", { length: 180 }).notNull(),
  descriptionEn: text("descriptionEn"),
  descriptionEs: text("descriptionEs"),
  /** JSON string arrays; text keeps the schema portable across MySQL/TiDB. */
  includedItemsEn: text("includedItemsEn"),
  includedItemsEs: text("includedItemsEs"),
  noteEn: text("noteEn"),
  noteEs: text("noteEs"),
  priceMode: mysqlEnum("priceMode", ["fixed", "starting_at", "custom_quote"]).default("fixed").notNull(),
  /** The exact amount included in booking total and deposit for every mode. */
  startingPriceCents: int("startingPriceCents").notNull(),
  mayVary: boolean("mayVary").default(false).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  isEnabled: boolean("isEnabled").default(true).notNull(),
  /** Referenced records are removed by archiving, never hard-deleted. */
  archivedAt: timestamp("archivedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Addon = typeof addons.$inferSelect;

export const bookingAddons = mysqlTable(
  "booking_addons",
  {
    id: int("id").autoincrement().primaryKey(),
    bookingId: int("bookingId").notNull(),
    /** Nullable so a snapshot survives a later catalog archive or removal. */
    addonId: int("addonId"),
    addonKey: varchar("addonKey", { length: 100 }).notNull(),
    categoryKey: varchar("categoryKey", { length: 80 }),
    categoryNameEn: varchar("categoryNameEn", { length: 160 }),
    categoryNameEs: varchar("categoryNameEs", { length: 160 }),
    nameEn: varchar("nameEn", { length: 180 }).notNull(),
    nameEs: varchar("nameEs", { length: 180 }).notNull(),
    descriptionEn: text("descriptionEn"),
    descriptionEs: text("descriptionEs"),
    noteEn: text("noteEn"),
    noteEs: text("noteEs"),
    priceMode: mysqlEnum("priceMode", ["fixed", "starting_at", "custom_quote"]).default("fixed").notNull(),
    bookedPriceCents: int("bookedPriceCents").notNull(),
    mayVary: boolean("mayVary").default(false).notNull(),
    quantity: int("quantity").default(1).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("booking_addons_booking_key_unique").on(table.bookingId, table.addonKey)]
);
export type BookingAddon = typeof bookingAddons.$inferSelect;

/**
 * A recurring host's property, connected to its Airbnb/VRBO calendar feed.
 *
 * The feed is the booking interface: every reservation's checkout day becomes
 * a cleaning without anyone filling a form. The property stores what the
 * booking flow would otherwise ask — address, size, service — so the sync can
 * price and schedule from the live config unattended.
 */
export const connectedProperties = mysqlTable("connected_properties", {
  id: int("id").autoincrement().primaryKey(),
  customerId: int("customerId").notNull(),
  /** Owner-facing name, e.g. "Riverwalk condo" — the customer may have several. */
  label: varchar("label", { length: 120 }).notNull(),
  addressLine: varchar("addressLine", { length: 255 }).notNull(),
  unitNumber: varchar("unitNumber", { length: 20 }),
  propertyType: mysqlEnum("propertyType", ["house", "apartment"]).default("apartment").notNull(),
  city: varchar("city", { length: 100 }),
  zip: varchar("zip", { length: 20 }),
  /** Priced from this at sync time — required, unlike ordinary bookings. */
  sqft: int("sqft").notNull(),
  serviceType: mysqlEnum("serviceType", ["residential", "commercial", "airbnb", "moveinout", "deep", "office"])
    .default("airbnb")
    .notNull(),
  /** The per-listing iCal export URL from Airbnb/VRBO. */
  icalUrl: varchar("icalUrl", { length: 500 }).notNull(),
  /** Preferred cleaning start on checkout day, "HH:MM". */
  defaultTime: varchar("defaultTime", { length: 5 }).default("11:00").notNull(),
  /** Master switch: off = poll nothing, book nothing. */
  active: boolean("active").default(true).notNull(),
  /** Create bookings from reservations (off = sync visibility only). */
  autoBook: boolean("autoBook").default(true).notNull(),
  /**
   * Hosts running every turnover through us do NOT want an email per guest.
   * Off: one setup confirmation, then only the balance link per completed
   * clean. On: the per-clean notices (scheduled/started) too.
   */
  perCleanEmails: boolean("perCleanEmails").default(false).notNull(),
  lastSyncAt: timestamp("lastSyncAt"),
  /** "ok" or the failure message — what the admin list shows per feed. */
  lastSyncStatus: varchar("lastSyncStatus", { length: 500 }),
  /** Reservations found on the last successful poll. */
  reservationCount: int("reservationCount"),
  /**
   * Failed polls in a row. The owner is alerted when this crosses the
   * threshold, not on the first blip — feeds flake, hosts revoke.
   */
  consecutiveFailures: int("consecutiveFailures").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type ConnectedProperty = typeof connectedProperties.$inferSelect;

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
  /** Amount actually billed — the computed balance unless an admin adjusted it at approval. */
  amount: int("amount").notNull(),
  /** Exact amount for new invoices; null means read legacy `amount * 100`. */
  amountCents: int("amountCents"),
  /**
   * "awaiting_approval" = balance computed on job completion, waiting for an
   * admin to review (and possibly adjust) before anything is sent. Nothing is
   * emailed and no Stripe session exists until it leaves this state.
   */
  status: mysqlEnum("status", ["draft", "sent", "paid", "overdue", "void", "awaiting_approval"])
    .default("draft")
    .notNull(),
  dueDate: varchar("dueDate", { length: 10 }),
  paidAt: timestamp("paidAt"),
  /** Server-computed balance at completion, kept for audit when an admin adjusts the total. */
  computedAmount: int("computedAmount"),
  computedAmountCents: int("computedAmountCents"),
  /** When an admin approved the balance for sending. */
  approvedAt: timestamp("approvedAt"),
  /** users.id of the admin who approved it. */
  approvedByUserId: int("approvedByUserId"),
  /**
   * "balance" = auto-generated remaining-balance invoice with a payment link,
   * created when a booking is marked completed. "manual" = created by hand in
   * Admin → Invoices (the pre-existing behavior).
   */
  kind: mysqlEnum("kind", ["manual", "balance"]).default("manual").notNull(),
  /**
   * Secret token behind the emailed payment link (/api/pay/balance/:token).
   * The route mints a fresh Stripe Checkout Session on each visit, so the
   * customer-facing link stays valid for the whole linkExpiresAt window even
   * though a single Stripe session may live at most 24 hours.
   */
  payToken: varchar("payToken", { length: 64 }),
  /** Most recent Stripe Checkout Session minted for this invoice. */
  stripeSessionId: varchar("stripeSessionId", { length: 255 }),
  /** Payment intent that settled this invoice (or the one needing a refund). */
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  /** When the payment link was last emailed to the customer (null = never sent). */
  linkSentAt: timestamp("linkSentAt"),
  /** End of the payment link's validity window (7 days from send/resend). */
  linkExpiresAt: timestamp("linkExpiresAt"),
  /**
   * Itemized charges (JSON array of InvoiceLineItem): the add-ons and custom
   * lines billed on top of the base service, snapshotted with name and price
   * at approval time so later catalog edits cannot rewrite a sent invoice.
   * NULL = no items (every pre-feature invoice, and plain balances).
   */
  lineItems: text("lineItems"),
  /** How the invoice was settled — null for zero-balance invoices covered by the deposit. */
  paidVia: mysqlEnum("paidVia", ["stripe", "manual"]),
  /**
   * Automatic follow-ups sent for an unpaid balance link (0–2). The count is
   * the claim: each reminder's conditional UPDATE requires the expected count,
   * so overlapping cron runs can never double-send. Reset to 0 by a manual
   * resend, which restarts the whole sequence from its new linkSentAt.
   */
  reminderCount: int("reminderCount").default(0).notNull(),
  /** When the most recent automatic reminder went out (null = none yet). */
  lastReminderAt: timestamp("lastReminderAt"),
  /**
   * When the owner was told both reminders ran their course unpaid — the
   * "time for a personal follow-up" alert, claimed once. Reset by a resend.
   */
  reminderExhaustedAlertAt: timestamp("reminderExhaustedAlertAt"),
  /**
   * Set when a card payment landed on an invoice that was already settled
   * (collected in person, or paid twice). Manual payment always wins; this
   * flags the money that has to be refunded instead of double-marking paid.
   */
  refundNeeded: boolean("refundNeeded").default(false).notNull(),
  repairNote: text("repairNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type Invoice = typeof invoices.$inferSelect;

export const payments = mysqlTable("payments", {
  id: int("id").autoincrement().primaryKey(),
  bookingId: int("bookingId"),
  invoiceId: int("invoiceId"),
  customerId: int("customerId"),
  amount: int("amount").notNull(),
  /** Exact settled amount; null means read legacy `amount * 100`. */
  amountCents: int("amountCents"),
  kind: mysqlEnum("kind", ["deposit", "balance", "full", "refund", "tip"]).default("deposit").notNull(),
  method: varchar("method", { length: 40 }).default("card"),
  /** Explicit provenance: existing/default rows are Stripe; admin-entered rows are offline. */
  source: mysqlEnum("source", ["stripe", "offline"]).default("stripe").notNull(),
  /** Business-local date the offline money was actually received (YYYY-MM-DD). */
  receivedOn: varchar("receivedOn", { length: 10 }),
  /** Optional operator note for offline collections; never used as Stripe reconciliation data. */
  note: text("note"),
  /** users.id of the admin who recorded an offline payment. */
  recordedByUserId: int("recordedByUserId"),
  /** Audit timestamp for when the offline record was entered into the system. */
  recordedAt: timestamp("recordedAt"),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  status: mysqlEnum("status", ["pending", "succeeded", "failed", "refunded"]).default("pending").notNull(),
  repairNote: text("repairNote"),
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

export const blogPosts = mysqlTable("blog_posts", {
  id: int("id").autoincrement().primaryKey(),
  slug: varchar("slug", { length: 160 }).notNull().unique(),
  titleEn: varchar("titleEn", { length: 255 }).notNull(),
  titleEs: varchar("titleEs", { length: 255 }).notNull(),
  excerptEn: text("excerptEn"),
  excerptEs: text("excerptEs"),
  /** Markdown body (plain paragraphs also render fine). */
  bodyEn: text("bodyEn").notNull(),
  bodyEs: text("bodyEs").notNull(),
  coverImage: varchar("coverImage", { length: 500 }),
  readTime: int("readTime").default(5).notNull(),
  published: boolean("published").default(false).notNull(),
  /** Display date YYYY-MM-DD. */
  publishedAt: varchar("publishedAt", { length: 10 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type BlogPost = typeof blogPosts.$inferSelect;

/**
 * Every outbound email attempt, recorded whether it succeeded or not.
 *
 * Production console logs are retained for roughly an hour, which is useless
 * for answering "did the customer actually get it?" days later. This table is
 * the durable answer: one row per attempt, written on the same path that sends
 * the mail, so an absent row means no attempt was ever made.
 *
 * Deliberately does NOT store the message body. A support question needs to
 * know whether a message left the building and where it went — not to become a
 * second copy of every invoice, access code, and address the business sends.
 */
export const emailLog = mysqlTable("email_log", {
  id: int("id").autoincrement().primaryKey(),
  /** Recipient address; NULL only when a send was skipped for having none. */
  recipient: varchar("recipient", { length: 320 }),
  subject: varchar("subject", { length: 500 }).notNull(),
  /**
   * Which flow produced the message (balance_due, booking_confirmation,
   * reminder, staff_invite, ...). Free-form varchar rather than an enum on
   * purpose: new email types appear often, and a forgotten enum migration must
   * never be able to break an actual send.
   */
  emailType: varchar("emailType", { length: 60 }).default("other").notNull(),
  /**
   * delivered — the mail server accepted it
   * log_only  — no SMTP credentials configured, so the body was logged instead
   * error     — transport or auth failure; errorText holds what the server said
   * skipped   — there was no address to send to
   */
  outcome: mysqlEnum("outcome", ["delivered", "log_only", "error", "skipped"]).notNull(),
  /** The mail server's actual complaint, first line only, when it failed. */
  errorText: varchar("errorText", { length: 500 }),
  /** The mailbox the transport authenticated as — how a stale deploy gets spotted. */
  smtpUser: varchar("smtpUser", { length: 320 }),
  /** Related records, when the send belongs to one. */
  invoiceId: int("invoiceId"),
  bookingId: int("bookingId"),
  /**
   * True when this failure should have raised an owner alert but the hourly
   * cap swallowed it. The cap stops a dead mailbox producing one alert per
   * failed send; recording the suppression keeps the size of the outage
   * countable, which the cap would otherwise hide.
   */
  alertSuppressed: boolean("alertSuppressed").default(false).notNull(),
  /** Set on the failure that actually raised the owner alert — the audit trail. */
  alertSentAt: timestamp("alertSentAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type EmailLogEntry = typeof emailLog.$inferSelect;
