/**
 * Role management tests for admin.linkEmployeeUser with access levels:
 * promote to admin, demote to staff, unlink, last-admin guard, self-demotion guard.
 * DB calls are mocked — these verify the router-level behavior contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  listEmployees: vi.fn(),
  listAllUsers: vi.fn(),
  updateEmployee: vi.fn(),
  setUserRole: vi.fn(),
}));

import * as db from "./db";
import { adminRouter } from "./routers/admin";

function makeCaller(user: { id: number; role: "user" | "staff" | "admin" }) {
  return adminRouter.createCaller({ user } as never);
}

const EMPLOYEE = {
  id: 7,
  userId: null as number | null,
  firstName: "Karyme",
  lastName: "Plata",
  email: "grapefruit@grapefruitclean.com",
  phone: null,
  role: "Cleaner",
  active: true,
  inviteToken: null,
  inviteSentAt: null,
  inviteAcceptedAt: null,
  hiredAt: new Date(),
  createdAt: new Date(),
};

const OWNER = { id: 1, name: "Peter Allen", email: "peter@example.com", role: "admin" as const };
const KARYME = { id: 42, name: "grapefruit", email: "grapefruit@grapefruitclean.com", role: "staff" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin.linkEmployeeUser access levels", () => {
  it("promotes a linked staff user to admin", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, KARYME] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    const result = await caller.linkEmployeeUser({ employeeId: 7, userId: 42, accessLevel: "admin" });
    expect(result.success).toBe(true);
    expect(db.setUserRole).toHaveBeenCalledWith(42, "admin");
  });

  it("defaults to staff when no access level is given (back-compat)", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: null }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, { ...KARYME, role: "user" }] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    await caller.linkEmployeeUser({ employeeId: 7, userId: 42 });
    expect(db.setUserRole).toHaveBeenCalledWith(42, "staff");
  });

  it("demotes an admin back to staff when another admin exists", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, { ...KARYME, role: "admin" }] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    await caller.linkEmployeeUser({ employeeId: 7, userId: 42, accessLevel: "staff" });
    expect(db.setUserRole).toHaveBeenCalledWith(42, "staff");
  });

  it("refuses to demote the last remaining admin", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    // Karyme is the ONLY admin; a different admin session somehow tries to demote her
    vi.mocked(db.listAllUsers).mockResolvedValue([{ ...KARYME, role: "admin" }] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    await expect(
      caller.linkEmployeeUser({ employeeId: 7, userId: 42, accessLevel: "staff" })
    ).rejects.toThrow(/only admin/i);
    expect(db.setUserRole).not.toHaveBeenCalled();
  });

  it("refuses to let an admin demote their own account", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 1 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, { ...KARYME, role: "admin" }] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    await expect(
      caller.linkEmployeeUser({ employeeId: 7, userId: 1, accessLevel: "staff" })
    ).rejects.toThrow(/own admin access/i);
    expect(db.setUserRole).not.toHaveBeenCalled();
  });

  it("refuses to unlink an employee whose account is the last admin", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([{ ...KARYME, role: "admin" }] as never);
    const caller = makeCaller({ id: 5, role: "admin" });
    await expect(caller.linkEmployeeUser({ employeeId: 7, userId: null })).rejects.toThrow(/only admin/i);
    expect(db.updateEmployee).not.toHaveBeenCalled();
  });

  it("unlinks a staff member and returns their role to user", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, KARYME] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    const result = await caller.linkEmployeeUser({ employeeId: 7, userId: null });
    expect(result.success).toBe(true);
    expect(db.setUserRole).toHaveBeenCalledWith(42, "user");
    expect(db.updateEmployee).toHaveBeenCalledWith(7, { userId: null });
  });

  it("keeps an existing admin as admin when re-saving with accessLevel admin (no-op role write)", async () => {
    vi.mocked(db.listEmployees).mockResolvedValue([{ ...EMPLOYEE, userId: 42 }] as never);
    vi.mocked(db.listAllUsers).mockResolvedValue([OWNER, { ...KARYME, role: "admin" }] as never);
    const caller = makeCaller({ id: 1, role: "admin" });
    await caller.linkEmployeeUser({ employeeId: 7, userId: 42, accessLevel: "admin" });
    expect(db.setUserRole).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    const caller = makeCaller({ id: 42, role: "staff" });
    await expect(caller.linkEmployeeUser({ employeeId: 7, userId: 42, accessLevel: "admin" })).rejects.toThrow(
      /admin access required/i
    );
  });
});
