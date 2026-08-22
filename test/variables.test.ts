import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertStrictVariables,
  checkUndeclaredVariables,
  extractDeclaredVariableNames,
  findUndeclaredVariableNames,
  resolveVariables,
} from "../src/args/variables.js";
import { getLogLevel, setLogLevel } from "../src/output/log.js";

const HTML_WITH_VARS = `<html><body><main data-composition-id="x" data-composition-variables="[{&quot;id&quot;:&quot;title&quot;,&quot;type&quot;:&quot;string&quot;,&quot;label&quot;:&quot;Title&quot;,&quot;default&quot;:&quot;Hi&quot;},{&quot;id&quot;:&quot;count&quot;,&quot;type&quot;:&quot;number&quot;,&quot;label&quot;:&quot;Count&quot;,&quot;default&quot;:1}]"></main></body></html>`;

test("resolveVariables: --variables wins over --variables-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hfmpeg-vars-test-"));
  const filePath = join(dir, "vars.json");
  writeFileSync(filePath, JSON.stringify({ title: "from file", subtitle: "keep me" }));

  const merged = resolveVariables(JSON.stringify({ title: "from flag" }), filePath);
  assert.deepEqual(merged, { title: "from flag", subtitle: "keep me" });
});

test("resolveVariables: returns undefined when neither is given", () => {
  assert.equal(resolveVariables(undefined, undefined), undefined);
});

test("resolveVariables: rejects non-object JSON", () => {
  assert.throws(() => resolveVariables("[1,2,3]", undefined));
  assert.throws(() => resolveVariables("not json", undefined));
});

test("extractDeclaredVariableNames: reads declared variable ids (schema key is `id`, not `name`)", () => {
  assert.deepEqual(extractDeclaredVariableNames(HTML_WITH_VARS), ["title", "count"]);
});

test("extractDeclaredVariableNames: returns [] when there is nothing declared", () => {
  assert.deepEqual(extractDeclaredVariableNames("<html><body></body></html>"), []);
});

test("assertStrictVariables: throws when a declared variable has no override", () => {
  assert.throws(() => assertStrictVariables(HTML_WITH_VARS, { title: "only this one" }));
});

test("assertStrictVariables: passes when every declared variable is provided", () => {
  assert.doesNotThrow(() => assertStrictVariables(HTML_WITH_VARS, { title: "a", count: 2 }));
});

test("assertStrictVariables: passes trivially when nothing is declared", () => {
  assert.doesNotThrow(() => assertStrictVariables("<html></html>", undefined));
});

test("resolveVariables: a UTF-8 BOM in --variables-file does not break JSON parsing", () => {
  // PowerShell's `Set-Content -Encoding utf8` writes one by default, and
  // `JSON.parse` rejects it with a syntax error that names none of that.
  const dir = mkdtempSync(join(tmpdir(), "hfmpeg-vars-bom-"));
  const filePath = join(dir, "vars.json");
  writeFileSync(filePath, `\uFEFF${JSON.stringify({ title: "with bom" })}`, "utf8");

  assert.deepEqual(resolveVariables(undefined, filePath), { title: "with bom" });
});

test("findUndeclaredVariableNames: reports provided keys the composition never declared", () => {
  assert.deepEqual(
    findUndeclaredVariableNames(HTML_WITH_VARS, { title: "a", titel: "typo", count: 1 }),
    ["titel"],
  );
});

test("findUndeclaredVariableNames: is silent when every provided key is declared", () => {
  assert.deepEqual(findUndeclaredVariableNames(HTML_WITH_VARS, { title: "a" }), []);
});

test("findUndeclaredVariableNames: reports nothing when the composition declares nothing", () => {
  // Indistinguishable from "declarations we failed to parse" — never reject
  // a legitimate override on the strength of a parse miss.
  assert.deepEqual(findUndeclaredVariableNames("<html></html>", { title: "a" }), []);
});

test("checkUndeclaredVariables: throws under --strict-variables, only warns without it", () => {
  const unknown = { title: "a", nope: 1 };
  assert.throws(() => checkUndeclaredVariables(HTML_WITH_VARS, unknown, true), /nope/);

  // Silence the warning the lenient path prints so it doesn't land in the
  // test runner's own output; restore whatever the level was afterwards.
  const previous = getLogLevel();
  setLogLevel("silent");
  try {
    assert.doesNotThrow(() => checkUndeclaredVariables(HTML_WITH_VARS, unknown, false));
  } finally {
    setLogLevel(previous);
  }
});
