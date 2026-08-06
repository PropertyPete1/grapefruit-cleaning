/**
 * The guard that keeps the suite deterministic.
 *
 * publicOrigin(), emails.ts and db.ts read deployment environment variables
 * directly. When the surrounding shell has them set — as the deploy
 * environment does — tests written against the *unconfigured* fallback quietly
 * exercise a different branch and fail. vitest.setup.ts clears them before
 * every test file; this pins that so the guard can't be dropped or drift out of
 * step with what the code actually reads.
 */
import { describe, expect, it } from "vitest";

import { GUARDED_ENV_KEYS } from "./vitest.setup";

describe("test environment guard", () => {
  it("clears every guarded variable, whatever the shell exported", () => {
    for (const key of GUARDED_ENV_KEYS) {
      expect(process.env[key], `${key} leaked into the test run`).toBeUndefined();
    }
  });

  it("covers PUBLIC_BASE_URL, the one the deploy environment actually sets", () => {
    expect(GUARDED_ENV_KEYS).toContain("PUBLIC_BASE_URL");
    expect(process.env.PUBLIC_BASE_URL).toBeUndefined();
  });

  it("covers DATABASE_URL, so no test can reach a real database", () => {
    expect(GUARDED_ENV_KEYS).toContain("DATABASE_URL");
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
