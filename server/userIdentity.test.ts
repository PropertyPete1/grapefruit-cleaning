import { describe, expect, it } from "vitest";
import { buildUserUpsertPlan } from "./db";
import { landingPathForRole } from "@shared/access";

describe("Manus user identity synchronization", () => {
  it("uses openId as the stable identity key and seeds provider email for a new row", () => {
    const plan = buildUserUpsertPlan({
      openId: "manus-open-id-123",
      email: "provider@example.com",
      name: "Karyme",
      loginMethod: "email",
    });

    expect(plan.values).toMatchObject({
      openId: "manus-open-id-123",
      email: "provider@example.com",
      name: "Karyme",
      loginMethod: "email",
    });
  });

  it("a fresh login with a changed provider email reuses the openId row and preserves its admin role", () => {
    const stored = {
      id: 2610001,
      openId: "manus-open-id-123",
      email: "grapefruitcleaningc@gmail.com",
      name: "Karyme",
      loginMethod: "email",
      role: "admin" as const,
    };
    const laterSignIn = buildUserUpsertPlan({
      openId: "manus-open-id-123",
      email: "grapefruit@grapefruitclean.com",
      name: "grapefruit",
      loginMethod: "email",
      lastSignedIn: new Date("2026-08-25T18:00:00Z"),
    });

    expect(laterSignIn.updateSet).not.toHaveProperty("email");
    const resolved = { ...stored, ...laterSignIn.updateSet };
    expect(resolved).toMatchObject({
      id: 2610001,
      openId: "manus-open-id-123",
      email: "grapefruitcleaningc@gmail.com",
      name: "grapefruit",
      loginMethod: "email",
      role: "admin",
    });
    expect(landingPathForRole("/admin", resolved.role)).toBe("/admin");
  });

  it("never treats email as the duplicate-key identity", () => {
    const plan = buildUserUpsertPlan({
      openId: "same-open-id",
      email: "changed-provider@example.com",
    });

    expect(plan.values.openId).toBe("same-open-id");
    expect(plan.updateSet).not.toHaveProperty("openId");
    expect(plan.updateSet).not.toHaveProperty("email");
  });
});
