import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePosterTime, planPosterCapture, resolveAutoPosterTime } from "../src/poster.js";

/**
 * `--poster` planning (`src/poster.ts`). The invariant every case below is
 * really checking: **the captured frame at `frameIndex` must be at exactly
 * the requested time**, i.e. `frameIndex / (fps.num / fps.den) === t`, and
 * that frame must actually be inside the captured range
 * (`frameIndex < totalFrames`). Getting this wrong means silently
 * posterizing a different moment, which is invisible downstream.
 */

const FPS_30 = { num: 30, den: 1 };

function frameTime(plan: { fps: { num: number; den: number }; frameIndex: number }): number {
  return plan.frameIndex / (plan.fps.num / plan.fps.den);
}

test("planPosterCapture: the chosen frame lands exactly on the requested time", () => {
  for (const [duration, time] of [
    [4.8, 2.4],
    [4.8, 0.1],
    [10, 5],
    [12, 7.5],
    [4.8, 4.0], // late poster: i = 1 rounds down to a single frame, must escalate
    [4.8, 4.7],
    [3, 1],
    [1, 0.5],
  ] as const) {
    const plan = planPosterCapture(duration, time, FPS_30);
    assert.ok(
      Math.abs(frameTime(plan) - time) < 1e-9,
      `t=${time}s of ${duration}s: frame ${plan.frameIndex} at ${frameTime(plan)}s`,
    );
    assert.ok(
      plan.frameIndex < plan.totalFrames,
      `t=${time}s of ${duration}s: frame ${plan.frameIndex} is outside the ${plan.totalFrames} captured`,
    );
  }
});

test("planPosterCapture: a mid-duration poster captures a couple of frames, not the whole render", () => {
  const plan = planPosterCapture(4.8, 2.4, FPS_30);
  assert.deepEqual(plan.fps, { num: 1000, den: 2400 });
  assert.equal(plan.frameIndex, 1);
  assert.equal(plan.totalFrames, 2); // vs 144 for the full 30fps render
});

test("planPosterCapture: a late poster escalates until the frame is actually captured", () => {
  // t = 4.0s of 4.8s: at fps = 1/4 the pipeline captures round(1.2) = 1
  // frame, which is frame 0 — not ours. The planner must keep looking.
  const plan = planPosterCapture(4.8, 4.0, FPS_30);
  assert.ok(plan.frameIndex >= 1);
  assert.ok(plan.frameIndex < plan.totalFrames);
  assert.ok(Math.abs(frameTime(plan) - 4.0) < 1e-9);
  assert.ok(plan.totalFrames < 144, `expected fewer frames than a full render, got ${plan.totalFrames}`);
});

test("planPosterCapture: t=0 captures exactly one frame", () => {
  const plan = planPosterCapture(4.8, 0, FPS_30);
  assert.equal(plan.frameIndex, 0);
  assert.equal(plan.totalFrames, 1);
});

test("planPosterCapture: never captures more frames than the plain render would", () => {
  for (const time of [0, 0.01, 0.033, 0.5, 2.4, 4.5]) {
    const plan = planPosterCapture(4.8, time, FPS_30);
    assert.ok(
      plan.totalFrames <= 144,
      `t=${time}s: ${plan.totalFrames} frames exceeds the full render's 144`,
    );
  }
});

test("parsePosterTime: accepts auto, bare seconds, and a trailing s", () => {
  assert.equal(parsePosterTime("auto", 4.8), 2.4);
  assert.equal(parsePosterTime("2.4", 4.8), 2.4);
  assert.equal(parsePosterTime("0.5s", 4.8), 0.5);
  assert.equal(parsePosterTime(" AUTO ", 10), 5);
});

test("parsePosterTime: rejects a time at or past the duration instead of clamping", () => {
  assert.throws(() => parsePosterTime("4.8", 4.8), /duration/);
  assert.throws(() => parsePosterTime("10", 4.8), /duration/);
  assert.throws(() => parsePosterTime("-1", 4.8), /Invalid --poster/);
  assert.throws(() => parsePosterTime("halfway", 4.8), /Invalid --poster/);
});

test("resolveAutoPosterTime: mid-duration, because frame 0 is often blank", () => {
  assert.equal(resolveAutoPosterTime(4.8), 2.4);
});
