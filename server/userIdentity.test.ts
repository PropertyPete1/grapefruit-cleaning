import { describe, expect, it } from "vitest";
import { buildUserUpsertPlan } from "./db";

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

  it("preserves an existing manually managed email during a later provider sign-in", () => {
    const stored = {
      openId: "manus-open-id-123",
      email: "grapefruitcleaningc@gmail.com",
      name: "Karyme",
      loginMethod: "email",
    };
    const laterSignIn = buildUserUpsertPlan({
      openId: "manus-open-id-123",
      email: "grapefruit@grapefruitclean.com",
      name: "grapefruit",
      loginMethod: "email",
      lastSignedIn: new Date("2026-08-25T18:00:00Z"),
    });

    expect(laterSignIn.updateSet).not.toHaveProperty("email");
    expect({ ...stored, ...laterSignIn.updateSet }).toMatchObject({
      openId: "manus-open-id-123",
      email: "grapefruitcleaningc@gmail.com",
      name: "grapefruit",
      loginMethod: "email",
    });
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
