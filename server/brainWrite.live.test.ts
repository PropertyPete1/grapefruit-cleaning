import { describe, expect, it } from "vitest";
import { LIVE_BRAIN_TOKEN_KEY, LIVE_BRAIN_WRITE_TOKEN_KEY } from "./vitest.setup";

const runLive = process.env.RUN_LIVE_BRAIN_WRITE_TEST === "1";

describe.skipIf(!runLive)("live Brain write credential", () => {
  it("authenticates independently and reaches validation without writing data", async () => {
    const writeToken = process.env[LIVE_BRAIN_WRITE_TOKEN_KEY];
    const readToken = process.env[LIVE_BRAIN_TOKEN_KEY];
    expect(writeToken).toMatch(/^[a-f0-9]{64}$/);
    expect(writeToken).not.toBe(readToken);

    const baseUrl = process.env.BRAIN_WRITE_TEST_BASE_URL || "http://127.0.0.1:3000";
    const response = await fetch(`${baseUrl}/api/brain/invoices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${writeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "actor is required — every brain write is attributed to the operator who approved it",
    });
  });
});
