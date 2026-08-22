import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgressReporter } from "../src/output/progress.js";

/**
 * `--progress json` is a machine contract (`00-COMMANDS.md` "Gates &
 * diagnostics"): one NDJSON line per event on stderr. These cover the two
 * things a consumer depends on — the frame counters being fields rather
 * than prose, and `progress` being a 0..100 percentage in every mode.
 */
function withCapturedStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("progress json: frame counters are emitted as fields, not only inside the stage string", () => {
  const captured = withCapturedStderr(() => {
    createProgressReporter("json", "render").report(70, "Capturing frame 144/144 (4 workers)", {
      totalFrames: 144,
      framesCompleted: 144,
    });
  });

  const event = JSON.parse(captured.trim());
  assert.deepEqual(event, {
    command: "render",
    event: "progress",
    progress: 70,
    stage: "Capturing frame 144/144 (4 workers)",
    totalFrames: 144,
    framesCompleted: 144,
  });
});

test("progress json: a stage with no frame counts emits exactly the fields it always did", () => {
  const captured = withCapturedStderr(() => {
    createProgressReporter("json", "render").report(25, "Starting frame capture");
  });

  assert.deepEqual(Object.keys(JSON.parse(captured.trim())), [
    "command",
    "event",
    "progress",
    "stage",
  ]);
});

test("progress plain/bar: `progress` is a percentage, not a fraction to re-scale", () => {
  // Regression: the producer's job.progress is already 0..100 (its
  // `updateJobStatus` clamps it there), so the old `progress * 100` printed
  // "2500%" for a real render while looking right for the batch path.
  const plain = withCapturedStderr(() => {
    createProgressReporter("plain", "render").report(25, "Starting frame capture");
  });
  assert.match(plain, /\[ 25%\] Starting frame capture/);

  const bar = withCapturedStderr(() => {
    const reporter = createProgressReporter("bar", "render");
    reporter.report(50, "halfway");
    reporter.end();
  });
  assert.match(bar, / 50% halfway/);
});

test("progress none: reports nothing at all", () => {
  const captured = withCapturedStderr(() => {
    createProgressReporter("none", "render").report(50, "halfway");
  });
  assert.equal(captured, "");
});
