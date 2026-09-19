import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLintArgs, runLintCommand } from "../src/commands/lint.js";
import { isVerbose, setVerbose } from "../src/output/log.js";

/**
 * Q3 (`03-FEATURE-LIST.md`): `lint --json --verbose` (no `--hermetic`)
 * undercounted `findings[]` against `infoCount` — reproduced live: the root
 * cause is that `--verbose` is a *global* flag (`args/global.ts`), stripped
 * out of argv by `extractGlobalFlags` before `cli.ts` ever calls
 * `parseLintArgs`, so a local `--verbose` branch in `lint.ts` could never
 * fire. `runLintCommand` now reads the shared `isVerbose()` instead.
 */

function projectWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hfmpeg-lint-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

/** A composition with no lint errors of its own, but one info-severity remote reference. */
const CLEAN_COMPOSITION_WITH_REMOTE_REF = `<!doctype html>
<html><head></head><body>
<div id="root" data-composition-id="q3" data-width="240" data-height="160" data-duration="1"
     data-start="0" data-no-timeline>
  <img src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">
</div>
</body></html>`;

function withRestoredVerbose(run: () => Promise<void>): Promise<void> {
  const snapshot = isVerbose();
  return run().finally(() => setVerbose(snapshot));
}

/**
 * `runLintCommand` is async and `printJsonEnvelope` writes the envelope in
 * one `process.stdout.write` call — but hijacking stdout across an `await`
 * also captures the test runner's own interleaved TAP output if it gets a
 * turn on the event loop first. Collecting chunks and picking out the one
 * that's actually JSON (rather than concatenating everything into one
 * string) keeps this robust to that interleaving — but only if every
 * captured chunk is *also* forwarded to the real stdout. Swallowing them
 * instead ate the test runner's own TAP result lines for whichever test
 * happened to be mid-`await` when the runner had a turn on the event loop
 * (reproduced: this file defines 3 tests but a plain run reported only 2 —
 * the `--verbose` test's own `ok` line never reached the TAP stream).
 */
async function captureJsonEnvelope(run: () => Promise<unknown>): Promise<unknown> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
    chunks.push(String(args[0]));
    return original(...args);
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not the envelope — keep looking.
    }
  }
  throw new Error(`No JSON envelope found in captured output: ${JSON.stringify(chunks)}`);
}

test("runLintCommand: --verbose (isVerbose()) includes info-severity findings in the array", async () => {
  await withRestoredVerbose(async () => {
    setVerbose(true);
    const dir = projectWith({ "index.html": CLEAN_COMPOSITION_WITH_REMOTE_REF });
    const args = parseLintArgs([dir, "--json"]);

    const envelope = (await captureJsonEnvelope(() => runLintCommand(args))) as {
      data: { infoCount: number; findings: Array<{ code: string }> };
    };
    assert.equal(envelope.data.infoCount, 1);
    assert.deepEqual(
      envelope.data.findings.map((f) => f.code),
      ["remote_reference"],
    );
  });
});

test("runLintCommand: without --verbose, info-severity findings are hidden but still counted", async () => {
  await withRestoredVerbose(async () => {
    setVerbose(false);
    const dir = projectWith({ "index.html": CLEAN_COMPOSITION_WITH_REMOTE_REF });
    const args = parseLintArgs([dir, "--json"]);

    const envelope = (await captureJsonEnvelope(() => runLintCommand(args))) as {
      data: { infoCount: number; findings: unknown[] };
    };
    assert.equal(envelope.data.infoCount, 1);
    assert.deepEqual(envelope.data.findings, []);
  });
});

test("parseLintArgs: no longer has a local --verbose branch (it's a global flag, stripped before this runs)", () => {
  // A bare `--verbose` reaching this parser directly (rather than through
  // `extractGlobalFlags`, which strips it first in real CLI usage) is now
  // correctly rejected as unknown, rather than being silently accepted and
  // doing nothing.
  assert.throws(() => parseLintArgs(["--verbose"]), /Unknown flag/);
});
