import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRenderArgs } from "../src/args/parse.js";
import { buildRenderPlan } from "../src/commands/render.js";

/**
 * `buildRenderPlan` is the pure, browser-free heart of `render` (00-PLAN.md
 * Phase 7 hardening): every mutual-exclusion/range check and every
 * flag -> `RenderConfig`/`EngineConfig` mapping decision lives here, so it's
 * worth covering directly rather than only exercising it end-to-end through
 * an actual render.
 */

test("buildRenderPlan: infers format from the output extension when --format is absent", () => {
  assert.equal(buildRenderPlan(parseRenderArgs(["-o", "out.webm"]), "out.webm").format, "webm");
  assert.equal(buildRenderPlan(parseRenderArgs(["-o", "out.mov"]), "out.mov").format, "mov");
  assert.equal(buildRenderPlan(parseRenderArgs(["-o", "out.gif"]), "out.gif").format, "gif");
  // Unknown/no extension (e.g. a png-sequence directory) falls back to mp4.
  assert.equal(buildRenderPlan(parseRenderArgs(["-o", "out/"]), "out/").format, "mp4");
});

test("buildRenderPlan: an explicit --format wins over the output extension", () => {
  const plan = buildRenderPlan(parseRenderArgs(["--format", "gif", "-o", "out.mp4"]), "out.mp4");
  assert.equal(plan.format, "gif");
});

test("buildRenderPlan: rejects an unknown --format", () => {
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--format", "avi", "-o", "out.avi"]), "out.avi"));
});

test("buildRenderPlan: fps defaults to 30/1, and accepts a rational", () => {
  assert.deepEqual(buildRenderPlan(parseRenderArgs(["-o", "out.mp4"]), "out.mp4").fps, { num: 30, den: 1 });
  assert.deepEqual(
    buildRenderPlan(parseRenderArgs(["--fps", "30000/1001", "-o", "out.mp4"]), "out.mp4").fps,
    { num: 30000, den: 1001 },
  );
});

test("buildRenderPlan: --workers accepts auto or 1..24", () => {
  assert.equal(buildRenderPlan(parseRenderArgs(["-w", "auto", "-o", "out.mp4"]), "out.mp4").workers, "auto");
  assert.equal(buildRenderPlan(parseRenderArgs(["-w", "4", "-o", "out.mp4"]), "out.mp4").workers, 4);
  assert.throws(() => buildRenderPlan(parseRenderArgs(["-w", "0", "-o", "out.mp4"]), "out.mp4"));
  assert.throws(() => buildRenderPlan(parseRenderArgs(["-w", "25", "-o", "out.mp4"]), "out.mp4"));
});

test("buildRenderPlan: --crf and --video-bitrate are mutually exclusive", () => {
  assert.throws(() =>
    buildRenderPlan(parseRenderArgs(["--crf", "20", "--video-bitrate", "8M", "-o", "out.mp4"]), "out.mp4"),
  );
  assert.equal(buildRenderPlan(parseRenderArgs(["--crf", "20", "-o", "out.mp4"]), "out.mp4").crf, 20);
});

test("buildRenderPlan: --vp9-cpu-used only applies to --format webm", () => {
  assert.throws(() =>
    buildRenderPlan(parseRenderArgs(["--vp9-cpu-used", "2", "-o", "out.mp4"]), "out.mp4"),
  );
  const plan = buildRenderPlan(parseRenderArgs(["--vp9-cpu-used", "2", "--format", "webm", "-o", "out.webm"]), "out.webm");
  assert.equal(plan.engineOverrides.vp9CpuUsed, 2);
});

test("buildRenderPlan: --gif-loop only applies to --format gif", () => {
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--gif-loop", "0", "-o", "out.mp4"]), "out.mp4"));
  const plan = buildRenderPlan(parseRenderArgs(["--gif-loop", "0", "--format", "gif", "-o", "out.gif"]), "out.gif");
  assert.equal(plan.gifLoop, 0);
});

test("buildRenderPlan: --hdr and --sdr are mutually exclusive, and --hdr is MP4-only", () => {
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--hdr", "--sdr", "-o", "out.mp4"]), "out.mp4"));
  assert.throws(() =>
    buildRenderPlan(parseRenderArgs(["--hdr", "--format", "webm", "-o", "out.webm"]), "out.webm"),
  );
  assert.equal(buildRenderPlan(parseRenderArgs(["--hdr", "-o", "out.mp4"]), "out.mp4").hdrMode, "force-hdr");
  assert.equal(buildRenderPlan(parseRenderArgs(["--sdr", "-o", "out.mp4"]), "out.mp4").hdrMode, "force-sdr");
});

test("buildRenderPlan: --resolution rejects --hdr and alpha formats", () => {
  assert.throws(() =>
    buildRenderPlan(parseRenderArgs(["--resolution", "landscape", "--hdr", "-o", "out.mp4"]), "out.mp4"),
  );
  assert.throws(() =>
    buildRenderPlan(
      parseRenderArgs(["--resolution", "landscape", "--format", "webm", "-o", "out.webm"]),
      "out.webm",
    ),
  );
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--resolution", "not-a-preset", "-o", "out.mp4"]), "out.mp4"));
});

test("buildRenderPlan: tri-state engine overrides are only set when the flag is passed", () => {
  const untouched = buildRenderPlan(parseRenderArgs(["-o", "out.mp4"]), "out.mp4");
  assert.deepEqual(untouched.engineOverrides, {});

  const set = buildRenderPlan(
    parseRenderArgs([
      "--browser-gpu",
      "--low-memory-mode",
      "--page-side-compositing",
      "--experimental-fast-capture",
      "-o",
      "out.mp4",
    ]),
    "out.mp4",
  );
  assert.equal(set.engineOverrides.browserGpuMode, "hardware");
  assert.equal(set.engineOverrides.lowMemoryMode, true);
  assert.equal(set.engineOverrides.enablePageSideCompositing, true);
  assert.equal(set.engineOverrides.useDrawElement, true);

  const unset = buildRenderPlan(
    parseRenderArgs(["--no-browser-gpu", "--no-low-memory-mode", "-o", "out.mp4"]),
    "out.mp4",
  );
  assert.equal(unset.engineOverrides.browserGpuMode, "software");
  assert.equal(unset.engineOverrides.lowMemoryMode, false);
});

test("buildRenderPlan: --browser-timeout is seconds, converted to milliseconds for pageNavigationTimeout", () => {
  const plan = buildRenderPlan(parseRenderArgs(["--browser-timeout", "30", "-o", "out.mp4"]), "out.mp4");
  assert.equal(plan.engineOverrides.pageNavigationTimeout, 30_000);
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--browser-timeout", "0", "-o", "out.mp4"]), "out.mp4"));
});

test("buildRenderPlan: strictness defaults to best-effort, --no-best-effort makes it strict", () => {
  assert.equal(buildRenderPlan(parseRenderArgs(["-o", "out.mp4"]), "out.mp4").strictness, "best-effort");
  assert.equal(
    buildRenderPlan(parseRenderArgs(["--no-best-effort", "-o", "out.mp4"]), "out.mp4").strictness,
    "strict",
  );
});

test("buildRenderPlan: rejects an invalid --quality", () => {
  assert.throws(() => buildRenderPlan(parseRenderArgs(["--quality", "ultra", "-o", "out.mp4"]), "out.mp4"));
});
