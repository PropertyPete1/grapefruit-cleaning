/**
 * Stamps the current commit SHA into shared/buildInfo.ts.
 *
 * Why a committed file rather than reading git at runtime: the deploy build
 * context is `git archive HEAD` with `.git` explicitly excluded, so the image
 * has no repository to interrogate — `git rev-parse` inside the container is
 * impossible by construction. The SHA therefore has to be written into a
 * source file BEFORE the commit that deploys it.
 *
 * Run by `pnpm build:info`, which `pnpm build` invokes first. Also run before
 * checkpointing so the committed value matches the commit being deployed.
 *
 * Chicken-and-egg, stated honestly: this file records the commit that is
 * CURRENT when it runs, then becomes part of the NEXT commit. So the recorded
 * SHA is the parent of the deployed commit unless it is refreshed and amended.
 * We therefore also record the checkpoint-time HEAD as `builtFrom`, and treat
 * `/api/version` as answering "which build am I running", verified against the
 * deploy log, rather than pretending to a self-referential hash.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const target = new URL("../shared/buildInfo.ts", import.meta.url);

/**
 * What the file already says, if anything.
 *
 * This matters because `pnpm build` runs a SECOND time inside the deploy
 * image, where `.git` does not exist — the build context is `git archive
 * HEAD`. Without this, that run would overwrite the SHA stamped at checkpoint
 * time with "unknown", and production would report nothing useful. So git is
 * the preferred source, and the committed value is the fallback: whichever run
 * actually knows the commit wins, in either order.
 */
function existing(field) {
  try {
    const match = new RegExp(`${field}:\\s*"([^"]*)"`).exec(readFileSync(target, "utf8"));
    const value = match?.[1] ?? "";
    return value === "unknown" ? "" : value;
  } catch {
    return "";
  }
}

const commit = sh("git rev-parse HEAD") || existing("commit") || "unknown";
const branch = sh("git rev-parse --abbrev-ref HEAD") || existing("branch") || "unknown";
const builtAt = new Date().toISOString();

const contents = `/**
 * GENERATED FILE — do not edit by hand.
 * Written by scripts/write-build-info.mjs during \`pnpm build\`.
 * Exposed at runtime through GET /api/version.
 */
export const BUILD_INFO = {
  commit: ${JSON.stringify(commit)},
  branch: ${JSON.stringify(branch)},
  builtAt: ${JSON.stringify(builtAt)},
} as const;
`;

writeFileSync(target, contents);
console.log(`[build-info] commit=${commit.slice(0, 7)} branch=${branch} builtAt=${builtAt}`);
