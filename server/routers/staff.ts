import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { issueBalanceSafely, originFromRequest } from "../balance";
import { withDurationHours } from "./booking";
import { sendJobStartedEmailSafely } from "../statusEmails";
import { protectedProcedure, router } from "../_core/trpc";

/**
 * The staff views nest the booking under a `booking` key alongside its
 * customer, so the duration is resolved on the inner row and lifted back out.
 */
async function withJobDuration<
  T extends { booking: { serviceType: string; sqft: number; estimatedHours: number | null } },
>(rows: T[]): Promise<(T & { booking: T["booking"] & { durationHours: number } })[]> {
  const resolved = await withDurationHours(rows.map(r => r.booking));
  return rows.map((row, index) => ({ ...row, booking: resolved[index]! }));
}

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
          status: z.enum(["pending_deposit", "confirmed", "in_progress", "completed", "cancelled", "expired"]).optional(),
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
        return withJobDuration(rows.filter((r) => r.booking.employeeId === employee.id));
      }
      return withJobDuration(rows);
    }),

  /** Staff may progress job status (confirmed → in_progress → completed) but not cancel or delete. */
  updateJobStatus: staffProcedure
    .input(z.object({ bookingId: z.number().int(), status: z.enum(["in_progress", "completed"]) }))
    .mutation(async ({ ctx, input }) => {
      // Read first: only an actual confirmed → in progress move is a job
      // starting, and that is what the customer gets told about.
      const before = await db.getBookingById(input.bookingId);
      try {
        await db.updateBooking(input.bookingId, { status: input.status });
      } catch (error) {
        // Same guard as the admin status change: moving a released booking back
        // into a slot someone else now holds is refused by the unique index.
        if (db.isSlotTakenError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Another booking already holds that date and time. Ask an admin to reschedule one of them.",
          });
        }
        throw error;
      }
      // Completing a job files its remaining balance for admin approval —
      // nothing reaches the customer until it is reviewed. Best-effort: never
      // fails the status update.
      if (input.status === "completed") {
        await issueBalanceSafely(input.bookingId, originFromRequest(ctx.req));
      }
      // Tapping Start job tells the customer their crew has arrived. Same
      // best-effort contract: a mail failure never fails the status change.
      if (input.status === "in_progress" && before?.status === "confirmed") {
        await sendJobStartedEmailSafely(input.bookingId);
      }
      return { success: true } as const;
    }),

  /** Month schedule for the staff calendar. */
  schedule: staffProcedure
    .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))
    .query(async ({ input }) => withJobDuration(await db.listBookingsForMonth(input.month))),
});
