import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import {
  sendOwnerAlert,
  sendRescheduleRequestReceived,
} from "../emails";
import { getBookingRescheduleAccess } from "../rescheduleAccess";
import {
  createCustomerRescheduleRequest,
  moveConfirmedBooking,
  notifyEffectiveScheduleMove,
} from "../rescheduling";
import { publicProcedure, router } from "../_core/trpc";

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);

async function requireAccess(token: string) {
  const access = await getBookingRescheduleAccess(token);
  if (!access) throw new TRPCError({ code: "NOT_FOUND", message: "This reschedule link is invalid or expired." });
  return access;
}

export const rescheduleRouter = router({
  access: publicProcedure.input(z.object({ token: tokenSchema })).query(async ({ input }) => {
    const { booking, customer } = await requireAccess(input.token);
    const request = await db.getOpenBookingRescheduleRequest(booking.id);
    return {
      booking: {
        id: booking.id,
        reference: booking.reference,
        serviceType: booking.serviceType,
        sqft: booking.sqft,
        estimatedHours: booking.estimatedHours,
        scheduledDate: booking.scheduledDate,
        scheduledTime: booking.scheduledTime,
        locale: booking.locale,
      },
      customerName: customer?.firstName ?? "",
      request: request
        ? {
            id: request.id,
            status: request.status,
            proposedDate: request.proposedDate,
            proposedTime: request.proposedTime,
            customerNote: request.customerNote,
            counterDate: request.counterDate,
            counterTime: request.counterTime,
            adminNote: request.adminNote,
            createdAt: request.createdAt,
          }
        : null,
    };
  }),

  request: publicProcedure
    .input(
      z.object({
        token: tokenSchema,
        date: dateSchema,
        time: timeSchema,
        note: z.string().trim().max(2000).optional(),
        locale: z.enum(["en", "es"]),
      })
    )
    .mutation(async ({ input }) => {
      const { booking, customer } = await requireAccess(input.token);
      const result = await createCustomerRescheduleRequest({
        bookingId: booking.id,
        proposedDate: input.date,
        proposedTime: input.time,
        customerNote: input.note,
        locale: input.locale,
      });
      await sendRescheduleRequestReceived({
        bookingId: booking.id,
        reference: booking.reference,
        customerName: customer?.firstName ?? "Customer",
        customerEmail: customer?.email,
        locale: input.locale,
        fromDate: booking.scheduledDate,
        fromTime: booking.scheduledTime,
        toDate: input.date,
        toTime: input.time,
        note: input.note,
      });
      return { success: true as const, requestId: result.requestId };
    }),

  acceptCounter: publicProcedure
    .input(z.object({ token: tokenSchema, requestId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { booking, customer } = await requireAccess(input.token);
      const request = await db.getBookingRescheduleRequest(input.requestId);
      if (!request || request.bookingId !== booking.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Reschedule request not found." });
      }
      if (request.status !== "countered" || !request.counterDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "There is no admin counter to accept." });
      }
      const moved = await moveConfirmedBooking({
        bookingId: booking.id,
        target: { date: request.counterDate, time: request.counterTime },
        actor: { type: "customer", label: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "Customer" },
        note: request.customerNote,
        requestId: request.id,
        resolveRequest: true,
        action: "counter_accepted",
      });
      const delivery = await notifyEffectiveScheduleMove({
        before: moved.before,
        after: moved.after,
        note: request.adminNote,
      });
      await sendOwnerAlert(
        `Reschedule counter accepted — ${booking.reference}`,
        `${customer?.firstName ?? "Customer"} accepted ${request.counterDate}${request.counterTime ? ` at ${request.counterTime}` : " — time to be decided"}.`
      );
      return { success: true as const, delivery };
    }),
});
