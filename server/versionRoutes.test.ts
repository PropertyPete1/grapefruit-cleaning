/**
 * /api/version is the deploy-verification contract: every deploy report quotes
 * its output from production. These tests pin the response shape and the
 * no-cache posture, because a silently-renamed field or a cached response
 * would quietly turn that proof back into guesswork.
 *
 * Uses the same stub-Express pattern as balanceLink.test.ts rather than
 * pulling in supertest — no new dependency for one route.
 */
import type { Express, Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { buildVersionInfo, registerVersionRoutes } from "./versionRoutes";

type Handler = (req: Request, res: Response) => unknown;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const capture = (_path: string, ...rest: unknown[]) => {
    handler = rest[rest.length - 1] as Handler;
  };
  registerVersionRoutes({ get: capture } as unknown as Express);
  if (!handler) throw new Error("no route registered");
  return handler;
}

function fakeRes() {
  const res = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    set(key: string, value: string) {
      res.headers[key.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function callRoute() {
  const res = fakeRes();
  captureHandler()({} as Request, res as unknown as Response);
  return res;
}

describe("GET /api/version", () => {
  it("returns the parent commit, boot time, uptime, and environment", () => {
    const body = callRoute().body as Record<string, unknown>;
    expect(body).toMatchObject({
      parentCommit: expect.any(String),
      shortParentCommit: expect.any(String),
      startedAt: expect.any(String),
      uptimeSeconds: expect.any(Number),
      env: expect.any(String),
    });
  });

  it("reports a real 40-char SHA that the short form prefixes", () => {
    const { parentCommit: commit, shortParentCommit: shortCommit } = callRoute().body as {
      parentCommit: string;
      shortParentCommit: string;
    };
    if (commit === "unknown") {
      // Built outside the pipeline (bare checkout): degrade honestly rather
      // than inventing a SHA.
      expect(shortCommit).toBe("unknown");
    } else {
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(shortCommit).toHaveLength(7);
      expect(commit.startsWith(shortCommit)).toBe(true);
    }
  });

  it("names the SHA field parentCommit — a commit cannot embed its own hash", () => {
    // Guards the naming itself: reverting to `commit` would revive the
    // "production is one commit behind" misreading this rename exists to kill.
    const body = callRoute().body as Record<string, unknown>;
    expect(body).not.toHaveProperty("commit");
    expect(body).toHaveProperty("parentCommit");
  });

  it("is never cached — a stale answer would defeat the endpoint's purpose", () => {
    expect(callRoute().headers["cache-control"]).toContain("no-store");
  });

  it("emits startedAt as an ISO-8601 instant", () => {
    const { startedAt } = callRoute().body as { startedAt: string };
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
  });

  it("holds startedAt fixed across calls — it is the process boot, not now()", async () => {
    const first = buildVersionInfo();
    await new Promise(r => setTimeout(r, 20));
    expect(buildVersionInfo().startedAt).toBe(first.startedAt);
  });

  it("counts uptime forward from boot", () => {
    const boot = Date.parse(buildVersionInfo().startedAt);
    expect(buildVersionInfo(new Date(boot + 5_000)).uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  it("never reports negative uptime when clocks disagree", () => {
    const boot = Date.parse(buildVersionInfo().startedAt);
    expect(buildVersionInfo(new Date(boot - 60_000)).uptimeSeconds).toBe(0);
  });
});
