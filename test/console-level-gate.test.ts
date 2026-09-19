import assert from "node:assert/strict";
import { test } from "node:test";
import { setLogLevel, setVerbose } from "../src/output/log.js";
import { withConsoleLevelGate } from "../src/runtime/logger.js";

/**
 * Q3 bug: `--json --verbose` (or `--json --log-level info|debug`) re-enables
 * `effectiveRank()` independently of the `--json`-implied `silent` default
 * (`args/global.ts`), so a naive level gate would let the engine's bare
 * `console.log` tracing land back on stdout and corrupt the `--json`
 * envelope. `withConsoleLevelGate({ json: true })` must keep stdout clean by
 * rerouting those calls to stderr instead of just leaving them enabled.
 */

function withRestoredLogState(run: () => Promise<void>): Promise<void> {
  return run();
}

test("withConsoleLevelGate: json=true reroutes console.log to stderr even when --verbose re-enables debug", async () => {
  await withRestoredLogState(async () => {
    setLogLevel("silent");
    setVerbose(true); // effectiveRank() now reports debug, as if --json --verbose was passed

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await withConsoleLevelGate(async () => {
        console.log("[BrowserManager] Browser launched");
      }, { json: true });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      setLogLevel("info");
      setVerbose(false);
    }

    assert.deepEqual(stdoutChunks, []);
    assert.equal(stderrChunks.length, 1);
    assert.match(stderrChunks[0]!, /\[BrowserManager\] Browser launched/);
  });
});

test("withConsoleLevelGate: json=false still just suppresses console.log below the current level", async () => {
  await withRestoredLogState(async () => {
    setLogLevel("silent");
    setVerbose(false);

    const stdoutChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await withConsoleLevelGate(async () => {
        console.log("should be dropped");
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      setLogLevel("info");
    }

    assert.deepEqual(stdoutChunks, []);
  });
});
