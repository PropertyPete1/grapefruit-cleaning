import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { DEFAULT_DURATIONS } from "@shared/duration";
import { DEFAULT_SCHEDULE } from "@shared/schedule";

const {
  mockGetBookingById,
  mockMoveBookingSchedule,
  mockIsSlotTakenError,
  mockCreateRequest,
  mockGetRequest,
  mockUpdateRequest,
  mockCreateEvent,
  mockGetCustomer,
  mockGetEmployee,
  mockAdminSlotBookable,
  mockReleaseExpired,
  mockLoadRules,
  mockMintUrl,
  mockSendConfirmation,
} = vi.hoisted(() => ({
  mockGetBookingById: vi.fn(),
  mockMoveBookingSchedule: vi.fn(),
  mockIsSlotTakenError: vi.fn(),
  mockCreateRequest: vi.fn(),
  mockGetRequest: vi.fn(),
  mockUpdateRequest: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockGetCustomer: vi.fn(),
  mockGetEmployee: vi.fn(),
  mockAdminSlotBookable: vi.fn(),
  mockReleaseExpired: vi.fn(),
  mockLoadRules: vi.fn(),
  mockMintUrl: vi.fn(),
  mockSendConfirmation: vi.fn(),
}));

vi.mock("./db", () => ({
  getBookingById: (...args: unknown[]) => mockGetBookingById(...args),
  moveBookingSchedule: (...args: unknown[]) => mockMoveBookingSchedule(...args),
  isSlotTakenError: (...args: unknown[]) => mockIsSlotTakenError(...args),
  createBookingRescheduleRequest: (...args: unknown[]) => mockCreateRequest(...args),
  getBookingRescheduleRequest: (...args: unknown[]) => mockGetRequest(...args),
  updateBookingRescheduleRequest: (...args: unknown[]) => mockUpdateRequest(...args),
  createBookingScheduleEvent: (...args: unknown[]) => mockCreateEvent(...args),
  getCustomerById: (...args: unknown[]) => mockGetCustomer(...args),
  getEmployeeById: (...args: unknown[]) => mockGetEmployee(...args),
}));

vi.mock("./adminBooking", () => ({
  adminSlotBookable: (...args: unknown[]) => mockAdminSlotBookable(...args),
  slotUnavailableError: () => new TRPCError({ code: "BAD_REQUEST", message: "That slot is not available." }),
}));

vi.mock("./checkoutHolds", () => ({
  releaseExpiredCheckoutHolds: (...args: unknown[]) => mockReleaseExpired(...args),
}));

vi.mock("./routers/booking", () => ({
  finalizeBooking: vi.fn(),
  loadSchedulingRules: (...args: unknown[]) => mockLoadRules(...args),
}));

vi.mock("./rescheduleAccess", () => ({
  mintBookingRescheduleUrl: (...args: unknown[]) => mockMintUrl(...args),
}));

vi.mock("./publicOrigin", () => ({ publicOrigin: () => "https://grapeclean.com" }));
vi.mock("./emails", () => ({
  sendRescheduleConfirmationEmails: (...args: unknown[]) => mockSendConfirmation(...args),
}));

import {
  approveRescheduleRequest,
  counterRescheduleRequest,
  createCustomerRescheduleRequest,
  declineRescheduleRequest,
  moveConfirmedBooking,
  notifyEffectiveScheduleMove,
} from "./rescheduling";

const BOOKING = {
  id: 41,
  reference: "GFC-RS41",
  customerId: 7,
  employeeId: 3,
  status: "confirmed",
  kind: "self_serve",
  locale: "es",
  serviceType: "residential",
  sqft: 1200,
  estimatedHours: 3,
  scheduledDate: "2026-09-03",
  scheduledTime: "11:00",
  totalAmount: 320,
  depositAmount: 80,
  extras: "[]",
};

const moved = (time: string | null = "14:00") => ({
  outcome: "moved" as const,
  before: { ...BOOKING },
  after: { ...BOOKING, scheduledDate: "2026-09-04", scheduledTime: time },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBookingById.mockResolvedValue({ ...BOOKING });
  mockMoveBookingSchedule.mockResolvedValue(moved());
  mockIsSlotTakenError.mockReturnValue(false);
  mockCreateRequest.mockResolvedValue({ outcome: "created", requestId: 12 });
  mockGetRequest.mockResolvedValue({
    id: 12,
    bookingId: 41,
    status: "pending",
    proposedDate: "2026-09-04",
    proposedTime: "14:00",
  });
  mockUpdateRequest.mockResolvedValue(undefined);
  mockCreateEvent.mockResolvedValue(91);
  mockGetCustomer.mockResolvedValue({ id: 7, firstName: "Ana", email: "ana@example.com" });
  mockGetEmployee.mockResolvedValue({ id: 3, firstName: "Karyme", lastName: "Plata", email: "crew@example.com" });
  mockAdminSlotBookable.mockResolvedValue(true);
  mockReleaseExpired.mockResolvedValue({ candidates: 0, released: 0, confirmed: 0, retained: 0, errors: [] });
  mockLoadRules.mockResolvedValue({ schedule: DEFAULT_SCHEDULE, lunchBreak: false, leadTimeHours: 3, durations: DEFAULT_DURATIONS });
  mockMintUrl.mockResolvedValue({ token: "secret", url: "https://grapeclean.com/es/reprogramar/secret" });
  mockSendConfirmation.mockResolvedValue({ customerDelivered: true, cleanerDelivered: true });
});

describe("moveConfirmedBooking", () => {
  it("validates and atomically moves one confirmed booking with audit attribution", async () => {
    const result = await moveConfirmedBooking({
      bookingId: 41,
      target: { date: "2026-09-04", time: "14:00" },
      actor: { type: "admin", userId: 9, label: "Karyme" },
      note: "Customer requested tomorrow",
    });

    expect(result).toEqual(moved());
    expect(mockReleaseExpired).toHaveBeenCalledOnce();
    expect(mockAdminSlotBookable).toHaveBeenCalledWith(expect.objectContaining({
      date: "2026-09-04",
      time: "14:00",
      jobHours: 3,
      excludeBookingId: 41,
    }));
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith({
      bookingId: 41,
      toDate: "2026-09-04",
      toTime: "14:00",
      estimatedHours: 3,
      actorType: "admin",
      actorUserId: 9,
      actorLabel: "Karyme",
      action: "moved",
      note: "Customer requested tomorrow",
      requestId: undefined,
      resolveRequest: undefined,
    });
  });

  it("supports a date-known/time-pending move only when the date has a legal eventual slot", async () => {
    mockMoveBookingSchedule.mockResolvedValue(moved(null));
    await moveConfirmedBooking({
      bookingId: 41,
      target: { date: "2026-09-04", time: null },
      actor: { type: "admin", userId: 9 },
    });

    expect(mockAdminSlotBookable).toHaveBeenCalled();
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith(expect.objectContaining({
      toDate: "2026-09-04",
      toTime: null,
      action: "pending_time",
    }));
  });

  it("refuses a pending-time move when no legal start exists on that date", async () => {
    mockAdminSlotBookable.mockResolvedValue(false);
    await expect(moveConfirmedBooking({
      bookingId: 41,
      target: { date: "2026-09-04", time: null },
      actor: { type: "admin", userId: 9 },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });

  it("rejects completed or cancelled bookings before touching the schedule", async () => {
    mockGetBookingById.mockResolvedValue({ ...BOOKING, status: "completed" });
    await expect(moveConfirmedBooking({
      bookingId: 41,
      target: { date: "2026-09-04", time: "14:00" },
      actor: { type: "admin" },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });

  it("maps a unique-slot race to a conflict", async () => {
    mockMoveBookingSchedule.mockRejectedValue(new Error("ER_DUP_ENTRY slotKey"));
    mockIsSlotTakenError.mockReturnValue(true);
    await expect(moveConfirmedBooking({
      bookingId: 41,
      target: { date: "2026-09-04", time: "14:00" },
      actor: { type: "admin" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("customer request workflow", () => {
  it("records a validated customer proposal without moving the booking", async () => {
    const result = await createCustomerRescheduleRequest({
      bookingId: 41,
      proposedDate: "2026-09-04",
      proposedTime: "14:00",
      customerNote: "Afternoon please",
      locale: "es",
    });
    expect(result.requestId).toBe(12);
    expect(mockCreateRequest).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 41, proposedTime: "14:00" }));
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });

  it("approves through the same atomic move and resolves the request", async () => {
    await approveRescheduleRequest({ requestId: 12, actor: { type: "admin", userId: 9 } });
    expect(mockMoveBookingSchedule).toHaveBeenCalledWith(expect.objectContaining({
      bookingId: 41,
      requestId: 12,
      resolveRequest: true,
      action: "request_approved",
    }));
  });

  it("records a counter without moving the booking", async () => {
    await counterRescheduleRequest({
      requestId: 12,
      actor: { type: "admin", userId: 9, label: "Karyme" },
      target: { date: "2026-09-05", time: "15:00" },
      note: "Routing works better at 3 PM",
    });
    expect(mockUpdateRequest).toHaveBeenCalledWith(12, expect.objectContaining({ status: "countered", counterTime: "15:00" }));
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "countered", toTime: "15:00" }));
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });

  it("declines with an immutable event and leaves the booking untouched", async () => {
    await declineRescheduleRequest({ requestId: 12, actor: { type: "admin", userId: 9 }, note: "No route available" });
    expect(mockUpdateRequest).toHaveBeenCalledWith(12, expect.objectContaining({ status: "declined" }));
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "declined" }));
    expect(mockMoveBookingSchedule).not.toHaveBeenCalled();
  });
});

describe("post-move notifications", () => {
  it("rotates the secure link and sends one logged bilingual customer and cleaner notification", async () => {
    const result = await notifyEffectiveScheduleMove({
      before: moved().before as never,
      after: moved().after as never,
      note: "Customer requested tomorrow",
    });
    expect(mockMintUrl).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 41, locale: "es" }));
    expect(mockSendConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      bookingId: 41,
      customerEmail: "ana@example.com",
      employeeEmail: "crew@example.com",
      toDate: "2026-09-04",
      toTime: "14:00",
    }));
    expect(result).toEqual({ customerDelivered: true, cleanerDelivered: true });
  });
});
