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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildVersionInfo,
  registerVersionRoutes,
  envShape,
  ENV_VISIBILITY_NAMES,
} from "./versionRoutes";

type Handler = (req: Request, res: Response) => unknown;

function captureRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const capture = (path: string, ...rest: unknown[]) => {
    routes.set(path, rest[rest.length - 1] as Handler);
  };
  registerVersionRoutes({ get: capture } as unknown as Express);
  if (routes.size === 0) throw new Error("no route registered");
  return routes;
}

function captureHandler(path = "/api/version"): Handler {
  const handler = captureRoutes().get(path);
  if (!handler) throw new Error(`no route registered for ${path}`);
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

function callRoute(path = "/api/version") {
  const res = fakeRes();
  captureHandler(path)({} as Request, res as unknown as Response);
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

describe("GET /api/version/env-visibility", () => {
  const NAME = "BRAIN_READ_TOKEN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[NAME];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[NAME];
    else process.env[NAME] = saved;
  });

  function report() {
    const body = callRoute("/api/version/env-visibility").body as {
      env: Record<string, { defined: boolean; shape: string; untrimmed?: boolean }>;
      checkedAt: string;
    };
    return body;
  }

  it("reports an absent variable as undefined", () => {
    delete process.env[NAME];
    expect(report().env[NAME]).toEqual({ defined: false, shape: "undefined" });
  });

  it("reports a present variable's coarse shape without any of its content", () => {
    process.env[NAME] = "0b7f3a".repeat(11); // 66 chars
    const entry = report().env[NAME]!;
    expect(entry.defined).toBe(true);
    expect(entry.shape).toBe("64-plus-chars");
    // The whole serialized response must not contain the value, any prefix of
    // it, or a digest of it. This is the property that makes the endpoint safe
    // to leave unauthenticated.
    const serialized = JSON.stringify(report());
    expect(serialized).not.toContain("0b7f3a");
    expect(serialized).not.toContain(process.env[NAME]!.slice(0, 4));
  });

  it("distinguishes an empty string from an absent variable", () => {
    process.env[NAME] = "";
    // An empty secret is a real misconfiguration that behaves exactly like an
    // absent one at runtime, so the report must not collapse the two.
    expect(report().env[NAME]).toEqual({ defined: true, shape: "empty-string" });
  });

  it("flags stray whitespace, which compares unequal while looking correct", () => {
    process.env[NAME] = " token-with-space ";
    const entry = report().env[NAME]!;
    expect(entry.untrimmed).toBe(true);
    expect(entry.defined).toBe(true);
  });

  it("omits the whitespace flag for a clean value", () => {
    process.env[NAME] = "cleanvalue";
    expect(report().env[NAME]!.untrimmed).toBeUndefined();
  });

  it("reports only the hardcoded names, never the whole environment", () => {
    process.env.SOME_UNRELATED_SECRET = "should-not-appear";
    const body = report();
    expect(Object.keys(body.env).sort()).toEqual([...ENV_VISIBILITY_NAMES].sort());
    expect(JSON.stringify(body)).not.toContain("should-not-appear");
    delete process.env.SOME_UNRELATED_SECRET;
  });

  it("is not cached, so it always describes the live process", () => {
    expect(callRoute("/api/version/env-visibility").headers["cache-control"]).toContain("no-store");
  });
});

describe("envShape", () => {
  it("buckets by length without revealing exact lengths", () => {
    expect(envShape(undefined)).toBe("undefined");
    expect(envShape("")).toBe("empty-string");
    expect(envShape("a".repeat(15))).toBe("under-16-chars");
    expect(envShape("a".repeat(16))).toBe("16-31-chars");
    expect(envShape("a".repeat(31))).toBe("16-31-chars");
    expect(envShape("a".repeat(32))).toBe("32-63-chars");
    expect(envShape("a".repeat(63))).toBe("32-63-chars");
    expect(envShape("a".repeat(64))).toBe("64-plus-chars");
  });
});
