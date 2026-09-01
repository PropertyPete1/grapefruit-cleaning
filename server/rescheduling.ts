import { TRPCError } from "@trpc/server";
import { durationHoursFor } from "@shared/duration";
import { slotsForDate } from "@shared/schedule";
import * as db from "./db";
import { adminSlotBookable, slotUnavailableError } from "./adminBooking";
import { releaseExpiredCheckoutHolds } from "./checkoutHolds";
import { sendRescheduleConfirmationEmails } from "./emails";
import { publicOrigin } from "./publicOrigin";
import { mintBookingRescheduleUrl } from "./rescheduleAccess";
import { finalizeBooking, loadSchedulingRules } from "./routers/booking";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{2}:\d{2}$/;

export interface ScheduleActor {
  type: "admin" | "customer" | "staff" | "ical" | "brain" | "system";
  userId?: number | null;
  label?: string | null;
}

export interface ScheduleTarget {
  date: string;
  time: string | null;
}

export interface ValidatedScheduleTarget extends ScheduleTarget {
  estimatedHours: number | null;
}

function assertScheduleShape(target: ScheduleTarget): void {
  if (!DATE_SHAPE.test(target.date)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Date must use YYYY-MM-DD." });
  }
  if (target.time !== null && !TIME_SHAPE.test(target.time)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Time must use HH:MM." });
  }
}

function assertConfirmed(booking: Awaited<ReturnType<typeof db.getBookingById>>): asserts booking is NonNullable<typeof booking> {
  if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
  if (booking.status !== "confirmed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only an upcoming confirmed booking can be rescheduled.",
    });
  }
}

export async function validateScheduleTarget(args: {
  booking: NonNullable<Awaited<ReturnType<typeof db.getBookingById>>>;
  target: ScheduleTarget;
  overrideLeadTime?: boolean;
}): Promise<ValidatedScheduleTarget> {
  assertScheduleShape(args.target);
  await releaseExpiredCheckoutHolds(new Date(), finalizeBooking);

  const { schedule, lunchBreak, leadTimeHours, durations } = await loadSchedulingRules();
  const estimatedHours =
    args.booking.estimatedHours ??
    (args.booking.serviceType && args.booking.sqft != null
      ? durationHoursFor(args.booking.serviceType, args.booking.sqft, durations)
      : null);
  const common = {
    date: args.target.date,
    jobHours: estimatedHours ?? 1,
    overrideNotice: args.overrideLeadTime ?? false,
    schedule,
    lunchBreak,
    leadTimeHours,
    durations,
    excludeBookingId: args.booking.id,
  };

  if (args.target.time) {
    if (!(await adminSlotBookable({ ...common, time: args.target.time }))) {
      throw slotUnavailableError();
    }
  } else {
    const potentialSlots = slotsForDate(args.target.date, schedule, lunchBreak);
    let hasLegalTime = false;
    for (const time of potentialSlots) {
      if (await adminSlotBookable({ ...common, time })) {
        hasLegalTime = true;
        break;
      }
    }
    if (!hasLegalTime) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That date has no legal time for this job under the current hours, notice, duration, and bookings.",
      });
    }
  }

  return { ...args.target, estimatedHours };
}

export async function moveConfirmedBooking(args: {
  bookingId: number;
  target: ScheduleTarget;
  actor: ScheduleActor;
  note?: string | null;
  requestId?: number | null;
  resolveRequest?: boolean;
  overrideLeadTime?: boolean;
  action?: string;
}) {
  const booking = await db.getBookingById(args.bookingId);
  assertConfirmed(booking);
  const target = await validateScheduleTarget({
    booking,
    target: args.target,
    overrideLeadTime: args.overrideLeadTime,
  });

  try {
    const result = await db.moveBookingSchedule({
      bookingId: booking.id,
      toDate: target.date,
      toTime: target.time,
      estimatedHours: target.estimatedHours,
      actorType: args.actor.type,
      actorUserId: args.actor.userId,
      actorLabel: args.actor.label,
      action: args.action ?? (target.time ? "moved" : "pending_time"),
      note: args.note,
      requestId: args.requestId,
      resolveRequest: args.resolveRequest,
    });
    if (result.outcome === "not_found") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
    }
    if (result.outcome === "not_eligible") {
      throw new TRPCError({ code: "CONFLICT", message: "The booking changed and can no longer be rescheduled." });
    }
    return result;
  } catch (error) {
    if (db.isSlotTakenError(error)) {
      throw new TRPCError({ code: "CONFLICT", message: "Another booking just took that date and time." });
    }
    throw error;
  }
}

export async function notifyEffectiveScheduleMove(args: {
  before: NonNullable<Awaited<ReturnType<typeof db.getBookingById>>>;
  after: NonNullable<Awaited<ReturnType<typeof db.getBookingById>>>;
  note?: string | null;
}) {
  const customer = await db.getCustomerById(args.after.customerId);
  if (!customer) return { customerDelivered: false, cleanerDelivered: false };
  const locale = (args.after.locale as "en" | "es") ?? "en";
  const access = await mintBookingRescheduleUrl({
    bookingId: args.after.id,
    locale,
    origin: publicOrigin(),
  });
  const employee = args.after.employeeId ? await db.getEmployeeById(args.after.employeeId) : null;
  return sendRescheduleConfirmationEmails({
    bookingId: args.after.id,
    reference: args.after.reference,
    customerName: customer.firstName,
    customerEmail: customer.email,
    locale,
    fromDate: args.before.scheduledDate,
    fromTime: args.before.scheduledTime,
    toDate: args.after.scheduledDate ?? "",
    toTime: args.after.scheduledTime,
    note: args.note,
    rescheduleUrl: access.url,
    employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : null,
    employeeEmail: employee?.email,
  });
}

export async function createCustomerRescheduleRequest(args: {
  bookingId: number;
  proposedDate: string;
  proposedTime: string;
  customerNote?: string | null;
  locale: "en" | "es";
}) {
  const booking = await db.getBookingById(args.bookingId);
  assertConfirmed(booking);
  await validateScheduleTarget({
    booking,
    target: { date: args.proposedDate, time: args.proposedTime },
  });
  const result = await db.createBookingRescheduleRequest({
    bookingId: booking.id,
    proposedDate: args.proposedDate,
    proposedTime: args.proposedTime,
    customerNote: args.customerNote ?? null,
    locale: args.locale,
  });
  if (result.outcome === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
  if (result.outcome === "not_eligible") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This booking can no longer be rescheduled." });
  }
  if (result.outcome === "already_open") {
    throw new TRPCError({ code: "CONFLICT", message: "A reschedule request is already waiting for a response." });
  }
  return { booking, requestId: result.requestId };
}

export async function approveRescheduleRequest(args: {
  requestId: number;
  actor: ScheduleActor;
  note?: string | null;
  target?: ScheduleTarget;
}) {
  const request = await db.getBookingRescheduleRequest(args.requestId);
  if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Reschedule request not found." });
  if (request.status !== "pending" && request.status !== "countered") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This reschedule request is already resolved." });
  }
  const target = args.target ?? { date: request.proposedDate, time: request.proposedTime };
  return moveConfirmedBooking({
    bookingId: request.bookingId,
    target,
    actor: args.actor,
    note: args.note,
    requestId: request.id,
    resolveRequest: true,
    action: target.time ? "request_approved" : "request_approved_pending_time",
  });
}

export async function counterRescheduleRequest(args: {
  requestId: number;
  actor: ScheduleActor;
  target: ScheduleTarget;
  note?: string | null;
}) {
  const request = await db.getBookingRescheduleRequest(args.requestId);
  if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Reschedule request not found." });
  if (request.status !== "pending" && request.status !== "countered") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This reschedule request is already resolved." });
  }
  const booking = await db.getBookingById(request.bookingId);
  assertConfirmed(booking);
  await validateScheduleTarget({ booking, target: args.target });
  await db.updateBookingRescheduleRequest(request.id, {
    status: "countered",
    counterDate: args.target.date,
    counterTime: args.target.time,
    adminNote: args.note ?? null,
    resolvedByUserId: args.actor.userId ?? null,
    resolvedAt: null,
  });
  await db.createBookingScheduleEvent({
    bookingId: booking.id,
    requestId: request.id,
    actorType: args.actor.type,
    actorUserId: args.actor.userId ?? null,
    actorLabel: args.actor.label ?? null,
    action: "countered",
    fromDate: booking.scheduledDate,
    fromTime: booking.scheduledTime,
    toDate: args.target.date,
    toTime: args.target.time,
    note: args.note ?? null,
  });
  return { booking, request: { ...request, status: "countered" as const, counterDate: args.target.date, counterTime: args.target.time } };
}

export async function declineRescheduleRequest(args: {
  requestId: number;
  actor: ScheduleActor;
  note?: string | null;
}) {
  const request = await db.getBookingRescheduleRequest(args.requestId);
  if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Reschedule request not found." });
  if (request.status !== "pending" && request.status !== "countered") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This reschedule request is already resolved." });
  }
  const booking = await db.getBookingById(request.bookingId);
  assertConfirmed(booking);
  await db.updateBookingRescheduleRequest(request.id, {
    status: "declined",
    adminNote: args.note ?? null,
    resolvedByUserId: args.actor.userId ?? null,
    resolvedAt: new Date(),
  });
  await db.createBookingScheduleEvent({
    bookingId: booking.id,
    requestId: request.id,
    actorType: args.actor.type,
    actorUserId: args.actor.userId ?? null,
    actorLabel: args.actor.label ?? null,
    action: "declined",
    fromDate: booking.scheduledDate,
    fromTime: booking.scheduledTime,
    toDate: request.proposedDate,
    toTime: request.proposedTime,
    note: args.note ?? null,
  });
  return { booking, request };
}
