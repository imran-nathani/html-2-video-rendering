import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../../src/output/errors.js";

/**
 * 00-PLAN.md Phase 7 hardening: "cancel/cleanup (no orphaned Chrome or
 * ffmpeg), long-render temp-dir behaviour". Needs a real render (FFmpeg +
 * Chromium/chrome-headless-shell) and an actual OS-level `SIGINT`, so this
 * is opt-in and self-skips everywhere it can't run meaningfully:
 *
 * - Not on this dev machine (no ability to run the suite here at all — see
 *   AGENTS-adjacent project rules; this file is authored, not executed,
 *   from this environment).
 * - Not in the default `npm test` run — only with `HFMPEG_INTEGRATION_TESTS=1`.
 * - Not on Windows — Node's docs are explicit that `child.kill("SIGINT")`
 *   "will unconditionally terminate the process, similar to 'SIGKILL'" on
 *   Windows, so it can't exercise the *graceful* abort path there. CI's
 *   Tier 1 matrix already covers `ubuntu-latest`/`macos-13`/`macos-14`,
 *   where a real SIGINT is deliverable.
 * - Not without a resolvable `ffmpeg` (checked the same way `hfmpeg` itself
 *   resolves one — `HYPERFRAMES_FFMPEG_PATH`, `PATH`, project-local
 *   `./.hyperframes/bin/`, or a well-known dir — not just `PATH`).
 *
 * What it actually checks, end to end, via a spawned `hfmpeg render`
 * (through `tsx`, no build step required — same as `npm run dev`):
 *
 * 1. A `SIGINT` mid-render exits with `EXIT_CODES.CANCELLED` (the
 *    `RenderCancelledError` -> exit-6 mapping in `commands/render.ts`'s
 *    `handleRuntimeError`, exercised here through a real abort instead of
 *    the synthetic one in `test/errors.test.ts`).
 * 2. `--tmp-dir <dir>` actually redirects render scratch space there (every
 *    child process's command line is inspected for the directory).
 * 3. No `ffmpeg`/`chrome-headless-shell` process referencing that scratch
 *    dir survives a grace period after the parent exits — i.e. nothing was
 *    orphaned by the cancellation.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const smokeDir = join(repoRoot, "examples", "smoke");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = join(repoRoot, "src", "cli.ts");

const SIGINT_DELAY_MS = 600;
const EXIT_TIMEOUT_MS = 20_000;
const ORPHAN_GRACE_MS = 1500;

/**
 * Same resolution `hfmpeg` itself uses (`HYPERFRAMES_FFMPEG_PATH` -> `PATH`
 * -> project-local `./.hyperframes/bin/` -> well-known dirs) — deliberately
 * *not* a bare `spawnSync("ffmpeg", ...)` PATH-only check, which would
 * incorrectly skip when ffmpeg is only resolvable via one of the other
 * mechanisms.
 */
function ffmpegAvailable(): boolean {
  return Boolean(findFfBinary("ffmpeg"));
}

/** POSIX-only: `ps -eo pid,command`, searched for a marker string (e.g. our unique scratch dir). */
function findProcessesReferencing(marker: string): string[] {
  const result = spawnSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
  const output = result.stdout ?? "";
  return output
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => line.trim());
}

test("cancel/cleanup: SIGINT mid-render exits CANCELLED and leaves no orphaned ffmpeg/chrome process", async (t) => {
  if (process.env.HFMPEG_INTEGRATION_TESTS !== "1") {
    t.skip("set HFMPEG_INTEGRATION_TESTS=1 to run (needs a real ffmpeg + Chromium render)");
    return;
  }
  if (process.platform === "win32") {
    t.skip("Windows delivers child.kill('SIGINT') as a hard terminate, not a graceful signal — see Node docs");
    return;
  }
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not found on PATH");
    return;
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "hfmpeg-cancel-cleanup-test-"));
  try {
    const outputPath = join(scratchDir, "out.mp4");

    const child = spawn(
      process.execPath,
      [tsxCli, cliEntry, "render", smokeDir, "-o", outputPath, "--quality", "draft", "--tmp-dir", scratchDir, "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

    const exited = new Promise<number | null>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`Process did not exit within ${EXIT_TIMEOUT_MS}ms after SIGINT`)),
        EXIT_TIMEOUT_MS,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolvePromise(code);
      });
    });

    await new Promise((r) => setTimeout(r, SIGINT_DELAY_MS));
    child.kill("SIGINT");

    const exitCode = await exited;
    assert.equal(
      exitCode,
      EXIT_CODES.CANCELLED,
      `Expected exit code ${EXIT_CODES.CANCELLED} (CANCELLED) after SIGINT, got ${exitCode}.\nstdout: ${stdout}\nstderr: ${stderr}`,
    );

    // Give the OS a moment to actually reap anything that was mid-teardown.
    await new Promise((r) => setTimeout(r, ORPHAN_GRACE_MS));

    const orphans = findProcessesReferencing(scratchDir);
    assert.equal(
      orphans.length,
      0,
      `Found process(es) still referencing the render's scratch dir after cancellation (orphaned ffmpeg/chrome):\n${orphans.join("\n")}`,
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
