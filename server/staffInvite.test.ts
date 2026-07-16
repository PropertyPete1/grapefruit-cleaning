/**
 * Staff invite flow tests: token generation, acceptance, and edge cases.
 * DB calls are mocked — these verify the router-level behavior contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { inferProcedureInput } from "@trpc/server";

vi.mock("./db", () => ({
  getEmployeeByInviteToken: vi.fn(),
  updateEmployee: vi.fn(),
  setUserRole: vi.fn(),
  getEmployeeByUserId: vi.fn(),
  listBookingsForStaff: vi.fn(),
  listBookingsForMonth: vi.fn(),
  updateBooking: vi.fn(),
  createEmployee: vi.fn(),
  listEmployees: vi.fn(),
  deleteEmployee: vi.fn(),
  listAllUsers: vi.fn(),
}));

import * as db from "./db";
import { staffRouter } from "./routers/staff";

type AcceptInput = inferProcedureInput<typeof staffRouter.acceptInvite>;

function makeCaller(user: { id: number; role: "user" | "staff" | "admin" }) {
  return staffRouter.createCaller({ user } as never);
}

const EMPLOYEE = {
  id: 7,
  userId: null as number | null,
  firstName: "Maria",
  lastName: "Lopez",
  email: "maria@example.com",
  phone: null,
  role: "Cleaner",
  active: true,
  inviteToken: "a".repeat(48),
  inviteSentAt: new Date(),
  inviteAcceptedAt: null,
  hiredAt: new Date(),
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staff.acceptInvite", () => {
  it("links the employee to the signed-in user, clears the token, and grants staff role", async () => {
    vi.mocked(db.getEmployeeByInviteToken).mockResolvedValue({ ...EMPLOYEE });
    const caller = makeCaller({ id: 42, role: "user" });
    const result = await caller.acceptInvite({ token: EMPLOYEE.inviteToken } satisfies AcceptInput);

    expect(result.success).toBe(true);
    expect(result.employeeName).toBe("Maria Lopez");
    expect(db.updateEmployee).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ userId: 42, inviteToken: null, active: true })
    );
    expect(db.setUserRole).toHaveBeenCalledWith(42, "staff");
  });

  it("does not demote admins who accept an invite", async () => {
    vi.mocked(db.getEmployeeByInviteToken).mockResolvedValue({ ...EMPLOYEE });
    const caller = makeCaller({ id: 1, role: "admin" });
    await caller.acceptInvite({ token: EMPLOYEE.inviteToken });
    expect(db.setUserRole).not.toHaveBeenCalled();
  });

  it("rejects an unknown or already-used token", async () => {
    vi.mocked(db.getEmployeeByInviteToken).mockResolvedValue(null);
    const caller = makeCaller({ id: 42, role: "user" });
    await expect(caller.acceptInvite({ token: "b".repeat(48) })).rejects.toThrow(/invalid|already/i);
    expect(db.updateEmployee).not.toHaveBeenCalled();
  });

  it("rejects a token already claimed by a different account", async () => {
    vi.mocked(db.getEmployeeByInviteToken).mockResolvedValue({ ...EMPLOYEE, userId: 99 });
    const caller = makeCaller({ id: 42, role: "user" });
    await expect(caller.acceptInvite({ token: EMPLOYEE.inviteToken })).rejects.toThrow(/another account/i);
  });

  it("is idempotent for the same account re-opening the link mid-flow", async () => {
    vi.mocked(db.getEmployeeByInviteToken).mockResolvedValue({ ...EMPLOYEE, userId: 42 });
    const caller = makeCaller({ id: 42, role: "user" });
    const result = await caller.acceptInvite({ token: EMPLOYEE.inviteToken });
    expect(result.success).toBe(true);
  });

  it("rejects tokens that are too short to be valid", async () => {
    const caller = makeCaller({ id: 42, role: "user" });
    await expect(caller.acceptInvite({ token: "short" })).rejects.toThrow();
    expect(db.getEmployeeByInviteToken).not.toHaveBeenCalled();
  });
});

describe("admin employee invite contract", () => {
  it("createEmployee returns the inserted id (used to auto-send the invite on add)", async () => {
    const { adminRouter } = await import("./routers/admin");
    vi.mocked(db.createEmployee).mockResolvedValue(31);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    const result = await caller.createEmployee({ firstName: "Ana", lastName: "Ruiz" });
    expect(result).toEqual({ id: 31 });
  });

  it("sendStaffInvite generates a token, stores it, and returns the join URL", async () => {
    const { adminRouter } = await import("./routers/admin");
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, id: 31, userId: null, inviteToken: null, email: null }] as never);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    const result = await caller.sendStaffInvite({ employeeId: 31, origin: "https://grapeclean-skvabkkr.manus.space" });
    expect(result.inviteUrl).toMatch(/^https:\/\/grapeclean-skvabkkr\.manus\.space\/staff\/join\/[a-f0-9]{48}$/);
    expect(result.emailed).toBe(false);
    expect(db.updateEmployee).toHaveBeenCalledWith(
      31,
      expect.objectContaining({ inviteToken: expect.stringMatching(/^[a-f0-9]{48}$/), inviteAcceptedAt: null })
    );
  });

  it("sendStaffInvite refuses when the employee is already connected", async () => {
    const { adminRouter } = await import("./routers/admin");
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, id: 31, userId: 42, inviteToken: null }] as never);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin" } } as never);
    await expect(
      caller.sendStaffInvite({ employeeId: 31, origin: "https://grapeclean-skvabkkr.manus.space" })
    ).rejects.toThrow(/already connected/i);
  });
});
