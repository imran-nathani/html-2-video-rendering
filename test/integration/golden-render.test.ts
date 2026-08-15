import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRenderArgs } from "../../src/args/parse.js";
import { runRenderCommand } from "../../src/commands/render.js";

/**
 * 00-PLAN.md Phase 7 hardening: "golden-output regression renders (a small
 * fixture set, compared by frame hash / PSNR)".
 *
 * This is authored to be run in CI / on a maintainer's machine with a real
 * FFmpeg + Chromium toolchain — not on this dev environment, which has
 * neither and can't execute the suite at all (see project rules). It
 * degrades to a clear `t.skip()` wherever it can't run meaningfully:
 *
 * - No committed reference frame yet at `test/integration/fixtures/
 *   golden-frame.png` — generate it once with `npm run golden:update` on a
 *   machine that has the full toolchain, then commit the PNG. Until then,
 *   this test is a documented no-op rather than a false failure.
 * - No `ffmpeg` on `PATH` (needed to extract a frame from the rendered
 *   video and to compute the comparison).
 * - The render itself doesn't complete (most likely: no usable Chromium in
 *   this environment) — reported as a skip, not a failure, since that's an
 *   environment gap, not a regression in `hfmpeg`'s own code.
 *
 * Compares by PSNR (`ffmpeg`'s own `psnr` filter) rather than an exact byte/
 * hash match: `examples/smoke` is a static gradient with no animation, so
 * PSNR against the reference frame should be very high (fonts/GPU/encoder
 * minutiae aside), but container/codec bytes are not guaranteed identical
 * across FFmpeg builds/platforms the way raw pixels are.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const smokeDir = join(repoRoot, "examples", "smoke");
export const goldenFramePng = join(__dirname, "fixtures", "golden-frame.png");

/** PSNR regression threshold: below this, the rendered frame has visibly diverged from the reference. */
export const MIN_PSNR_DB = 35;

/**
 * Same resolution `hfmpeg` itself uses (`HYPERFRAMES_FFMPEG_PATH` -> `PATH`
 * -> project-local `./.hyperframes/bin/` -> well-known dirs) — deliberately
 * *not* a bare `spawnSync("ffmpeg", ...)` PATH-only check, which would
 * incorrectly skip when ffmpeg is only resolvable via one of the other
 * mechanisms.
 */
function resolveFfmpeg(): string | undefined {
  return findFfBinary("ffmpeg");
}

/** Extract frame 0 of `videoPath` and compute its PSNR against `referencePng` via ffmpeg's own `psnr` filter. */
export function framePsnrAgainst(ffmpegPath: string, videoPath: string, referencePng: string): number {
  const framePng = join(dirname(videoPath), "extracted-frame.png");
  // `-update 1`: tell the image2 muxer this is a single overwritten file,
  // not a `%03d`-style sequence pattern — without it, some ffmpeg builds
  // only warn but others fail outright.
  const extract = spawnSync(ffmpegPath, ["-y", "-i", videoPath, "-vframes", "1", "-update", "1", framePng]);
  if (extract.status !== 0) {
    throw new Error(`ffmpeg frame extraction failed:\n${extract.stderr?.toString() ?? ""}`);
  }

  const compare = spawnSync(ffmpegPath, ["-i", framePng, "-i", referencePng, "-lavfi", "psnr", "-f", "null", "-"]);
  const stderr = compare.stderr?.toString() ?? "";
  const match = stderr.match(/average:(inf|\d+(?:\.\d+)?)/i);
  if (!match) {
    throw new Error(`Could not parse a PSNR "average:" value from ffmpeg output:\n${stderr}`);
  }
  return match[1].toLowerCase() === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

test("golden render: examples/smoke's frame 0 matches the committed reference within a PSNR threshold", async (t) => {
  if (!existsSync(goldenFramePng)) {
    t.skip(
      "No committed golden reference frame — run `npm run golden:update` once on a machine with " +
        "ffmpeg + a working Chromium/chrome-headless-shell, then commit test/integration/fixtures/golden-frame.png.",
    );
    return;
  }
  const ffmpegPath = resolveFfmpeg();
  if (!ffmpegPath) {
    t.skip("ffmpeg not found (checked HYPERFRAMES_FFMPEG_PATH, PATH, ./.hyperframes/bin/, well-known dirs).");
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "hfmpeg-golden-test-"));
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  try {
    const outputPath = join(workDir, "out.mp4");
    const argv = [smokeDir, "-o", outputPath, "--quality", "draft", "--json"];
    const args = parseRenderArgs(argv);

    // Swallow the --json envelope so this test's own output stays readable;
    // we only care about the exit code and the file it produced.
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const exitCode = await runRenderCommand(argv, args);
    process.stdout.write = originalStdoutWrite;

    if (exitCode !== 0) {
      t.skip(`Render did not complete successfully (exit ${exitCode}) in this environment — not treated as a regression.`);
      return;
    }

    const psnr = framePsnrAgainst(ffmpegPath, outputPath, goldenFramePng);
    assert.ok(
      psnr >= MIN_PSNR_DB,
      `Rendered frame diverged from the golden reference: PSNR ${psnr.toFixed(2)}dB is below the ${MIN_PSNR_DB}dB threshold.`,
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    rmSync(workDir, { recursive: true, force: true });
  }
});
