/**
 * GET /api/version — what commit is this process actually running?
 *
 * Deploy verification used to rely on fingerprinting the served JS bundle for
 * strings only the new code contains. That worked, but it was inference: it
 * proved a feature was present, not which commit produced it, and it could not
 * survive a build-mode difference between the sandbox and production.
 *
 * The SHA is baked in at build time: scripts/write-build-info.mjs stamps the
 * commit into shared/buildInfo.ts, which esbuild bundles into dist/index.js.
 * That indirection is forced by the deploy contract — the build context is
 * `git archive HEAD` with `.git` excluded, so the image cannot run git itself.
 * A BUILD_COMMIT environment variable, when the pipeline supplies one, takes
 * precedence. Either way the value is resolved at MODULE LOAD, not per
 * request, so what is reported is what the running process started with.
 *
 * Deliberately public and unauthenticated: it exposes nothing sensitive (a
 * commit SHA of a public repo, plus uptime), and gating it behind auth would
 * defeat its purpose of being checkable from anywhere at any time.
 */
import type { Express, Request, Response } from "express";
import { BUILD_INFO } from "../shared/buildInfo";

/**
 * Captured once, at import. `startedAt` is therefore the process boot time,
 * which is the second half of the deploy proof: a genuine restart moves it.
 */
const BOOT_TIME = new Date();
const COMMIT = (process.env.BUILD_COMMIT || BUILD_INFO.commit || "").trim();
const BUILT_AT = (process.env.BUILD_TIME || BUILD_INFO.builtAt || "").trim();
const BRANCH = (BUILD_INFO.branch || "").trim();

export interface VersionInfo {
  /** Full 40-char commit SHA, or "unknown" when built outside the deploy pipeline. */
  commit: string;
  /** First 7 chars, for eyeballing against `git log --oneline`. */
  shortCommit: string;
  /** ISO-8601 timestamp of when this process started. */
  startedAt: string;
  /** Whole seconds this process has been up. */
  uptimeSeconds: number;
  /** ISO-8601 build timestamp, when the pipeline provided one. */
  builtAt: string | null;
  /** Git branch the build came from, when known. */
  branch: string | null;
  /** NODE_ENV of the running process. */
  env: string;
}

export function buildVersionInfo(now: Date = new Date()): VersionInfo {
  const commit = COMMIT || "unknown";
  return {
    commit,
    shortCommit: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    startedAt: BOOT_TIME.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - BOOT_TIME.getTime()) / 1000)),
    builtAt: BUILT_AT || null,
    branch: BRANCH && BRANCH !== "unknown" ? BRANCH : null,
    env: process.env.NODE_ENV || "development",
  };
}

export function registerVersionRoutes(app: Express): void {
  app.get("/api/version", (_req: Request, res: Response) => {
    // No caching: a cached response from the previous deployment would defeat
    // the entire point of asking what is running right now.
    res.set("Cache-Control", "no-store, must-revalidate");
    res.json(buildVersionInfo());
  });
}
