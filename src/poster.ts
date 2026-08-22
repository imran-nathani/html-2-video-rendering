import { usageError } from "./output/errors.js";

/**
 * Planning for `render --poster <time>`: a single still frame at a chosen
 * time, without paying for a full capture pass.
 *
 * **Why it works this way.** The producer exposes no frame-range or
 * single-frame entry point — `RenderConfig` has no `frameRange`, and the
 * internal one (`captureStage`'s `frameRange`, used by the distributed chunk
 * path) isn't reachable from the public API. Driving the capture primitives
 * directly (`createCaptureSession`/`captureFrame`, which *are* exported)
 * would skip the compile stage — variable injection, font inlining,
 * sub-composition assembly, media localization — and quietly produce a
 * poster that doesn't match the render. That is precisely the
 * "succeeds with wrong output" failure this CLI tries to eliminate, so it
 * is not an option.
 *
 * **What it does instead.** It runs the real pipeline, but at a frame rate
 * chosen so that one of the few frames it captures lands *exactly* on the
 * requested time. Captured frame `i` is at `i / fps` (verified empirically
 * against a 30 fps baseline: the pixel at t=2.0s is identical either way),
 * so `fps = i / t` puts frame `i` on `t`. Cost is therefore proportional to
 * `duration / t` frames rather than `duration × fps` — two frames instead
 * of 144 for a mid-duration poster.
 *
 * The trade-off, stated plainly: frames `0..i-1` are still captured and
 * thrown away, because there is no way to ask for only frame `i`. A
 * genuine frame-range API upstream would make this exact.
 */
export interface PosterPlan {
  /** Capture frame rate as an exact rational. */
  fps: { num: number; den: number };
  /** Index (0-based) of the captured frame that lands on the requested time. */
  frameIndex: number;
  /** How many frames the pipeline will capture at this fps. */
  totalFrames: number;
  /** The resolved poster time in seconds. */
  timeSeconds: number;
}

/**
 * `--poster auto`: the middle of the composition.
 *
 * A naive "frame 0" poster is frequently blank — an entrance animation
 * hasn't started yet, so the first frame of a lower third is 100%
 * transparent. Mid-duration is the cheap heuristic that is almost always
 * showing something.
 */
export function resolveAutoPosterTime(durationSeconds: number): number {
  return durationSeconds / 2;
}

/**
 * Parse `--poster <value>`: `auto`, or a time in seconds (`2`, `2.4`,
 * `0.5s`). Rejected rather than clamped when out of range — silently
 * posterizing a different moment than the one asked for is the kind of
 * quiet substitution this CLI avoids.
 */
export function parsePosterTime(raw: string, durationSeconds: number): number {
  const value = raw.trim().toLowerCase();
  if (value === "auto") return resolveAutoPosterTime(durationSeconds);

  const seconds = Number(value.endsWith("s") ? value.slice(0, -1) : value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw usageError(
      `Invalid --poster "${raw}". Expected "auto" or a time in seconds (e.g. 2, 2.4, 0.5s).`,
    );
  }
  if (seconds >= durationSeconds) {
    throw usageError(
      `--poster ${raw} is at or past the composition's ${durationSeconds}s duration.`,
      "The last frame of an N-second composition is just before N; pass a smaller time or use --poster auto.",
    );
  }
  return seconds;
}

/**
 * Pick the cheapest capture frame rate that puts a frame exactly on
 * `timeSeconds`.
 *
 * `fps = i / t` lands frame `i` on `t` for any integer `i >= 1`, and the
 * pipeline captures `round(duration × fps)` frames — so the smallest `i`
 * gives the fewest frames. `i = 1` is not always usable: for a late poster
 * (`t > ~2/3` of the duration) `round(duration / t)` rounds down to `1`, and
 * a single captured frame is frame 0, not the one we want. Walking `i`
 * upward finds the first rate that actually captures our frame.
 *
 * `fallbackFps` is the rate the render would otherwise have used. If the
 * search somehow can't beat it (a poster time so early that `duration / t`
 * exceeds a full capture), we use it directly and take the nearest frame —
 * never more work than the plain render the user could have run.
 */
export function planPosterCapture(
  durationSeconds: number,
  timeSeconds: number,
  fallbackFps: { num: number; den: number },
): PosterPlan {
  const fallbackRate = fallbackFps.num / fallbackFps.den;
  const fallbackFrames = Math.round(durationSeconds * fallbackRate);

  // Millisecond-integer denominators keep fps an exact rational (no
  // 1/3-second decimal drift into the FFmpeg `-r` argument).
  const timeMs = Math.round(timeSeconds * 1000);

  if (timeMs === 0) {
    // Frame 0 exists at any rate; the cheapest is one that captures a single
    // frame — i.e. one frame per composition.
    const durationMs = Math.max(1, Math.round(durationSeconds * 1000));
    return {
      fps: { num: 1000, den: durationMs },
      frameIndex: 0,
      totalFrames: Math.max(1, Math.round((durationSeconds * 1000) / durationMs)),
      timeSeconds,
    };
  }

  for (let i = 1; i <= 240; i += 1) {
    const fps = { num: i * 1000, den: timeMs };
    const totalFrames = Math.round((durationSeconds * fps.num) / fps.den);
    // Need our frame to actually be captured: indices run 0..totalFrames-1.
    if (totalFrames <= i) continue;
    if (totalFrames >= fallbackFrames) break;
    return { fps, frameIndex: i, totalFrames, timeSeconds };
  }

  return {
    fps: fallbackFps,
    frameIndex: Math.min(Math.max(0, Math.round(timeSeconds * fallbackRate)), Math.max(0, fallbackFrames - 1)),
    totalFrames: fallbackFrames,
    timeSeconds,
  };
}
