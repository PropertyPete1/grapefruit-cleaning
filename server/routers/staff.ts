import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { protectedProcedure, router } from "../_core/trpc";

/**
 * Staff procedures: available to users whose role is "staff" or "admin".
 * Staff can view bookings and schedules but cannot modify pricing,
 * customers, invoices, or settings.
 */
const staffProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "staff" && ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Staff access required" });
  }
  return next({ ctx });
});

export const staffRouter = router({
  /**
   * Accepts a staff-dashboard invite: any signed-in user with a valid token is
   * linked to the matching employee record and promoted to the staff role.
   * The token is single-use — cleared on success.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string().min(16).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const employee = await db.getEmployeeByInviteToken(input.token);
      if (!employee) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This invite link is invalid or has already been used." });
      }
      if (employee.userId && employee.userId !== ctx.user.id) {
        throw new TRPCError({ code: "CONFLICT", message: "This invite was already accepted by another account." });
      }
      await db.updateEmployee(employee.id, {
        userId: ctx.user.id,
        inviteToken: null,
        inviteAcceptedAt: new Date(),
        active: true,
      });
      if (ctx.user.role !== "admin") await db.setUserRole(ctx.user.id, "staff");
      return { success: true, employeeName: `${employee.firstName} ${employee.lastName}` } as const;
    }),

  /** KPI summary for the staff home screen. */
  overview: staffProcedure.query(async ({ ctx }) => {
    const employee = await db.getEmployeeByUserId(ctx.user.id);
    const all = await db.listBookingsForStaff({});
    const today = new Date().toISOString().slice(0, 10);
    const mine = employee ? all.filter((b) => b.booking.employeeId === employee.id) : [];
    return {
      employee,
      todayCount: all.filter((b) => b.booking.scheduledDate === today && b.booking.status !== "cancelled").length,
      upcomingCount: all.filter((b) => b.booking.scheduledDate >= today && (b.booking.status === "confirmed" || b.booking.status === "pending_deposit")).length,
      myUpcomingCount: mine.filter((b) => b.booking.scheduledDate >= today && b.booking.status !== "cancelled" && b.booking.status !== "completed").length,
    };
  }),

  /** Bookings list with optional filters; staff see all jobs, with a "mine" toggle. */
  bookings: staffProcedure
    .input(
      z
        .object({
          status: z.enum(["pending_deposit", "confirmed", "in_progress", "completed", "cancelled"]).optional(),
          date: z.string().optional(),
          mineOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const rows = await db.listBookingsForStaff({ status: input?.status, date: input?.date });
      if (input?.mineOnly) {
        const employee = await db.getEmployeeByUserId(ctx.user.id);
        if (!employee) return [];
        return rows.filter((r) => r.booking.employeeId === employee.id);
      }
      return rows;
    }),

  /** Staff may progress job status (confirmed → in_progress → completed) but not cancel or delete. */
  updateJobStatus: staffProcedure
    .input(z.object({ bookingId: z.number().int(), status: z.enum(["in_progress", "completed"]) }))
    .mutation(async ({ input }) => {
      await db.updateBooking(input.bookingId, { status: input.status });
      return { success: true } as const;
    }),

  /** Month schedule for the staff calendar. */
  schedule: staffProcedure
    .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))
    .query(({ input }) => db.listBookingsForMonth(input.month)),
});
