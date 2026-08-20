/**
 * Credential validation for BRAIN_READ_TOKEN against the live route stack.
 *
 * The contract tests in brainRoutes.test.ts use a synthetic token, so they pass
 * whether or not the real secret is correct. This exercises the actual value
 * from the environment through the actual auth guard, which is the only way to
 * catch a token that was saved with a typo, a stray space, or not at all.
 *
 * Skips itself when the secret is absent rather than failing: a developer
 * checkout has no reason to hold a production credential, and a test that
 * cannot pass there would just get ignored.
 *
 * The value arrives via __LIVE_BRAIN_READ_TOKEN__, not BRAIN_READ_TOKEN:
 * vitest.setup.ts clears the latter for every test file on purpose, stashing
 * the real one under this name first, so this check can see it without
 * weakening the guard that keeps every other test off real credentials.
 */
import { describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { registerBrainRoutes } from "./brainRoutes";

const TOKEN = process.env.__LIVE_BRAIN_READ_TOKEN__;
const describeIf = TOKEN ? describe : describe.skip;

async function listen(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  // Handlers read the token per request, and the setup guard deleted it, so
  // reinstate the real value for the lifetime of this server only.
  process.env.BRAIN_READ_TOKEN = TOKEN;
  registerBrainRoutes(app);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          delete process.env.BRAIN_READ_TOKEN;
          r();
        })
      ),
  };
}

describeIf("BRAIN_READ_TOKEN (live credential)", () => {
  it("authenticates the real token and returns the business identity", async () => {
    const { url, close } = await listen();
    try {
      const res = await fetch(`${url}/api/brain/ping`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; business?: string };
      expect(body.ok).toBe(true);
      expect(body.business).toBe("Grapefruit Cleaning Co.");
    } finally {
      await close();
    }
  });

  it("rejects a near-miss of the real token", async () => {
    const { url, close } = await listen();
    try {
      // Same length, one character different — the case a length check or a
      // sloppy comparison would wave through.
      const near = TOKEN!.slice(0, -1) + (TOKEN!.endsWith("x") ? "y" : "x");
      const res = await fetch(`${url}/api/brain/ping`, {
        headers: { Authorization: `Bearer ${near}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  /**
   * My first version of this asserted that `Bearer <token> ` (trailing space)
   * is rejected. It is not, and should not be: HTTP field values are trimmed of
   * surrounding whitespace by the transport, so the header never reaches the
   * handler with that space attached. Asserting a 401 there was testing my
   * assumption, not the system.
   *
   * The genuine failure mode is whitespace INSIDE the stored secret — a value
   * pasted with a stray space in the UI. That cannot be trimmed away by the
   * transport, so it must simply not be there.
   */
  it("holds a value with no surrounding whitespace", () => {
    expect(TOKEN).toBe(TOKEN!.trim());
  });

  it("rejects an embedded-space corruption of the real token", async () => {
    const { url, close } = await listen();
    try {
      const corrupted = TOKEN!.slice(0, 4) + " " + TOKEN!.slice(4);
      const res = await fetch(`${url}/api/brain/ping`, {
        headers: { Authorization: `Bearer ${corrupted}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});
