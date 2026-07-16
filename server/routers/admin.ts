import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import * as db from "../db";
import { buildStaffInviteEmail, deliverEmail } from "../emails";
import { storagePut } from "../storage";
import { protectedProcedure, router } from "../_core/trpc";

/** Admin-only procedure guard. */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

const bookingStatusEnum = z.enum(["pending_deposit", "confirmed", "in_progress", "completed", "cancelled", "expired"]);

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
