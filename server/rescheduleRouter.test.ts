import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAccess,
  mockGetOpenRequest,
  mockGetRequest,
  mockCreateRequest,
  mockMove,
  mockNotifyMove,
  mockSendRequestReceived,
  mockSendOwnerAlert,
} = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockGetOpenRequest: vi.fn(),
  mockGetRequest: vi.fn(),
  mockCreateRequest: vi.fn(),
  mockMove: vi.fn(),
  mockNotifyMove: vi.fn(),
  mockSendRequestReceived: vi.fn(),
  mockSendOwnerAlert: vi.fn(),
}));

vi.mock("./rescheduleAccess", () => ({
  getBookingRescheduleAccess: (...args: unknown[]) => mockAccess(...args),
}));
vi.mock("./db", () => ({
  getOpenBookingRescheduleRequest: (...args: unknown[]) => mockGetOpenRequest(...args),
  getBookingRescheduleRequest: (...args: unknown[]) => mockGetRequest(...args),
}));
vi.mock("./rescheduling", () => ({
  createCustomerRescheduleRequest: (...args: unknown[]) => mockCreateRequest(...args),
  moveConfirmedBooking: (...args: unknown[]) => mockMove(...args),
  notifyEffectiveScheduleMove: (...args: unknown[]) => mockNotifyMove(...args),
}));
vi.mock("./emails", () => ({
  sendRescheduleRequestReceived: (...args: unknown[]) => mockSendRequestReceived(...args),
  sendOwnerAlert: (...args: unknown[]) => mockSendOwnerAlert(...args),
}));

import { rescheduleRouter } from "./routers/reschedule";

const TOKEN = "b".repeat(64);
const BOOKING = {
  id: 41,
  reference: "GFC-RS41",
  serviceType: "residential",
  sqft: 1200,
  estimatedHours: 3,
  scheduledDate: "2026-09-03",
  scheduledTime: "11:00",
  locale: "en",
  totalAmount: 320,
  depositAmount: 80,
  extras: "[]",
};
const CUSTOMER = { id: 7, firstName: "Ana", lastName: "Lopez", email: "ana@example.com" };

const caller = () => rescheduleRouter.createCaller({ user: null } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockAccess.mockResolvedValue({ booking: { ...BOOKING }, customer: { ...CUSTOMER } });
  mockGetOpenRequest.mockResolvedValue(undefined);
  mockCreateRequest.mockResolvedValue({ requestId: 12 });
  mockSendRequestReceived.mockResolvedValue({ ownerDelivered: true, customerDelivered: true });
  mockGetRequest.mockResolvedValue({
    id: 12,
    bookingId: 41,
    status: "countered",
    proposedDate: "2026-09-04",
    proposedTime: "14:00",
    counterDate: "2026-09-05",
    counterTime: "15:00",
    customerNote: "Afternoon",
    adminNote: "Routing works at 3 PM",
  });
  mockMove.mockResolvedValue({
    before: { ...BOOKING },
    after: { ...BOOKING, scheduledDate: "2026-09-05", scheduledTime: "15:00" },
  });
  mockNotifyMove.mockResolvedValue({ customerDelivered: true, cleanerDelivered: true });
  mockSendOwnerAlert.mockResolvedValue(true);
});

describe("public customer reschedule router", () => {
  it("returns only scheduling-safe booking fields, never prices, deposits, address, or tokens", async () => {
    const result = await caller().access({ token: TOKEN });
    expect(result.booking).toEqual({
      id: 41,
      reference: "GFC-RS41",
      serviceType: "residential",
      sqft: 1200,
      estimatedHours: 3,
      scheduledDate: "2026-09-03",
      scheduledTime: "11:00",
      locale: "en",
    });
    expect(result.booking).not.toHaveProperty("totalAmount");
    expect(result.booking).not.toHaveProperty("depositAmount");
  });

  it("records and alerts on a proposal but never moves the booking", async () => {
    const result = await caller().request({
      token: TOKEN,
      date: "2026-09-04",
      time: "14:00",
      note: "Afternoon please",
      locale: "en",
    });
    expect(result).toEqual({ success: true, requestId: 12 });
    expect(mockCreateRequest).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 41, proposedTime: "14:00" }));
    expect(mockSendRequestReceived).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 41, customerEmail: "ana@example.com" }));
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired link", async () => {
    mockAccess.mockResolvedValue(undefined);
    await expect(caller().access({ token: TOKEN })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts only a counter belonging to the token booking, then moves atomically", async () => {
    const result = await caller().acceptCounter({ token: TOKEN, requestId: 12 });
    expect(mockMove).toHaveBeenCalledWith({
      bookingId: 41,
      target: { date: "2026-09-05", time: "15:00" },
      actor: { type: "customer", label: "Ana Lopez" },
      note: "Afternoon",
      requestId: 12,
      resolveRequest: true,
      action: "counter_accepted",
    });
    expect(mockNotifyMove).toHaveBeenCalledOnce();
    expect(mockSendOwnerAlert).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it("cannot accept another booking's request", async () => {
    mockGetRequest.mockResolvedValue({ id: 12, bookingId: 999, status: "countered", counterDate: "2026-09-05" });
    await expect(caller().acceptCounter({ token: TOKEN, requestId: 12 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockMove).not.toHaveBeenCalled();
  });
});
