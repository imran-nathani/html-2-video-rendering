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

const RENDER_STARTED_POLL_MS = 25;
const RENDER_STARTED_TIMEOUT_MS = 15_000;
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

/**
 * A fixed post-spawn delay before sending SIGINT is inherently racy: on a
 * cold CI agent (fresh `tsx` transpilation, no warmed module cache) the gap
 * between `spawn()` and `commands/render.ts` actually registering its own
 * `process.once("SIGINT", ...)` handler can exceed any delay chosen here,
 * so the signal lands on a process with no listener and the OS default
 * action kills it — exit 130 (128 + SIGINT), not `EXIT_CODES.CANCELLED`.
 * That's a test-harness race, not a real cancellation bug.
 *
 * Instead, poll for a child process whose command line already references
 * the scratch dir (the same signal `findProcessesReferencing` uses for the
 * orphan check below). By the time ffmpeg/chrome-headless-shell has been
 * spawned with `--tmp-dir`'s path in its argv, `executeRender()` has long
 * since registered its SIGINT handler — that happens before `createRenderJob`
 * even runs, let alone before anything spawns a child process referencing
 * the scratch dir. So this ties the signal to genuine render progress
 * instead of a guessed wall-clock delay.
 */
async function waitUntilRenderStarted(scratchDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findProcessesReferencing(scratchDir).length > 0) return;
    await new Promise((r) => setTimeout(r, RENDER_STARTED_POLL_MS));
  }
  throw new Error(`No process referencing ${scratchDir} appeared within ${timeoutMs}ms — render never started?`);
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

    await waitUntilRenderStarted(scratchDir, RENDER_STARTED_TIMEOUT_MS);
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
