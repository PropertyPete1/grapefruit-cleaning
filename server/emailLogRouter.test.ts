/**
 * The email log is an operational record of who was contacted, so it is
 * admin-only and its page size is bounded. Both are pinned here — a log that
 * quietly became readable by any signed-in user would leak the customer list.
 */
import { describe, expect, it, vi } from "vitest";

const mockListEmailLog = vi.fn().mockResolvedValue([]);

vi.mock("./db", () => ({
  listEmailLog: (...args: unknown[]) => mockListEmailLog(...args),
}));

import { adminRouter } from "./routers/admin";

type Caller = ReturnType<typeof adminRouter.createCaller>;

function callerFor(role: "admin" | "staff" | "user" | null): Caller {
  const user = role ? { id: 1, openId: "o1", role, name: "T", email: "t@example.com" } : null;
  return adminRouter.createCaller({ user } as never);
}

describe("admin.emailLog", () => {
  it("returns the 50 most recent attempts by default", async () => {
    await callerFor("admin").emailLog(undefined);
    expect(mockListEmailLog).toHaveBeenCalledWith(50);
  });

  it("honours an explicit limit", async () => {
    await callerFor("admin").emailLog({ limit: 10 });
    expect(mockListEmailLog).toHaveBeenLastCalledWith(10);
  });

  it("rejects a limit above the cap rather than dumping the whole table", async () => {
    await expect(callerFor("admin").emailLog({ limit: 5_000 })).rejects.toThrow();
  });

  it("is closed to staff — it lists every customer contacted", async () => {
    await expect(callerFor("staff").emailLog(undefined)).rejects.toThrow();
  });

  it("is closed to ordinary users", async () => {
    await expect(callerFor("user").emailLog(undefined)).rejects.toThrow();
  });

  it("is closed to anonymous callers", async () => {
    await expect(callerFor(null).emailLog(undefined)).rejects.toThrow();
  });
});
