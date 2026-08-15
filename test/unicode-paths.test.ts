import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractCompositionRoot } from "../src/composition.js";
import { substituteOutputTemplate } from "../src/batch.js";
import { readEntryHtml, resolveProjectInput } from "../src/project.js";

/**
 * 00-PLAN.md Phase 7 hardening: "Windows-unicode-path tests". Project
 * directories, composition filenames, and batch output templates all need
 * to survive non-ASCII characters — accented Latin, CJK, and an emoji —
 * without relying on a browser, so this is fully coverable as pure `fs`/
 * string-handling logic.
 */

const SAMPLE_HTML = `<!doctype html>
<html><body>
  <main data-composition-id="unicode-sample" data-width="320" data-height="240" data-duration="2"></main>
</body></html>
`;

function withUnicodeProjectDir(dirName: string, run: (projectDir: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "hfmpeg-unicode-test-"));
  const projectDir = join(base, dirName);
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "index.html"), SAMPLE_HTML, "utf8");
    run(projectDir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

for (const dirName of [
  "café-intro",
  "日本語のプロジェクト",
  "emoji-🎬-render",
  "spaced folder name",
]) {
  test(`resolveProjectInput + readEntryHtml: round-trips a unicode project dir ("${dirName}")`, () => {
    withUnicodeProjectDir(dirName, (projectDir) => {
      const { projectDir: resolvedDir, entryFile } = resolveProjectInput({ positionalDir: projectDir });
      assert.equal(resolvedDir, projectDir);
      assert.equal(entryFile, undefined); // defaults to index.html

      const html = readEntryHtml(resolvedDir, entryFile);
      const root = extractCompositionRoot(html);
      assert.equal(root?.compositionId, "unicode-sample");
      assert.equal(root?.width, 320);
      assert.equal(root?.height, 240);
    });
  });
}

test("resolveProjectInput: an -i path pointing at a unicode .html file resolves dir + entryFile separately", () => {
  withUnicodeProjectDir("プロジェクト", (projectDir) => {
    const htmlPath = join(projectDir, "index.html");
    const { projectDir: resolvedDir, entryFile } = resolveProjectInput({ input: htmlPath });
    assert.equal(resolvedDir, projectDir);
    assert.equal(entryFile, "index.html");
  });
});

test("resolveProjectInput: a -c composition file with a unicode name wins over the positional/-i file", () => {
  withUnicodeProjectDir("composición", (projectDir) => {
    writeFileSync(join(projectDir, "intro-🎬.html"), SAMPLE_HTML, "utf8");
    const { entryFile } = resolveProjectInput({ positionalDir: projectDir, composition: "intro-🎬.html" });
    assert.equal(entryFile, "intro-🎬.html");
    const html = readEntryHtml(projectDir, entryFile);
    assert.ok(extractCompositionRoot(html));
  });
});

test("substituteOutputTemplate: unicode row values substitute cleanly into {token} templates", () => {
  const output = substituteOutputTemplate("renders/{name}.mp4", { name: "日本語-café-🎬" });
  assert.equal(output, "renders/日本語-café-🎬.mp4");
});
