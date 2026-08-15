import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertStrictVariables, extractDeclaredVariableNames, resolveVariables } from "../src/args/variables.js";

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
