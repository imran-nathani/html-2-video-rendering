import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRuntimeError } from "../src/commands/render.js";
import { CliError, EXIT_CODES, toCliError, usageError } from "../src/output/errors.js";

/**
 * `handleRuntimeError` (00-PLAN.md Phase 7 hardening — "cancel/cleanup")
 * maps whatever `executeRenderJob` throws to one of `00-COMMANDS.md`'s
 * stable exit codes. Covered directly since actually triggering a
 * `RenderCancelledError` requires a real render + a `SIGINT` on a machine
 * with FFmpeg/Chromium (see `test/integration/cancel-cleanup.test.ts`).
 */

/** Swallow + capture both streams for the duration of `run()`, so exercising the error-printing path doesn't spam the test runner's own stdout/stderr. */
function withCapturedOutput(run: () => void): string {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let captured = "";
  const capture = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    run();
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return captured;
}

test("handleRuntimeError: a named RenderCancelledError maps to EXIT_CODES.CANCELLED", () => {
  const err = new Error("aborted");
  err.name = "RenderCancelledError";
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.CANCELLED);
});

test("handleRuntimeError: a named RenderQualityError maps to EXIT_CODES.LINT_OR_STRICT_FAILED", () => {
  const err = new Error("quality gate failed");
  err.name = "RenderQualityError";
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.LINT_OR_STRICT_FAILED);
});

test("handleRuntimeError: a RenderQualityError's warnings reach the --json error payload", () => {
  // The producer throws `new RenderQualityError(job.warnings)` and keeps the
  // array on `.warnings`; its only other machine-readable copy is a stderr
  // log line. Without this, attributing a strict-mode failure to a code
  // means regexing the prose message.
  const err = Object.assign(new Error("Render blocked by 1 correctness warning: sub_timeline_script_failure"), {
    name: "RenderQualityError",
    warnings: [
      {
        code: "sub_timeline_script_failure",
        message: "A sub-composition timeline script failed to load",
        stage: "capture-readiness",
        details: { retryable: false },
      },
    ],
  });

  let exitCode: number | undefined;
  const captured = withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });

  assert.equal(exitCode, EXIT_CODES.LINT_OR_STRICT_FAILED);
  const envelope = JSON.parse(captured);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.reason, "correctness_warnings");
  assert.deepEqual(envelope.error.warningCodes, ["sub_timeline_script_failure"]);
  assert.equal(envelope.error.warnings[0].stage, "capture-readiness");
  assert.deepEqual(envelope.error.warnings[0].details, { retryable: false });
});

test("handleRuntimeError: an error with no structured detail keeps the envelope's original shape", () => {
  const captured = withCapturedOutput(() => {
    handleRuntimeError(new Error("boom"), true);
  });
  const envelope = JSON.parse(captured);
  assert.deepEqual(Object.keys(envelope.error), ["message", "exitCode"]);
});

test("handleRuntimeError: a lint-gate CliError is attributable without parsing its message", () => {
  const err = new CliError("Lint gate failed (1 error(s), 0 warning(s)):\n[error] head_leaked_text: …", EXIT_CODES.LINT_OR_STRICT_FAILED, undefined, {
    reason: "lint_gate",
    findings: [{ code: "head_leaked_text", severity: "error", message: "…" }],
  });

  const captured = withCapturedOutput(() => {
    handleRuntimeError(err, true);
  });

  const envelope = JSON.parse(captured);
  // Same exit code as a correctness-warning block, different `reason` — the
  // whole point of carrying one.
  assert.equal(envelope.error.exitCode, EXIT_CODES.LINT_OR_STRICT_FAILED);
  assert.equal(envelope.error.reason, "lint_gate");
  assert.equal(envelope.error.findings[0].code, "head_leaked_text");
});

test("handleRuntimeError: a CliError's own exitCode passes through unchanged", () => {
  const err = new CliError("missing ffmpeg", EXIT_CODES.MISSING_DEPENDENCY, "install it");
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.MISSING_DEPENDENCY);
});

test("handleRuntimeError: an unrecognised error defaults to EXIT_CODES.RENDER_FAILED", () => {
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(new Error("something else broke"), true);
  });
  assert.equal(exitCode, EXIT_CODES.RENDER_FAILED);
});

test("handleRuntimeError: the producer's real 'binary not found' message maps to EXIT_CODES.MISSING_DEPENDENCY", () => {
  // The exact message an explicit --ffmpeg-path pointing at a missing file
  // actually produces (confirmed by triggering it for real: the producer
  // pre-validates explicit ffmpeg/ffprobe paths itself and fails before
  // capture with this wording — no `.code`, no special error name).
  const err = new Error(
    '[FFmpeg] FFmpeg binary not found at HYPERFRAMES_FFMPEG_PATH="C:\\nonexistent\\ffmpeg.exe". Install FFmpeg or unset the override.',
  );
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.MISSING_DEPENDENCY);
});

test("handleRuntimeError: a raw ENOENT (a spawned binary wasn't found) also maps to EXIT_CODES.MISSING_DEPENDENCY", () => {
  // Fallback for whatever doesn't get the producer's own pre-validation —
  // Node sets `.code` on a spawn failure's Error.
  const err = Object.assign(new Error("spawn /bad/path/ffmpeg ENOENT"), { code: "ENOENT" });
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.MISSING_DEPENDENCY);
});

test("handleRuntimeError: a CliError still wins over an ENOENT-shaped error's own exit code", () => {
  // "exitCode" in err (a CliError) is checked before the ENOENT fallback —
  // confirms that ordering explicitly, since a CliError could plausibly
  // also carry a `.code` from whatever it wrapped.
  const err = Object.assign(new CliError("nope", EXIT_CODES.OUTPUT_IO), { code: "ENOENT" });
  let exitCode: number | undefined;
  withCapturedOutput(() => {
    exitCode = handleRuntimeError(err, true);
  });
  assert.equal(exitCode, EXIT_CODES.OUTPUT_IO);
});

test("handleRuntimeError: the non-JSON path prints a human-readable message", () => {
  // `--json` reports the error as a JSON envelope on stdout; the non-JSON
  // path writes a plain "Error: <message>" line to stderr instead. This
  // just confirms that branch doesn't throw and includes the message.
  const captured = withCapturedOutput(() => {
    handleRuntimeError(usageError("bad flag combination"), false);
  });
  assert.match(captured, /bad flag combination/);
});

test("toCliError: passes CliError instances through unchanged", () => {
  const original = usageError("nope");
  assert.equal(toCliError(original), original);
});

test("toCliError: wraps a plain Error with the fallback exit code", () => {
  const wrapped = toCliError(new Error("boom"), EXIT_CODES.OUTPUT_IO);
  assert.equal(wrapped.exitCode, EXIT_CODES.OUTPUT_IO);
  assert.equal(wrapped.message, "boom");
});

test("toCliError: wraps a non-Error thrown value", () => {
  const wrapped = toCliError("just a string");
  assert.equal(wrapped.message, "just a string");
  assert.equal(wrapped.exitCode, EXIT_CODES.USAGE);
});
