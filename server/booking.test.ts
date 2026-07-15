import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: { origin: "https://example.com" },
    } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("booking router (public procedures)", () => {
  it("calculates a quote server-side matching the shared pricing engine", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.booking.calculate({
      type: "residential",
      bedrooms: 2,
      bathrooms: 1,
      sqft: 1200,
      extras: ["oven"],
      frequency: "onetime",
    });
    // base 100 + 2*25 + 1*30 + ceil((1200-500)/500)*20 + 35 = 100+50+30+40+35 = 255
    expect(result.total).toBe(255);
    expect(result.deposit).toBe(Math.round(255 * 0.2));
  });

  it("applies weekly discount in server-side calculation", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const onetime = await caller.booking.calculate({
      type: "deep",
      bedrooms: 1,
      bathrooms: 1,
      sqft: 800,
      extras: [],
      frequency: "onetime",
    });
    const weekly = await caller.booking.calculate({
      type: "deep",
      bedrooms: 1,
      bathrooms: 1,
      sqft: 800,
      extras: [],
      frequency: "weekly",
    });
    expect(weekly.total).toBeLessThan(onetime.total);
  });

  it("rejects invalid quote input", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(
      // @ts-expect-error intentionally invalid cleaning type
      caller.booking.calculate({ type: "invalid", bedrooms: 1, bathrooms: 1, sqft: 800, extras: [], frequency: "onetime" })
    ).rejects.toThrow();
  });
});
