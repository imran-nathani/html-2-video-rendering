import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBatchRows, runBatch, substituteOutputTemplate } from "../src/batch.js";

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hfmpeg-batch-test-"));
  const path = join(dir, "rows.json");
  writeFileSync(path, contents);
  return path;
}

test("readBatchRows: accepts a bare JSON array", () => {
  const path = tmpFile(JSON.stringify([{ name: "a" }, { name: "b" }]));
  assert.deepEqual(readBatchRows(path), [{ name: "a" }, { name: "b" }]);
});

test("readBatchRows: accepts { rows: [...] }", () => {
  const path = tmpFile(JSON.stringify({ rows: [{ name: "a" }] }));
  assert.deepEqual(readBatchRows(path), [{ name: "a" }]);
});

test("readBatchRows: rejects non-object rows", () => {
  const path = tmpFile(JSON.stringify(["a", "b"]));
  assert.throws(() => readBatchRows(path));
});

test("readBatchRows: rejects malformed JSON", () => {
  const path = tmpFile("{not json");
  assert.throws(() => readBatchRows(path));
});

test("substituteOutputTemplate: substitutes {key} tokens", () => {
  assert.equal(
    substituteOutputTemplate("renders/{name}.mp4", { name: "intro" }),
    "renders/intro.mp4",
  );
  assert.equal(
    substituteOutputTemplate("renders/{a}-{b}.mp4", { a: "x", b: 2 }),
    "renders/x-2.mp4",
  );
});

test("substituteOutputTemplate: throws on an unknown row key", () => {
  assert.throws(() => substituteOutputTemplate("renders/{missing}.mp4", { name: "intro" }));
});

test("runBatch: runs every row and reports per-row success/failure", async () => {
  const rows = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const results = await runBatch(rows, "out/{name}.mp4", { concurrency: 2, failFast: false }, async (row) => {
    if (row.name === "b") throw new Error("boom");
    return { ok: true };
  });

  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.output === "out/a.mp4")?.ok, true);
  assert.equal(results.find((r) => r.output === "out/b.mp4")?.ok, false);
  assert.equal(results.find((r) => r.output === "out/b.mp4")?.error, "boom");
  assert.equal(results.find((r) => r.output === "out/c.mp4")?.ok, true);
});

test("runBatch: failFast stops launching new rows after the first failure", async () => {
  const rows = [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }];
  let started = 0;
  const results = await runBatch(rows, "out/{i}.mp4", { concurrency: 1, failFast: true }, async (row) => {
    started += 1;
    if (row.i === 0) throw new Error("boom");
    return { ok: true };
  });

  // With concurrency 1 and failFast, only the first row should ever start.
  assert.equal(started, 1);
  assert.equal(results[0].ok, false);
});
