/**
 * The two brain modules over a REAL Express stack, in production registration
 * order (json body parser → registerBrainRoutes → registerBrainWriteRoutes,
 * exactly as _core/index.ts wires them). The unit files pin each module
 * against a stub app; what only this can pin is the interplay the spec calls
 * out — the read module's guard waving POST through to the write module, the
 * write catch-all's PINNED 404 body being reachable at all, and the two
 * token surfaces living independently on one prefix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "http";

const { mockGetBookingById, mockUpdateBooking } = vi.hoisted(() => ({
  mockGetBookingById: vi.fn(),
  mockUpdateBooking: vi.fn(),
}));

// Everything real except the two calls the exercised route reaches — the
// point is the routing fabric, not the database.
vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  getBookingById: mockGetBookingById,
  updateBooking: mockUpdateBooking,
}));

import { _resetRateLimits } from "./antiSpam";
import { registerBrainRoutes } from "./brainRoutes";
import { registerBrainWriteRoutes } from "./brainWriteRoutes";

const READ_TOKEN = "0b7f3a".repeat(11);
const WRITE_TOKEN = "1f9c4e".repeat(11);
const ACTOR = "[via PRIMARY — Karyme]";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerBrainRoutes(app);
  registerBrainWriteRoutes(app);
  server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("BRAIN_READ_TOKEN", READ_TOKEN);
  vi.stubEnv("BRAIN_WRITE_TOKEN", WRITE_TOKEN);
  _resetRateLimits();
  mockGetBookingById.mockResolvedValue({ id: 88, status: "confirmed", notes: null });
  mockUpdateBooking.mockResolvedValue(undefined);
});

const post = (path: string, body: unknown, token: string | null = WRITE_TOKEN) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("the assembled /api/brain stack", () => {
  it("carries a real write end to end through the body parser", async () => {
    const res = await post("/api/brain/bookings/88/cancel", { actor: ACTOR });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockUpdateBooking).toHaveBeenCalledWith(88, {
      status: "cancelled",
      notes: `${ACTOR} cancelled this booking`,
    });
  });

  it("answers an unknown POST path with the PINNED skew signal, not the 405 or the SPA", async () => {
    // The brain client maps exactly this body to "the two sides' paths have
    // skewed" — a 405 here would read as "the write API has not landed".
    const res = await post("/api/brain/bookings/88/resched", { actor: ACTOR });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown brain route" });
  });

  it("still 405s the verbs neither module owns, naming all three allowed", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/brain/bookings`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD, POST");
      expect(await res.json(), method).toEqual({ error: "method not allowed" });
    }
  });

  it("keeps the read surface byte-identical beside the writes", async () => {
    const ping = await fetch(`${base}/api/brain/ping`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true, business: "Grapefruit Cleaning Co." });
    const missing = await fetch(`${base}/api/brain/nope`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown brain endpoint" });
  });

  it("keeps the two tokens independent: reads alive while writes are off, and never crossed", async () => {
    vi.stubEnv("BRAIN_WRITE_TOKEN", "");
    const off = await post("/api/brain/bookings/88/cancel", { actor: ACTOR }, READ_TOKEN);
    expect(off.status).toBe(503);
    const ping = await fetch(`${base}/api/brain/ping`, {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(ping.status).toBe(200);

    vi.stubEnv("BRAIN_WRITE_TOKEN", WRITE_TOKEN);
    const crossed = await post("/api/brain/bookings/88/cancel", { actor: ACTOR }, READ_TOKEN);
    expect(crossed.status).toBe(401);
    expect(mockUpdateBooking).not.toHaveBeenCalled();
  });
});
