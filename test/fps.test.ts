import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFpsArg } from "../src/args/fps.js";

test("parseFpsArg: plain integer", () => {
  assert.deepEqual(parseFpsArg("30"), { num: 30, den: 1 });
  assert.deepEqual(parseFpsArg("1"), { num: 1, den: 1 });
  assert.deepEqual(parseFpsArg("240"), { num: 240, den: 1 });
});

test("parseFpsArg: ffmpeg-style rational", () => {
  assert.deepEqual(parseFpsArg("30000/1001"), { num: 30000, den: 1001 });
  assert.deepEqual(parseFpsArg("24000/1001"), { num: 24000, den: 1001 });
});

test("parseFpsArg: rejects out-of-range integers", () => {
  assert.throws(() => parseFpsArg("0"));
  assert.throws(() => parseFpsArg("241"));
  assert.throws(() => parseFpsArg("-1"));
});

test("parseFpsArg: rejects malformed input", () => {
  assert.throws(() => parseFpsArg("abc"));
  assert.throws(() => parseFpsArg("30/"));
  assert.throws(() => parseFpsArg("30.5"));
  assert.throws(() => parseFpsArg("0/1"));
});
