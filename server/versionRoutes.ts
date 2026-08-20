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
 * On naming: the stamper necessarily runs BEFORE the checkpoint commit exists
 * (a commit cannot contain its own hash), so the SHA it captures is the parent
 * of the deployed commit. The field is called `parentCommit` to say so plainly
 * — it still identifies a build uniquely, because consecutive deploys always
 * have different parents, but calling it `commit` invited exactly the
 * misreading of "production is one commit behind".
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
  /**
   * Full 40-char SHA of the commit this build was stamped from — the PARENT of
   * the checkpoint commit now deployed. "unknown" outside the pipeline.
   */
  parentCommit: string;
  /** First 7 chars, for eyeballing against `git log --oneline`. */
  shortParentCommit: string;
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
    parentCommit: commit,
    shortParentCommit: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    startedAt: BOOT_TIME.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - BOOT_TIME.getTime()) / 1000)),
    builtAt: BUILT_AT || null,
    branch: BRANCH && BRANCH !== "unknown" ? BRANCH : null,
    env: process.env.NODE_ENV || "development",
  };
}

/**
 * Coarse shape of a value, for the env-visibility probe. Buckets rather than
 * exact lengths: enough to tell "absent" from "present but wrong sort of
 * thing", not enough to narrow a search space.
 */
export function envShape(v: string | undefined): string {
  if (v === undefined) return "undefined";
  if (v.length === 0) return "empty-string";
  if (v.length < 16) return "under-16-chars";
  if (v.length < 32) return "16-31-chars";
  if (v.length < 64) return "32-63-chars";
  return "64-plus-chars";
}

/** Names are hardcoded so this can never become a listing of the environment. */
export const ENV_VISIBILITY_NAMES = [
  "BRAIN_READ_TOKEN",
  "PUBLIC_BASE_URL",
  "SMTP_HOST",
  "STRIPE_SECRET_KEY",
] as const;

export interface EnvVisibilityEntry {
  defined: boolean;
  shape: string;
  /** True when the value has leading or trailing whitespace. */
  untrimmed?: boolean;
}

/**
 * Value-safe env visibility report.
 *
 * When a secret is saved in the Management UI but the runtime still behaves as
 * if it were absent, two very different causes look identical from outside (a
 * 503): the variable never reached this process, or it reached it holding
 * something unexpected. This distinguishes them using only facts that cannot
 * help reconstruct a value — whether the name is defined, a coarse length
 * bucket, and whether it carries stray whitespace (which compares unequal while
 * looking perfectly correct in the UI).
 *
 * A digest is deliberately NOT exposed: publishing sha256(token) on an
 * unauthenticated endpoint would let anyone verify guesses offline at full
 * speed, which is worse than saying nothing at all.
 */
export function buildEnvVisibility(): Record<string, EnvVisibilityEntry> {
  const report: Record<string, EnvVisibilityEntry> = {};
  for (const name of ENV_VISIBILITY_NAMES) {
    const raw = process.env[name];
    report[name] = {
      defined: raw !== undefined,
      shape: envShape(raw),
      ...(raw !== undefined && raw !== raw.trim() ? { untrimmed: true } : {}),
    };
  }
  return report;
}

export function registerVersionRoutes(app: Express): void {
  app.get("/api/version", (_req: Request, res: Response) => {
    // No caching: a cached response from the previous deployment would defeat
    // the entire point of asking what is running right now.
    res.set("Cache-Control", "no-store, must-revalidate");
    res.json(buildVersionInfo());
  });

  app.get("/api/version/env-visibility", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store, must-revalidate");
    res.json({ env: buildEnvVisibility(), checkedAt: new Date().toISOString() });
  });
}
