/**
 * The build-info stamper runs TWICE for a production deploy: once here at
 * checkpoint time (git present), and again inside the deploy image (git
 * absent, because the build context is `git archive HEAD`). The first run is
 * the only one that can know the commit, so the second must not clobber it.
 *
 * This test exists because that exact regression shipped: production's first
 * /api/version reported commit "unknown" for precisely this reason.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "write-build-info.mjs");

/** Runs the stamper in a throwaway tree, optionally with `git` made to fail. */
function runStamper(options: { seed?: string; withGit: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "buildinfo-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  cpSync(SCRIPT, join(dir, "scripts", "write-build-info.mjs"));
  if (options.seed !== undefined) {
    writeFileSync(join(dir, "shared", "buildInfo.ts"), options.seed);
  }

  let path = process.env.PATH ?? "";
  if (!options.withGit) {
    // A `git` that always fails, shadowing the real one — the deploy image has
    // no .git, so every git invocation there errors out the same way.
    const shim = join(dir, "bin");
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "git"), "#!/bin/sh\nexit 127\n");
    chmodSync(join(shim, "git"), 0o755);
    path = `${shim}:${path}`;
  }

  execFileSync(process.execPath, ["scripts/write-build-info.mjs"], {
    cwd: dir,
    env: { ...process.env, PATH: path },
    stdio: "ignore",
  });
  return readFileSync(join(dir, "shared", "buildInfo.ts"), "utf8");
}

const seeded = (commit: string, branch = "main") =>
  `export const BUILD_INFO = {\n  commit: "${commit}",\n  branch: "${branch}",\n  builtAt: "2020-01-01T00:00:00.000Z",\n} as const;\n`;

describe("write-build-info stamper", () => {
  it("keeps the previously stamped commit when git is unavailable", () => {
    const out = runStamper({ seed: seeded("d6af22d662f7fd4903f8484770df4c02ae2b1c1f"), withGit: false });
    expect(out).toContain('commit: "d6af22d662f7fd4903f8484770df4c02ae2b1c1f"');
    expect(out).not.toContain('commit: "unknown"');
  });

  it("keeps the previously stamped branch when git is unavailable", () => {
    const out = runStamper({ seed: seeded("abc123", "release"), withGit: false });
    expect(out).toContain('branch: "release"');
  });

  it("refreshes builtAt on every run, so a stale image is visible", () => {
    const out = runStamper({ seed: seeded("abc123"), withGit: false });
    expect(out).not.toContain('builtAt: "2020-01-01T00:00:00.000Z"');
  });

  it("falls back to unknown only when nothing knows the commit", () => {
    const out = runStamper({ withGit: false });
    expect(out).toContain('commit: "unknown"');
  });

  it("does not treat a previous unknown as a real commit to preserve", () => {
    const out = runStamper({ seed: seeded("unknown", "unknown"), withGit: false });
    expect(out).toContain('commit: "unknown"');
  });

  it("prefers git over the seeded value when git is available", () => {
    // The throwaway tree is not a repository, so `git rev-parse HEAD` there
    // reports the SHA of whatever repo encloses /tmp — normally none. What
    // this pins is the precedence rule itself: run the stamper inside THIS
    // repository, where git does resolve, and the seeded placeholder must
    // lose to the real HEAD.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }).toString().trim();
    const before = readFileSync(join(process.cwd(), "shared", "buildInfo.ts"), "utf8");
    try {
      writeFileSync(
        join(process.cwd(), "shared", "buildInfo.ts"),
        seeded("0000000000000000000000000000000000000000")
      );
      execFileSync(process.execPath, [SCRIPT], { cwd: process.cwd(), stdio: "ignore" });
      const out = readFileSync(join(process.cwd(), "shared", "buildInfo.ts"), "utf8");
      expect(out).toContain(`commit: "${head}"`);
    } finally {
      writeFileSync(join(process.cwd(), "shared", "buildInfo.ts"), before);
    }
  });
});
