import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  DURATION_SETTING_KEY,
  serializeDurationConfig,
  validateDurationConfig,
  type DurationConfig,
} from "@shared/duration";
import {
  ADMIN_HOLD_SETTING_KEY,
  MAX_ADMIN_HOLD_HOURS,
  MIN_ADMIN_HOLD_HOURS,
  readAdminHoldHours,
} from "@shared/holdWindow";
import { LEAD_TIME_SETTING_KEY, MAX_LEAD_TIME_HOURS, readLeadTimeHours } from "@shared/leadTime";
import {
  PRICING_SETTING_KEY,
  serializePricingConfig,
  validatePricingConfig,
  type PricingConfig,
} from "@shared/pricing";
import { CLEANING_TYPES, FREQUENCIES } from "@shared/pricing";
import * as db from "../db";
import { createAdminBooking, generateDepositToken } from "../adminBooking";
import { depositLinkExpiresAt, depositLinkStatus, depositPayUrl } from "../depositLinkRules";
import { holdMinutesFor } from "../bookingRules";
import { syncConnectedProperty, validateIcalFeed } from "../icalSync";
import { isSlotBookable } from "@shared/availability";
import { durationHoursFor } from "@shared/duration";
import { todayInBookingZone } from "@shared/leadTime";
import { CUSTOM_ITEM_MAX, CUSTOM_ITEM_MIN } from "@shared/invoiceItems";
import { composeAddress, PROPERTY_TYPES } from "@shared/property";
import {
  approveBalanceInvoice,
  issueBalanceSafely,
  issueManualInvoice,
  originFromRequest,
  resendBalanceLink,
  sendPaymentReceiptSafely,
} from "../balance";
import { sendWeeklyDigest } from "../ownerDigest";
import { balanceLinkStatus } from "../balanceRules";
import {
  buildStaffInviteEmail,
  deliverEmail,
  sendDepositLinkEmail,
  sendPropertyConnectedEmail,
  sendSmtpDiagnostic,
  smtpDiagnostics,
  verifySmtpTransport,
} from "../emails";
import { loadDurationConfig, loadSchedulingRules, occupiedIntervals, SERVICE_NAMES, withDurationHours } from "./booking";
import { sendJobStartedEmailSafely } from "../statusEmails";
import { sendTipRequestEmailSafely } from "../tip";
import { storagePut } from "../storage";
import { getStripe } from "../stripe";
import { protectedProcedure, router } from "../_core/trpc";
import { addonCatalogAdminRouter } from "./addonCatalogAdmin";
import { loadAddonCatalog } from "../addonCatalog";

/** Admin-only procedure guard. */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

/** Validates a pricing config payload, throwing a readable BAD_REQUEST if it breaks the tier rules. */
function assertValidPricingConfig(raw: string): PricingConfig {
  const result = validatePricingConfig(raw);
  if (!result.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid pricing configuration — ${result.errors.join("; ")}` });
  }
  return result.config;
}

/**
 * Rejects a lead time the booking rules would not honour — asked of the same
 * reader the booking flow uses, so "saved" and "in force" can never differ. The
 * read path falls back to the default on anything invalid, so without this an
 * admin could save 100 hours and silently get 3.
 */
function assertValidLeadTimeHours(raw: string): void {
  if (readLeadTimeHours(raw) === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Minimum booking notice must be a whole number of hours between 0 and ${MAX_LEAD_TIME_HOURS}.`,
    });
  }
}

/**
 * Rejects a deposit hold the booking rules would not honour — asked of the same
 * reader the create path uses, so "saved" and "in force" can never differ.
 */
function assertValidAdminHoldHours(raw: string): void {
  if (readAdminHoldHours(raw) === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Deposit hold must be a whole number of hours between ${MIN_ADMIN_HOLD_HOURS} and ${MAX_ADMIN_HOLD_HOURS}.`,
    });
  }
}

/** Validates a duration config, throwing a readable BAD_REQUEST if a ladder breaks the rules. */
function assertValidDurationConfig(raw: string): DurationConfig {
  const result = validateDurationConfig(raw);
  if (!result.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid job durations — ${result.errors.join("; ")}` });
  }
  return result.config;
}

const bookingStatusEnum = z.enum(["pending_deposit", "confirmed", "in_progress", "completed", "cancelled", "expired"]);

export const adminRouter = router({
  addonCatalog: addonCatalogAdminRouter,
  // ---------- Dashboard & statistics ----------
  stats: adminProcedure.query(() => db.getDashboardStats()),
  monthlyRevenue: adminProcedure.query(() => db.getMonthlyRevenue()),
  bookingsByService: adminProcedure.query(() => db.getBookingsByService()),

  // ---------- Appointments ----------
  bookings: adminProcedure
    .input(z.object({ status: bookingStatusEnum.optional(), from: z.string().optional(), to: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const rows = await withDurationHours(await db.listBookings(input));
      const now = new Date();
      // The owner's Details panel needs who to call — name, phone, email,
      // language — so the customer rides along, fetched in one batch. Flat
      // fields rather than a nested object, so every existing consumer of
      // these rows keeps its shape.
      const customerIds = Array.from(new Set(rows.map(row => row.customerId)));
      const customerById = new Map(
        (await db.getCustomersByIds(customerIds)).map(customer => [customer.id, customer])
      );
      // Derived, never the token itself: db.listBookings strips payToken, and
      // the owner fetches the actual URL through depositLink below when they
      // ask for it. A list that carried the credential would put it in every
      // browser tab, every log, every screenshot of the appointments table.
      return rows.map(row => {
        const customer = customerById.get(row.customerId);
        return {
          ...row,
          depositLink: depositLinkStatus(row, now),
          customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
          customerPhone: customer?.phone ?? null,
          customerEmail: customer?.email ?? null,
          customerLocale: (customer?.preferredLocale as "en" | "es") ?? "en",
        };
      });
    }),

  /**
   * Fix a booking's contact info — the owner typo'd an email on a phone lead,
   * the link bounced, the customer is waiting. Editable at ANY status: none of
   * these fields bear on price or scheduling.
   *
   * The edit lands on the CUSTOMER record, not a per-booking copy: one person,
   * one identity. Their other bookings see the correction too, which is what
   * "fixing a typo" means — the alternative leaves the same wrong email
   * waiting to bounce the next balance link. The booking itself carries only
   * the language, which drives its emails and its pay page.
   */
  updateBookingContact: adminProcedure
    .input(
      z
        .object({
          bookingId: z.number().int(),
          firstName: z.string().min(1, "A first name is required").max(100),
          lastName: z.string().max(100).optional(),
          email: z.string().email("That email doesn't look right").max(320).optional().or(z.literal("")),
          phone: z
            .string()
            .regex(/^[\d\s()+.-]{7,40}$/, "That phone number doesn't look right")
            .optional()
            .or(z.literal("")),
          locale: z.enum(["en", "es"]),
        })
        .refine(input => (input.email ?? "").trim() !== "" || (input.phone ?? "").trim() !== "", {
          message: "Keep at least one way to reach them — an email or a phone number.",
        })
    )
    .mutation(async ({ input }) => {
      const booking = await db.getBookingById(input.bookingId);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      const customer = await db.getCustomerById(booking.customerId);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
      await db.updateCustomer(customer.id, {
        firstName: input.firstName.trim(),
        lastName: input.lastName?.trim() || customer.lastName,
        email: input.email?.trim() ? input.email.trim() : null,
        phone: input.phone?.trim() ? input.phone.trim() : null,
        preferredLocale: input.locale,
      });
      if (booking.locale !== input.locale) {
        await db.updateBooking(booking.id, { locale: input.locale });
      }
      return { success: true as const };
    }),

  /**
   * The deposit link for one admin-created booking, for the owner to copy into
   * a text message.
   *
   * A separate call rather than a field on the list: the token is a bearer
   * credential, and it should leave the server when the owner asks for that one
   * booking's link, not every time the appointments table renders.
   */
  depositLink: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const booking = await db.getBookingById(input.id);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      if (!booking.payToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This booking has no deposit link." });
      }
      return {
        url: depositPayUrl(originFromRequest(ctx.req), booking.payToken),
        status: depositLinkStatus(booking),
        expiresAt: booking.payTokenExpiresAt,
      };
    }),

  /**
   * Creates a booking the owner took by phone or text and issues its deposit
   * link.
   *
   * No extras in the input, and no prices: the customer picks their own extras
   * on the pay page, and every figure is computed server-side from the live
   * config. See server/adminBooking.ts.
   */
  createBooking: adminProcedure
    .input(
      z
        .object({
          // The hard floor: someone to greet and a way to reach them. A lead
          // typed with a thumb between calls is a first name and a number.
          firstName: z.string().min(1).max(100),
          lastName: z.string().max(100).optional(),
          email: z.string().email().max(320).optional(),
          phone: z.string().min(7).max(40).optional(),
          // Everything below is optional — whatever the owner locks here is
          // settled; whatever he leaves blank, the customer chooses on the
          // link. Note the continued absence of any price field.
          serviceType: z.enum(CLEANING_TYPES).optional(),
          frequency: z.enum(FREQUENCIES).default("onetime"),
          bedrooms: z.number().int().min(0).max(10).optional(),
          bathrooms: z.number().int().min(1).max(10).optional(),
          sqft: z.number().min(200).max(20000).optional(),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          time: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .optional(),
          address: z.string().min(1).max(255).optional(),
          /** House verifies against county records; apartment/condo never does. */
          propertyType: z.enum(PROPERTY_TYPES).default("house"),
          unitNumber: z.string().max(20).optional(),
          city: z.string().min(1).max(100).optional(),
          zip: z.string().min(3).max(20).optional(),
          notes: z.string().max(2000).optional(),
          locale: z.enum(["en", "es"]).default("en"),
          couponCode: z.string().max(40).optional(),
          overrideNotice: z.boolean().optional(),
          /** Owner's choice: email the link, or copy it for a text message. */
          sendEmail: z.boolean().default(true),
        })
        .refine(input => input.email || input.phone, {
          message: "Enter an email or a phone number — the link needs a way to reach them.",
        })
        .refine(input => Boolean(input.date) === Boolean(input.time), {
          message: "A held time needs both a date and a time — or leave both blank and let them pick.",
        })
    )
    .mutation(async ({ ctx, input }) => {
      const origin = originFromRequest(ctx.req);
      const result = await createAdminBooking(input, origin);

      let emailSent = false;
      if (input.sendEmail && input.email) {
        const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
        // Best-effort, like every other transactional send: the booking exists
        // and holds its slot whether or not the mail server cooperates, and the
        // owner still has the link to paste into a text.
        try {
          emailSent = await sendDepositLinkEmail({
            reference: result.reference,
            serviceName: input.serviceType ? SERVICE_NAMES[input.serviceType][input.locale] : undefined,
            date: input.date,
            time: input.time,
            customerName: input.firstName,
            customerEmail: input.email,
            address:
              composeAddress({
                addressLine: input.address,
                unitNumber: input.unitNumber,
                city: input.city,
                zip: input.zip,
              }) || undefined,
            basePrice: result.basePrice,
            deposit: result.depositEstimate,
            payUrl: result.payUrl,
            expiresOn: result.expiresAt.toISOString().slice(0, 10),
            locale: input.locale,
            bizPhone,
          });
        } catch (error) {
          console.error("[AdminBooking] Deposit link email failed:", error);
        }
      }

      return {
        bookingId: result.bookingId,
        reference: result.reference,
        payUrl: result.payUrl,
        basePrice: result.basePrice,
        deposit: result.depositEstimate,
        expiresAt: result.expiresAt,
        sqft: result.sqft,
        sqftCorrected: result.sqftCorrected,
        customerWillChoose: result.customerWillChoose,
        emailSent,
      };
    }),

  /**
   * Re-sends the deposit link, renewing its window.
   *
   * Renewing rather than reusing the old expiry: the reason to resend is almost
   * always that the customer let it lapse, and a link that arrives already dead
   * is worse than no link. The hold window the booking pinned at creation is
   * what it renews for, and the slot has to still be free — the row still holds
   * it unless something else took it after release.
   */
  resendDepositLink: adminProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const booking = await db.getBookingById(input.id);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      if (booking.kind !== "admin") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only phone bookings have a deposit link." });
      }
      if (booking.status !== "pending_deposit") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This booking is no longer awaiting a deposit.",
        });
      }
      const customer = await db.getCustomerById(booking.customerId);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });

      // A fresh token as well as a fresh window, so a link the customer
      // forwarded to someone else stops working when it is replaced.
      const payToken = generateDepositToken();
      const now = new Date();
      const window = holdMinutesFor(booking);
      const expiresAt = depositLinkExpiresAt(now, window);

      // The slot hold has to move with the link, not just the token's own
      // expiry. blocksSlot measures from createdAt, which a resend cannot
      // change, so the window is restated as the minutes from creation to the
      // new expiry. Without this the email promises to hold a time the
      // scheduler has already put back on the calendar.
      const createdAt = booking.createdAt ? new Date(booking.createdAt).getTime() : now.getTime();
      const holdMinutes = Math.max(
        window,
        Math.ceil((expiresAt.getTime() - createdAt) / 60_000)
      );
      await db.updateBooking(booking.id, { payToken, payTokenExpiresAt: expiresAt, holdMinutes });

      const origin = originFromRequest(ctx.req);
      const payUrl = depositPayUrl(origin, payToken);
      const locale = (booking.locale as "en" | "es") ?? "en";
      const bizPhone = (await db.getSetting("business_phone"))?.trim() || undefined;
      let emailSent = false;
      try {
        emailSent = await sendDepositLinkEmail({
          reference: booking.reference,
          serviceName: booking.serviceType ? SERVICE_NAMES[booking.serviceType][locale] : undefined,
          date: booking.scheduledDate ?? undefined,
          time: booking.scheduledTime ?? undefined,
          customerName: customer.firstName,
          customerEmail: customer.email ?? "",
          address: composeAddress(booking) || undefined,
          // Zero is the unpriceable sentinel, never a price to promise.
          basePrice: booking.totalAmount > 0 ? booking.totalAmount : null,
          deposit: booking.totalAmount > 0 ? booking.depositAmount : null,
          payUrl,
          expiresOn: expiresAt.toISOString().slice(0, 10),
          locale,
          bizPhone,
        });
      } catch (error) {
        console.error("[AdminBooking] Deposit link resend failed:", error);
      }
      return { payUrl, expiresAt, emailSent };
    }),
  updateBookingStatus: adminProcedure
    .input(z.object({ id: z.number().int(), status: bookingStatusEnum }))
    .mutation(async ({ ctx, input }) => {
      // Read first: only an actual confirmed → in progress move is a job
      // starting, and that is what the customer gets told about.
      const before = await db.getBookingById(input.id);
      // A booking whose customer hasn't picked a time yet isn't schedulable:
      // confirming it would put a job with no hours on the calendar, and the
      // crew nowhere. Cancelling is fine — that's how a dead lead is retired.
      if (
        before &&
        (before.scheduledDate == null || before.scheduledTime == null) &&
        (input.status === "confirmed" || input.status === "in_progress" || input.status === "completed")
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This booking has no time yet — the customer picks one on their link before it can be confirmed.",
        });
      }
      try {
        await db.updateBooking(input.id, { status: input.status });
      } catch (error) {
        // Reviving a cancelled or expired booking makes it hold its slot again,
        // which the unique index refuses if someone else has since taken it.
        // Say so plainly rather than surfacing a database error.
        if (db.isSlotTakenError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Another booking already holds that date and time. Reschedule one of them first.",
          });
        }
        throw error;
      }
      // Completing a job files its remaining balance for admin approval —
      // nothing reaches the customer until it is reviewed. Best-effort: never
      // fails the status update.
      if (input.status === "completed") {
        await issueBalanceSafely(input.id, originFromRequest(ctx.req));
      }
      // Same best-effort contract: an email failure never fails the status
      // change, and the send is claimed so it happens at most once per booking.
      if (input.status === "in_progress" && before?.status === "confirmed") {
        await sendJobStartedEmailSafely(input.id);
      }
      return { success: true } as const;
    }),
  assignEmployee: adminProcedure
    .input(z.object({ bookingId: z.number().int(), employeeId: z.number().int().nullable() }))
    .mutation(async ({ input }) => {
      await db.updateBooking(input.bookingId, { employeeId: input.employeeId });
      return { success: true } as const;
    }),

  // ---------- Connected properties (Airbnb auto-booking) ----------
  properties: adminProcedure.query(async () => {
    const rows = await db.listConnectedProperties();
    const today = todayInBookingZone();
    // The card shows what the owner actually checks: is it syncing, and what
    // is coming up. Fetched per property — the fleet is a handful of rows.
    return Promise.all(
      rows.map(async ({ property, customer }) => ({
        ...property,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
        upcoming: await db.listUpcomingAutoBookings(property.id, today),
      }))
    );
  }),

  createProperty: adminProcedure
    .input(
      z.object({
        customerId: z.number().int(),
        label: z.string().min(1).max(120),
        addressLine: z.string().min(3).max(255),
        unitNumber: z.string().max(20).optional(),
        propertyType: z.enum(PROPERTY_TYPES).default("apartment"),
        city: z.string().max(100).optional(),
        zip: z.string().max(20).optional(),
        sqft: z.number().int().min(200).max(20000),
        serviceType: z.enum(CLEANING_TYPES).default("airbnb"),
        icalUrl: z.string().url().max(500),
        defaultTime: z.string().regex(/^\d{2}:\d{2}$/).default("11:00"),
        autoBook: z.boolean().default(true),
        perCleanEmails: z.boolean().default(false),
        active: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const customer = await db.getCustomerById(input.customerId);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
      // Validate the feed at save time: a typo'd or revoked URL should bounce
      // here with a readable message, not fail silently every hour.
      let feed: { reservationCount: number; eventCount: number };
      try {
        feed = await validateIcalFeed(input.icalUrl);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not read the calendar feed.",
        });
      }
      const id = await db.createConnectedProperty({
        ...input,
        lastSyncAt: new Date(),
        lastSyncStatus: "ok",
        reservationCount: feed.reservationCount,
      });
      // The one setup email — after this, the host hears from us per clean
      // only through the balance link (or per-clean notices if they opted in).
      let emailSent = false;
      if (customer.email) {
        const locale = (customer.preferredLocale as "en" | "es") ?? "en";
        emailSent = await sendPropertyConnectedEmail({
          label: input.label,
          address: composeAddress(input),
          customerName: customer.firstName,
          customerEmail: customer.email,
          serviceName: SERVICE_NAMES[input.serviceType][locale],
          defaultTime: input.defaultTime,
          reservationCount: feed.reservationCount,
          locale,
          bizPhone: (await db.getSetting("business_phone"))?.trim() || undefined,
        });
      }
      return { id, reservationsFound: feed.reservationCount, eventsFound: feed.eventCount, emailSent };
    }),

  updateProperty: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        label: z.string().min(1).max(120).optional(),
        addressLine: z.string().min(3).max(255).optional(),
        unitNumber: z.string().max(20).nullable().optional(),
        propertyType: z.enum(PROPERTY_TYPES).optional(),
        city: z.string().max(100).optional(),
        zip: z.string().max(20).optional(),
        sqft: z.number().int().min(200).max(20000).optional(),
        serviceType: z.enum(CLEANING_TYPES).optional(),
        icalUrl: z.string().url().max(500).optional(),
        defaultTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        autoBook: z.boolean().optional(),
        perCleanEmails: z.boolean().optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const property = await db.getConnectedPropertyById(id);
      if (!property) throw new TRPCError({ code: "NOT_FOUND", message: "Property not found" });
      let reservationsFound: number | undefined;
      if (patch.icalUrl && patch.icalUrl !== property.icalUrl) {
        try {
          const feed = await validateIcalFeed(patch.icalUrl);
          reservationsFound = feed.reservationCount;
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Could not read the calendar feed.",
          });
        }
      }
      await db.updateConnectedProperty(id, {
        ...patch,
        ...(reservationsFound !== undefined
          ? { reservationCount: reservationsFound, consecutiveFailures: 0, lastSyncStatus: "ok", lastSyncAt: new Date() }
          : {}),
      });
      return { success: true as const, reservationsFound };
    }),

  /** Manual "Sync now" — the same reconcile the hourly cron runs. */
  syncProperty: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    const property = await db.getConnectedPropertyById(input.id);
    if (!property) throw new TRPCError({ code: "NOT_FOUND", message: "Property not found" });
    return syncConnectedProperty(property);
  }),

  /**
   * Place (or move) an auto-booked turnover by hand — the [ACTION NEEDED]
   * path when no slot fit automatically. Restricted to ical_auto bookings:
   * link bookings are the customer's to schedule, through their own page.
   *
   * Lead time is exempt (operational placement, same as the sync itself);
   * every physical rule applies, and the unique index backstops the race.
   */
  scheduleBooking: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
      })
    )
    .mutation(async ({ input }) => {
      const booking = await db.getBookingById(input.id);
      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      if (booking.kind !== "ical_auto") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only auto-booked turnovers are scheduled here — link bookings are the customer's to place.",
        });
      }
      if (booking.status !== "confirmed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only a confirmed booking can be scheduled." });
      }
      const { schedule, lunchBreak, durations } = await loadSchedulingRules();
      const jobHours =
        booking.estimatedHours ?? durationHoursFor(booking.serviceType, booking.sqft, durations);
      const rows = (await db.getOccupiedBookings(input.date)).filter(row => row.id !== booking.id);
      const bookable = isSlotBookable(
        {
          date: input.date,
          schedule,
          lunchBreak,
          leadTimeHours: 0,
          occupied: occupiedIntervals(rows, durations),
          jobHours,
        },
        input.time
      );
      if (!bookable) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That time doesn't fit — the hours, the lunch break, or another booking rules it out.",
        });
      }
      try {
        await db.updateBooking(booking.id, {
          scheduledDate: input.date,
          scheduledTime: input.time,
          estimatedHours: jobHours,
        });
      } catch (error) {
        if (db.isSlotTakenError(error)) {
          throw new TRPCError({ code: "CONFLICT", message: "Another booking just took that time — pick another." });
        }
        throw error;
      }
      return { success: true as const };
    }),

  // ---------- Customers ----------
  customers: adminProcedure.input(z.object({ search: z.string().optional() }).optional()).query(({ input }) => db.listCustomers(input?.search)),
  customerDetail: adminProcedure.input(z.object({ id: z.number().int() })).query(async ({ input }) => {
    const customer = await db.getCustomerById(input.id);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND" });
    const customerBookings = await db.listBookingsForCustomer(input.id);
    return { customer, bookings: customerBookings };
  }),
  updateCustomer: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        firstName: z.string().min(1).max(100).optional(),
        lastName: z.string().min(1).max(100).optional(),
        phone: z.string().max(40).optional(),
        notes: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await db.updateCustomer(id, data);
      return { success: true } as const;
    }),

  // ---------- Contact messages ----------
  messages: adminProcedure.query(() => db.listContactMessages()),
  updateMessageStatus: adminProcedure
    .input(z.object({ id: z.number().int(), status: z.enum(["new", "replied", "archived"]) }))
    .mutation(async ({ input }) => {
      await db.updateContactMessage(input.id, input.status);
      return { success: true } as const;
    }),

  // ---------- Employees ----------
  employees: adminProcedure.query(() => db.listEmployees()),
  createEmployee: adminProcedure
    .input(
      z.object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email().max(320).optional(),
        phone: z.string().max(40).optional(),
        role: z.string().max(100).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const id = await db.createEmployee(input);
      return { id };
    }),
  updateEmployee: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        firstName: z.string().min(1).max(100).optional(),
        lastName: z.string().min(1).max(100).optional(),
        email: z.string().email().max(320).optional(),
        phone: z.string().max(40).optional(),
        role: z.string().max(100).optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await db.updateEmployee(id, data);
      return { success: true } as const;
    }),
  deleteEmployee: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await db.deleteEmployee(input.id);
    return { success: true } as const;
  }),
  /** Auth users list for the staff-access linking UI. */
  listUsers: adminProcedure.query(() => db.listAllUsers()),
  /**
   * Generates (or regenerates) a secure staff-dashboard invite for an employee
   * and emails it to them when they have an email on file. Returns the invite URL.
   */
  sendStaffInvite: adminProcedure
    .input(z.object({ employeeId: z.number().int(), origin: z.string().url().max(500) }))
    .mutation(async ({ input }) => {
      const employee = (await db.listEmployees()).find((e) => e.id === input.employeeId);
      if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "Employee not found" });
      if (employee.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "This team member is already connected" });
      const token = randomBytes(24).toString("hex");
      await db.updateEmployee(input.employeeId, { inviteToken: token, inviteSentAt: new Date(), inviteAcceptedAt: null });
      const inviteUrl = `${new URL(input.origin).origin}/staff/join/${token}`;
      let emailed = false;
      if (employee.email) {
        const invite = buildStaffInviteEmail(employee.firstName, inviteUrl);
        emailed = await deliverEmail(employee.email, invite.subject, invite.body);
      }
      return { inviteUrl, emailed } as const;
    }),
  /** Revokes a pending staff invite so the link stops working. */
  revokeStaffInvite: adminProcedure
    .input(z.object({ employeeId: z.number().int() }))
    .mutation(async ({ input }) => {
      await db.updateEmployee(input.employeeId, { inviteToken: null, inviteSentAt: null });
      return { success: true } as const;
    }),
  /**
   * Grant dashboard access: links an employee record to a signed-in user account
   * and sets that user's access level ("staff" or "admin"), or revokes access
   * when unlinking. Safety guards prevent removing the last remaining admin
   * and prevent an admin from demoting their own account.
   */
  linkEmployeeUser: adminProcedure
    .input(
      z.object({
        employeeId: z.number().int(),
        userId: z.number().int().nullable(),
        accessLevel: z.enum(["staff", "admin"]).default("staff"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = (await db.listEmployees()).find((e) => e.id === input.employeeId);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Employee not found" });
      const allUsers = await db.listAllUsers();
      const adminCount = allUsers.filter((u) => u.role === "admin").length;

      /** Throws if demoting this user would leave the site without any admin, or demotes yourself. */
      const guardDemotion = (userId: number) => {
        const u = allUsers.find((x) => x.id === userId);
        if (!u || u.role !== "admin") return;
        if (u.id === ctx.user.id)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You can't remove your own admin access. Ask another admin to change your role.",
          });
        if (adminCount <= 1)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This is the only admin account. Promote someone else to admin first.",
          });
      };

      // If unlinking or relinking, the previously linked user loses their elevated role.
      if (existing.userId && existing.userId !== input.userId) {
        const prev = allUsers.find((u) => u.id === existing.userId);
        if (prev && prev.role !== "user") {
          guardDemotion(prev.id);
          await db.setUserRole(prev.id, "user");
        }
      }
      // If keeping the same linked user but lowering admin → staff, apply the same guards.
      if (input.userId && existing.userId === input.userId && input.accessLevel === "staff") {
        guardDemotion(input.userId);
      }
      await db.updateEmployee(input.employeeId, { userId: input.userId });
      if (input.userId) {
        const target = allUsers.find((u) => u.id === input.userId);
        if (target && target.role !== input.accessLevel) await db.setUserRole(target.id, input.accessLevel);
      }
      return { success: true } as const;
    }),

  // ---------- Invoices ----------
  /** Invoice list with the payment-link state resolved server-side (the secret token is never exposed). */
  invoices: adminProcedure.query(async () => {
    const rows = await db.listInvoices();
    const now = new Date();
    return rows.map(({ payToken, ...invoice }) => ({
      ...invoice,
      linkStatus: balanceLinkStatus({ status: invoice.status, payToken, linkExpiresAt: invoice.linkExpiresAt }, now),
    }));
  }),

  // ---------- Email log ----------
  /**
   * Recent outbound email attempts, newest first.
   *
   * Production console logs are kept for about an hour; this reads the durable
   * table instead, so "did the customer get it?" stays answerable days later.
   */
  emailLog: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      return db.listEmailLog(input?.limit ?? 50);
    }),
  /**
   * Sends the weekly report immediately, rather than waiting for Monday.
   * Useful for seeing the current state on demand, and for confirming after a
   * deploy that the reporting path still works end to end.
   */
  sendWeeklyDigestNow: adminProcedure.mutation(async () => {
    const data = await sendWeeklyDigest();
    return {
      sent: true,
      emailsThisWeek: data.totalSent,
      failures: data.failures.length,
      upcomingNudges: data.nudges.length,
      problems: data.health.paidOnOpenBookings.length + data.health.deadLinks.length,
    };
  }),
  /** Admin-only incident diagnostics. Never exposes a password or secret. */
  smtpDiagnostics: adminProcedure.query(async () => {
    const verify = await verifySmtpTransport();
    return { config: smtpDiagnostics(), verify };
  }),
  sendSmtpDiagnostic: adminProcedure
    .input(z.object({ to: z.string().email() }))
    .mutation(async ({ input }) => sendSmtpDiagnostic(input.to)),
  createInvoice: adminProcedure
    .input(
      z.object({
        customerId: z.number().int(),
        amount: z.number().min(1).multipleOf(0.01),
        dueDate: z.string().optional(),
        /**
         * Same itemization the approval flow takes, deliberately the same
         * shape: ids only for catalog add-ons (the server prices them from the
         * live catalog, so a stale client cannot dictate dollars), and named
         * one-off lines. Omitted means an un-itemized invoice, which is the
         * pre-existing behaviour and stays valid.
         */
        addonIds: z
          .array(z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$|^[A-Za-z][A-Za-z0-9]*$/))
          .max(20)
          .optional(),
        customItems: z
          .array(
            z.object({
              name: z
                .string()
                .trim()
                .min(1, "Every custom line item needs a name — that's the point.")
                .max(120),
              amount: z
                .number()
                .int("Whole dollars only")
                .min(CUSTOM_ITEM_MIN, "A line item must charge at least $1.")
                .max(CUSTOM_ITEM_MAX, `A single line item tops out at $${CUSTOM_ITEM_MAX.toLocaleString()}.`),
            })
          )
          .max(10)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The whole lifecycle lives in balance.ts, shared with the approval
      // flow: itemization is resolved and snapshotted there, a pay token is
      // minted, the Stripe session is built by the same builder, and the same
      // branded email goes out on the same transport.
      const result = await issueManualInvoice({
        customerId: input.customerId,
        amount: input.amount,
        dueDate: input.dueDate,
        addonIds: input.addonIds,
        customItems: input.customItems,
        origin: originFromRequest(ctx.req),
      });
      switch (result.outcome) {
        case "customer_not_found":
          throw new TRPCError({ code: "NOT_FOUND", message: "That customer no longer exists." });
        case "customer_has_no_email":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "This customer has no email address on file, so there is nowhere to send the payment link. Add one on their profile first.",
          });
        default:
          return {
            id: result.invoiceId,
            number: result.number,
            amount: result.amount,
            emailed: result.emailed,
            expiresOn: result.expiresOn,
            emailError: result.emailError,
          };
      }
    }),
  updateInvoiceStatus: adminProcedure
    .input(z.object({ id: z.number().int(), status: z.enum(["draft", "sent", "paid", "overdue", "void"]) }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await db.getInvoiceById(input.id);
      await db.updateInvoice(input.id, {
        status: input.status,
        paidAt: input.status === "paid" ? new Date() : undefined,
        // Record how it was settled: a card payment landing after an in-person
        // collection is then treated as a duplicate to refund rather than
        // double-marking the invoice paid.
        paidVia: input.status === "paid" && invoice?.paidVia !== "stripe" ? "manual" : undefined,
      });
      // Best-effort: close the outstanding checkout so the emailed link can't
      // take a second payment. The refund-needed guard covers it either way.
      // Applies to manual invoices too now that they carry live payment links.
      if (input.status === "paid" && invoice?.stripeSessionId) {
        try {
          await getStripe().checkout.sessions.expire(invoice.stripeSessionId);
        } catch (error) {
          console.warn(`[Balance] Could not expire session for invoice ${input.id}:`, error);
        }
      }
      // Marking a balance paid by hand (collected in person, say) settles the
      // customer — the thank-you with the tip ask goes out now, claimed once.
      // Balance only: a manual invoice has no finished job to tip a crew for.
      //
      // The receipt goes first, and unlike the tip it covers BOTH kinds: cash
      // in hand is still a payment the customer deserves proof of. Only a
      // genuine transition into `paid` sends one, so re-saving an already-paid
      // invoice does not receipt it twice.
      if (input.status === "paid" && invoice && invoice.status !== "paid") {
        await sendPaymentReceiptSafely(
          { ...invoice, paidAt: new Date() },
          invoice.paidVia === "stripe" ? "card" : "manual"
        );
      }
      if (input.status === "paid" && invoice?.kind === "balance" && invoice.bookingId) {
        await sendTipRequestEmailSafely(invoice.bookingId, originFromRequest(ctx.req));
      }
      return { success: true } as const;
    }),
  /**
   * Balance invoices waiting on review, with the booking/customer context the
   * approval dialog and the nav badge need.
   */
  awaitingApprovalInvoices: adminProcedure.query(async () => {
    const pending = await db.listInvoicesAwaitingApproval();
    const catalogEnabled = (await loadAddonCatalog(false)).enabled;
    return Promise.all(
      pending.map(async ({ payToken: _payToken, ...invoice }) => {
        const booking = invoice.bookingId ? await db.getBookingById(invoice.bookingId) : undefined;
        const customer = await db.getCustomerById(invoice.customerId);
        const bookedAddons = catalogEnabled && booking ? await db.listBookingAddonsByBooking(booking.id) : [];
        return {
          ...invoice,
          bookingReference: booking?.reference ?? null,
          serviceType: booking?.serviceType ?? null,
          serviceDate: booking?.scheduledDate ?? null,
          // What the customer asked for, in front of whoever approves the bill.
          bookingNotes: booking?.notes ?? null,
          bookingTotal: booking?.totalAmount ?? null,
          // Only a captured deposit is credited against the balance.
          depositCredited: booking?.stripePaymentIntentId ? (booking?.depositAmount ?? 0) : 0,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
          customerEmail: customer?.email ?? null,
          bookedAddons: bookedAddons.map(item => ({
            key: item.addonKey,
            nameEn: item.nameEn,
            nameEs: item.nameEs,
            amountCents: item.bookedPriceCents,
            priceMode: item.priceMode,
          })),
        };
      })
    );
  }),
  /**
   * Approves a pending balance and bills the customer. Admin-only (staff may
   * complete jobs but never approve), and the amount is re-derived server-side
   * from this input rather than trusted from the invoice the client rendered.
   */
  approveBalanceInvoice: adminProcedure
    .input(
      z.object({
        invoiceId: z.number().int(),
        /** Optional corrected total; omitted means bill the computed balance. */
        adjustedAmount: z.number().min(0).max(100000).multipleOf(0.01).optional(),
        /** Catalog add-ons picked on-site — ids only; the server prices them. */
        addonIds: z
          .array(z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$|^[A-Za-z][A-Za-z0-9]*$/))
          .max(20)
          .optional(),
        /**
         * One-off charges. The name is REQUIRED non-empty: an unlabeled
         * amount is the mystery total this feature exists to kill.
         */
        customItems: z
          .array(
            z.object({
              name: z
                .string()
                .trim()
                .min(1, "Every custom line item needs a name — that's the point.")
                .max(120),
              amount: z
                .number()
                .int("Whole dollars only")
                .min(CUSTOM_ITEM_MIN, "A line item must charge at least $1.")
                .max(CUSTOM_ITEM_MAX, `A single line item tops out at $${CUSTOM_ITEM_MAX.toLocaleString()}.`),
            })
          )
          .max(10)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await approveBalanceInvoice({
        invoiceId: input.invoiceId,
        adjustedAmount: input.adjustedAmount,
        addonIds: input.addonIds,
        customItems: input.customItems,
        approvedByUserId: ctx.user.id,
        origin: originFromRequest(ctx.req),
      });
      switch (result.outcome) {
        case "approved":
          return { sent: true as const, amount: result.amount, emailed: result.emailed, expiresOn: result.expiresOn };
        case "settled_without_link":
          return { sent: false as const, amount: 0, emailed: false, expiresOn: null };
        case "not_awaiting_approval":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `This invoice is no longer awaiting approval (it is ${result.status.replace(/_/g, " ")}).`,
          });
        case "not_a_balance_invoice":
          throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice has no balance to approve." });
        case "booking_not_found":
        case "customer_not_found":
          throw new TRPCError({ code: "NOT_FOUND", message: "The booking for this invoice is no longer available." });
        default:
          throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }
    }),
  /**
   * Re-sends a balance payment link (expired, or just never acted on),
   * reopening the 7-day window from now.
   */
  resendBalanceLink: adminProcedure
    .input(z.object({ invoiceId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const result = await resendBalanceLink(input.invoiceId, originFromRequest(ctx.req));
      switch (result.outcome) {
        case "resent":
          return { emailed: result.emailed, expiresOn: result.expiresOn, emailError: result.emailError } as const;
        case "already_paid":
          throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is already paid." });
        case "voided":
          throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice was voided." });
        case "awaiting_approval":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Approve this balance first — nothing has been sent to the customer yet.",
          });
        case "not_a_balance_invoice":
          throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice has no payment link to resend." });
        case "customer_not_found":
        case "booking_not_found":
          throw new TRPCError({ code: "NOT_FOUND", message: "The booking for this invoice is no longer available." });
        default:
          throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }
    }),

  // ---------- Payments ----------
  payments: adminProcedure.query(() => db.listPayments()),

  // ---------- Reviews ----------
  reviews: adminProcedure.query(() => db.listReviews()),
  updateReview: adminProcedure
    .input(z.object({ id: z.number().int(), approved: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.updateReview(input.id, { approved: input.approved });
      return { success: true } as const;
    }),
  deleteReview: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await db.deleteReview(input.id);
    return { success: true } as const;
  }),

  // ---------- Gallery ----------
  gallery: adminProcedure.query(() => db.listGalleryItems()),
  createGalleryItem: adminProcedure
    .input(
      z.object({
        // Accepts absolute URLs and relative storage paths (e.g. /manus-storage/...)
        url: z
          .string()
          .min(1)
          .max(500)
          .refine((v) => /^https?:\/\//i.test(v) || v.startsWith("/"), "Must be a URL or a storage path"),
        altEn: z.string().max(255).optional(),
        altEs: z.string().max(255).optional(),
        category: z.enum(["residential", "commercial", "airbnb", "deep"]),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const id = await db.createGalleryItem(input);
      return { id };
    }),
  updateGalleryItem: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        altEn: z.string().max(255).optional(),
        altEs: z.string().max(255).optional(),
        category: z.enum(["residential", "commercial", "airbnb", "deep"]).optional(),
        sortOrder: z.number().int().optional(),
        visible: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await db.updateGalleryItem(id, data);
      return { success: true } as const;
    }),
  deleteGalleryItem: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await db.deleteGalleryItem(input.id);
    return { success: true } as const;
  }),

  // ---------- Coupons ----------
  coupons: adminProcedure.query(() => db.listCoupons()),
  createCoupon: adminProcedure
    .input(
      z.object({
        code: z.string().min(2).max(40),
        description: z.string().max(255).optional(),
        percentOff: z.number().int().min(1).max(100).optional(),
        amountOff: z.number().int().min(1).optional(),
        maxRedemptions: z.number().int().min(1).optional(),
        expiresAt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const id = await db.createCoupon({ ...input, code: input.code.trim().toUpperCase() });
      return { id };
    }),
  updateCoupon: adminProcedure
    .input(z.object({ id: z.number().int(), active: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.updateCoupon(input.id, { active: input.active });
      return { success: true } as const;
    }),
  deleteCoupon: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await db.deleteCoupon(input.id);
    return { success: true } as const;
  }),

  // ---------- Settings ----------
  settings: adminProcedure.query(() => db.listSettings()),
  saveSetting: adminProcedure
    .input(z.object({ key: z.string().min(1).max(100), value: z.string().max(10000) }))
    .mutation(async ({ input }) => {
      // Pricing has structural rules the quote engine depends on. Validate here
      // too so the generic settings endpoint can't be used to store a config
      // that would silently fall back to defaults on read.
      if (input.key === PRICING_SETTING_KEY) {
        assertValidPricingConfig(input.value);
      }
      if (input.key === LEAD_TIME_SETTING_KEY) {
        assertValidLeadTimeHours(input.value);
      }
      if (input.key === DURATION_SETTING_KEY) {
        assertValidDurationConfig(input.value);
      }
      if (input.key === ADMIN_HOLD_SETTING_KEY) {
        assertValidAdminHoldHours(input.value);
      }
      await db.setSetting(input.key, input.value);
      return { success: true } as const;
    }),
  /**
   * Saves the pricing configuration (tier ladders, extras, discounts, deposit).
   * Server-authoritative: the tier rules are re-checked here, never trusted
   * from the client, and an invalid ladder is rejected with the exact problems.
   */
  savePricingConfig: adminProcedure
    .input(z.object({ config: z.string().min(2).max(10000) }))
    .mutation(async ({ input }) => {
      const config = assertValidPricingConfig(input.config);
      // Re-serialize from the validated result so only clean, normalized JSON
      // ever reaches the database.
      await db.setSetting(PRICING_SETTING_KEY, serializePricingConfig(config));
      return { success: true } as const;
    }),
  /**
   * Saves the job-duration ladders that decide how much of the calendar each
   * booking blocks. Server-authoritative in the same way as pricing: the ladder
   * rules are re-checked here and an invalid one is rejected with the exact
   * problems, never silently ignored.
   *
   * Its own setting key rather than a section of pricing_config, so a pricing
   * save from a stale editor cannot revert a duration change (and vice versa).
   */
  saveDurationConfig: adminProcedure
    .input(z.object({ config: z.string().min(2).max(10000) }))
    .mutation(async ({ input }) => {
      const config = assertValidDurationConfig(input.config);
      await db.setSetting(DURATION_SETTING_KEY, serializeDurationConfig(config));
      return { success: true } as const;
    }),
  /** Live job-duration ladders for the admin editor. */
  durationConfig: adminProcedure.query(() => loadDurationConfig()),

  // ---------- Blog ----------
  blogPosts: adminProcedure.query(() => db.listBlogPosts()),
  /** Uploads a blog cover image (base64) to S3 storage and returns its public URL. */
  uploadBlogCover: adminProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(200),
        mimeType: z
          .string()
          .regex(/^image\/(png|jpe?g|webp|gif|avif)$/i, "Only PNG, JPEG, WebP, GIF, or AVIF images are allowed"),
        // ~5MB binary ≈ 6.8M base64 chars
        dataBase64: z.string().min(1).max(7_000_000),
      })
    )
    .mutation(async ({ input }) => {
      const buf = Buffer.from(input.dataBase64, "base64");
      if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file" });
      if (buf.length > 5 * 1024 * 1024)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must be 5MB or smaller" });
      // Sanitize the file name; storagePut appends a unique hash suffix itself.
      const safeName =
        input.fileName
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "")
          .slice(-80) || "cover.jpg";
      const { url } = await storagePut(`blog-covers/${safeName}`, buf, input.mimeType);
      return { url } as const;
    }),
  /** Uploads a gallery image (base64) to S3 storage and returns its public URL. */
  uploadGalleryImage: adminProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(200),
        mimeType: z
          .string()
          .regex(/^image\/(png|jpe?g|webp|gif|avif)$/i, "Only PNG, JPEG, WebP, GIF, or AVIF images are allowed"),
        // ~5MB binary ≈ 6.8M base64 chars
        dataBase64: z.string().min(1).max(7_000_000),
      })
    )
    .mutation(async ({ input }) => {
      const buf = Buffer.from(input.dataBase64, "base64");
      if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file" });
      if (buf.length > 5 * 1024 * 1024)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must be 5MB or smaller" });
      // Sanitize the file name; storagePut appends a unique hash suffix itself.
      const safeName =
        input.fileName
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "")
          .slice(-80) || "photo.jpg";
      const { url } = await storagePut(`gallery/${safeName}`, buf, input.mimeType);
      return { url } as const;
    }),
  createBlogPost: adminProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(3)
          .max(160)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens"),
        titleEn: z.string().min(1).max(255),
        titleEs: z.string().min(1).max(255),
        excerptEn: z.string().max(2000).optional(),
        excerptEs: z.string().max(2000).optional(),
        bodyEn: z.string().min(1).max(60000),
        bodyEs: z.string().min(1).max(60000),
        coverImage: z.string().max(500).optional(),
        readTime: z.number().int().min(1).max(60).default(5),
        published: z.boolean().default(false),
        publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const existing = await db.getBlogPostBySlug(input.slug);
      if (existing) throw new TRPCError({ code: "BAD_REQUEST", message: "A post with this slug already exists" });
      const id = await db.createBlogPost({
        ...input,
        publishedAt: input.publishedAt ?? new Date().toISOString().slice(0, 10),
      });
      return { id };
    }),
  updateBlogPost: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        slug: z
          .string()
          .min(3)
          .max(160)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional(),
        titleEn: z.string().min(1).max(255).optional(),
        titleEs: z.string().min(1).max(255).optional(),
        excerptEn: z.string().max(2000).optional(),
        excerptEs: z.string().max(2000).optional(),
        bodyEn: z.string().min(1).max(60000).optional(),
        bodyEs: z.string().min(1).max(60000).optional(),
        coverImage: z.string().max(500).optional(),
        readTime: z.number().int().min(1).max(60).optional(),
        published: z.boolean().optional(),
        publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      if (data.slug) {
        const existing = await db.getBlogPostBySlug(data.slug);
        if (existing && existing.id !== id) throw new TRPCError({ code: "BAD_REQUEST", message: "A post with this slug already exists" });
      }
      await db.updateBlogPost(id, data);
      return { success: true } as const;
    }),
  deleteBlogPost: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await db.deleteBlogPost(input.id);
    return { success: true } as const;
  }),
});
