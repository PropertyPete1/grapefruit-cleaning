import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { protectedProcedure, router } from "../_core/trpc";

/** Admin-only procedure guard. */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

const bookingStatusEnum = z.enum(["pending_deposit", "confirmed", "in_progress", "completed", "cancelled"]);

export const adminRouter = router({
  // ---------- Dashboard & statistics ----------
  stats: adminProcedure.query(() => db.getDashboardStats()),
  monthlyRevenue: adminProcedure.query(() => db.getMonthlyRevenue()),
  bookingsByService: adminProcedure.query(() => db.getBookingsByService()),

  // ---------- Appointments ----------
  bookings: adminProcedure
    .input(z.object({ status: bookingStatusEnum.optional(), from: z.string().optional(), to: z.string().optional() }).optional())
    .query(({ input }) => db.listBookings(input)),
  updateBookingStatus: adminProcedure
    .input(z.object({ id: z.number().int(), status: bookingStatusEnum }))
    .mutation(async ({ input }) => {
      await db.updateBooking(input.id, { status: input.status });
      return { success: true } as const;
    }),
  assignEmployee: adminProcedure
    .input(z.object({ bookingId: z.number().int(), employeeId: z.number().int().nullable() }))
    .mutation(async ({ input }) => {
      await db.updateBooking(input.bookingId, { employeeId: input.employeeId });
      return { success: true } as const;
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
   * Grant staff access: links an employee record to a signed-in user account
   * and promotes that user to the "staff" role (or revokes it when unlinking).
   */
  linkEmployeeUser: adminProcedure
    .input(z.object({ employeeId: z.number().int(), userId: z.number().int().nullable() }))
    .mutation(async ({ input }) => {
      const existing = (await db.listEmployees()).find((e) => e.id === input.employeeId);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Employee not found" });
      // If unlinking or relinking, demote the previously linked user back to "user" (unless admin).
      if (existing.userId && existing.userId !== input.userId) {
        const prev = (await db.listAllUsers()).find((u) => u.id === existing.userId);
        if (prev && prev.role === "staff") await db.setUserRole(prev.id, "user");
      }
      await db.updateEmployee(input.employeeId, { userId: input.userId });
      if (input.userId) {
        const target = (await db.listAllUsers()).find((u) => u.id === input.userId);
        if (target && target.role !== "admin") await db.setUserRole(target.id, "staff");
      }
      return { success: true } as const;
    }),

  // ---------- Invoices ----------
  invoices: adminProcedure.query(() => db.listInvoices()),
  createInvoice: adminProcedure
    .input(
      z.object({
        customerId: z.number().int(),
        bookingId: z.number().int().optional(),
        amount: z.number().int().min(1),
        dueDate: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const number = `INV-${Date.now().toString(36).toUpperCase()}`;
      const id = await db.createInvoice({ ...input, number, status: "sent" });
      return { id, number };
    }),
  updateInvoiceStatus: adminProcedure
    .input(z.object({ id: z.number().int(), status: z.enum(["draft", "sent", "paid", "overdue", "void"]) }))
    .mutation(async ({ input }) => {
      await db.updateInvoice(input.id, {
        status: input.status,
        paidAt: input.status === "paid" ? new Date() : undefined,
      });
      return { success: true } as const;
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
        url: z.string().url().max(500),
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
      await db.setSetting(input.key, input.value);
      return { success: true } as const;
    }),
});
