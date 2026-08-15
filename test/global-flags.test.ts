import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEnvAliases, applyGlobalFlags, extractGlobalFlags } from "../src/args/global.js";
import { getLogLevel, isVerbose, setLogLevel, setVerbose } from "../src/output/log.js";
import { isColorEnabled, setColorDisabled } from "../src/output/color.js";

/**
 * `applyGlobalFlags` mutates process-wide state (env vars, the `log.ts`/
 * `color.ts` module singletons) by design — it's meant to run once, before
 * any command, in `cli.ts`. Snapshot and restore around every test here so
 * this file doesn't leak state into whatever test file `node:test` runs
 * next in the same process.
 */
function withRestoredGlobalState(run: () => void): void {
  const envSnapshot = { ...process.env };
  const logLevelSnapshot = getLogLevel();
  const verboseSnapshot = isVerbose();
  try {
    run();
  } finally {
    for (const key of [
      "TMPDIR",
      "TEMP",
      "TMP",
      "NO_COLOR",
      "HFMPEG_CACHE_DIR",
      "HFMPEG_FFMPEG_PATH",
      "HFMPEG_FFPROBE_PATH",
      "HFMPEG_CHROMIUM_PATH",
      "HYPERFRAMES_FFMPEG_PATH",
      "HYPERFRAMES_FFPROBE_PATH",
      "PRODUCER_HEADLESS_SHELL_PATH",
    ]) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    setLogLevel(logLevelSnapshot);
    setVerbose(verboseSnapshot);
    setColorDisabled(false);
  }
}

test("extractGlobalFlags: defaults when none are passed", () => {
  const { flags, rest } = extractGlobalFlags(["render", "./dir", "-o", "out.mp4"]);
  assert.equal(flags.verbose, false);
  assert.equal(flags.noColor, false);
  assert.equal(flags.logLevel, "info");
  assert.equal(flags.tmpDir, undefined);
  assert.equal(flags.cacheDir, undefined);
  assert.deepEqual(rest, ["render", "./dir", "-o", "out.mp4"]);
});

test("extractGlobalFlags: strips global flags from any position, preserving the rest", () => {
  const { flags, rest } = extractGlobalFlags([
    "--verbose",
    "render",
    "./dir",
    "--log-level",
    "debug",
    "-o",
    "out.mp4",
    "--no-color",
    "--tmp-dir",
    "/scratch",
    "--cache-dir",
    "/cache",
  ]);
  assert.equal(flags.verbose, true);
  assert.equal(flags.noColor, true);
  assert.equal(flags.logLevel, "debug");
  assert.equal(flags.tmpDir, "/scratch");
  assert.equal(flags.cacheDir, "/cache");
  assert.deepEqual(rest, ["render", "./dir", "-o", "out.mp4"]);
});

test("extractGlobalFlags: rejects an invalid --log-level", () => {
  assert.throws(() => extractGlobalFlags(["--log-level", "verbose"]));
});

test("extractGlobalFlags: rejects a value-flag with a missing value", () => {
  assert.throws(() => extractGlobalFlags(["--tmp-dir"]));
  assert.throws(() => extractGlobalFlags(["--cache-dir"]));
  assert.throws(() => extractGlobalFlags(["--log-level"]));
});

test("applyGlobalFlags: --tmp-dir sets TMPDIR (and TEMP/TMP on win32), creating the dir if missing", () => {
  withRestoredGlobalState(() => {
    const base = mkdtempSync(join(tmpdir(), "hfmpeg-global-flags-test-"));
    const target = join(base, "does", "not", "exist", "yet");
    try {
      applyGlobalFlags({ verbose: false, noColor: false, logLevel: "info", tmpDir: target });
      assert.ok(existsSync(target));
      assert.equal(process.env.TMPDIR, target);
      if (process.platform === "win32") {
        assert.equal(process.env.TEMP, target);
        assert.equal(process.env.TMP, target);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test("applyGlobalFlags: --cache-dir sets HFMPEG_CACHE_DIR", () => {
  withRestoredGlobalState(() => {
    applyGlobalFlags({ verbose: false, noColor: false, logLevel: "info", cacheDir: "some/relative/path" });
    assert.ok(process.env.HFMPEG_CACHE_DIR?.endsWith(join("some", "relative", "path")));
  });
});

test("applyGlobalFlags: --no-color disables colour regardless of NO_COLOR", () => {
  withRestoredGlobalState(() => {
    delete process.env.NO_COLOR;
    applyGlobalFlags({ verbose: false, noColor: true, logLevel: "info" });
    // isColorEnabled always returns false once disabled, independent of TTY-ness.
    assert.equal(isColorEnabled({ isTTY: true } as NodeJS.WriteStream), false);
  });
});

test("applyGlobalFlags: --log-level and --verbose configure output/log.ts", () => {
  withRestoredGlobalState(() => {
    applyGlobalFlags({ verbose: false, noColor: false, logLevel: "debug" });
    assert.equal(getLogLevel(), "debug");
    assert.equal(isVerbose(), false);

    applyGlobalFlags({ verbose: true, noColor: false, logLevel: "silent" });
    assert.equal(getLogLevel(), "silent");
    assert.equal(isVerbose(), true);
  });
});

test("applyEnvAliases: HFMPEG_* aliases fill in the upstream var only when it isn't already set", () => {
  withRestoredGlobalState(() => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    delete process.env.HYPERFRAMES_FFPROBE_PATH;
    delete process.env.PRODUCER_HEADLESS_SHELL_PATH;
    process.env.HFMPEG_FFMPEG_PATH = "/alias/ffmpeg";
    process.env.HFMPEG_FFPROBE_PATH = "/alias/ffprobe";
    process.env.HFMPEG_CHROMIUM_PATH = "/alias/chrome-headless-shell";

    applyEnvAliases();

    assert.equal(process.env.HYPERFRAMES_FFMPEG_PATH, "/alias/ffmpeg");
    assert.equal(process.env.HYPERFRAMES_FFPROBE_PATH, "/alias/ffprobe");
    assert.equal(process.env.PRODUCER_HEADLESS_SHELL_PATH, "/alias/chrome-headless-shell");
  });
});

test("applyEnvAliases: an already-set upstream var wins over the HFMPEG_* alias", () => {
  withRestoredGlobalState(() => {
    process.env.HYPERFRAMES_FFMPEG_PATH = "/explicit/ffmpeg";
    process.env.HFMPEG_FFMPEG_PATH = "/alias/ffmpeg";

    applyEnvAliases();

    assert.equal(process.env.HYPERFRAMES_FFMPEG_PATH, "/explicit/ffmpeg");
  });
});
