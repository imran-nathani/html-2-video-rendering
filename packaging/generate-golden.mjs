#!/usr/bin/env node
/**
 * Maintainer-run generator for `test/integration/golden-render.test.ts`'s
 * committed reference frame (00-PLAN.md Phase 7 "golden-output regression
 * renders"). Not run in CI, and not run automatically by `npm test` — this
 * is the one-time (or deliberate-update) step that produces the frame that
 * test then guards against regressing.
 *
 * Requires a real, `hfmpeg`-resolvable `ffmpeg` (`HYPERFRAMES_FFMPEG_PATH`,
 * `PATH`, project-local `./.hyperframes/bin/`, or a well-known dir — see
 * `findFfBinary`) and a working Chromium/chrome-headless-shell (i.e. the
 * same environment a real `hfmpeg render` needs) — this is *not* runnable
 * on a machine that lacks either.
 *
 * Usage:
 *   node packaging/generate-golden.mjs
 *   npm run golden:update
 */
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const smokeDir = join(repoRoot, "examples", "smoke");
const fixturesDir = join(repoRoot, "test", "integration", "fixtures");
const goldenPng = join(fixturesDir, "golden-frame.png");

function log(message) {
  process.stdout.write(`[golden] ${message}\n`);
}

/**
 * Same resolution `hfmpeg` itself uses (`HYPERFRAMES_FFMPEG_PATH` -> `PATH`
 * -> project-local `./.hyperframes/bin/` -> well-known dirs) — deliberately
 * *not* a bare `spawnSync("ffmpeg", ...)` PATH-only check, which would
 * incorrectly report "not found" when ffmpeg is only resolvable via one of
 * the other mechanisms (as it is via `.hyperframes/bin/` in this repo's own
 * dev setup).
 */
function resolveFfmpeg() {
  const ffmpegPath = findFfBinary("ffmpeg");
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg not found (checked HYPERFRAMES_FFMPEG_PATH, PATH, ./.hyperframes/bin/, and well-known dirs). " +
        "Run `hfmpeg doctor` to see what's missing.",
    );
  }
  return ffmpegPath;
}

async function main() {
  const ffmpegPath = resolveFfmpeg();
  log(`Using ffmpeg: ${ffmpegPath}`);

  const workDir = mkdtempSync(join(tmpdir(), "hfmpeg-golden-generate-"));
  try {
    const outputPath = join(workDir, "out.mp4");

    log(`Rendering ${smokeDir} -> ${outputPath} (--quality draft)...`);
    // Via tsx, straight from src/ — same as `npm run dev`, no build step
    // required to regenerate the fixture.
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntry = join(repoRoot, "src", "cli.ts");
    const render = spawnSync(
      process.execPath,
      [tsxCli, cliEntry, "render", smokeDir, "-o", outputPath, "--quality", "draft", "--json"],
      { stdio: "inherit" },
    );
    if (render.status !== 0) {
      throw new Error(`hfmpeg render exited ${render.status} — see output above for the failure.`);
    }

    const framePng = join(workDir, "frame.png");
    log("Extracting frame 0...");
    // `-update 1`: tell the image2 muxer this is a single overwritten file,
    // not a `%03d`-style sequence pattern — without it, some ffmpeg builds
    // only warn (as this one did) but others fail outright.
    const extract = spawnSync(
      ffmpegPath,
      ["-y", "-i", outputPath, "-vframes", "1", "-update", "1", framePng],
      { stdio: "inherit" },
    );
    if (extract.status !== 0) throw new Error("ffmpeg frame extraction failed.");

    mkdirSync(fixturesDir, { recursive: true });
    if (existsSync(goldenPng)) {
      log(`Overwriting existing ${goldenPng} — review the diff before committing.`);
    }
    cpSync(framePng, goldenPng);
    log(`Wrote ${goldenPng}. Review it, then commit.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
