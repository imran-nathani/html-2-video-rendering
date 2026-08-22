import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRemoteReferences } from "../src/hermetic.js";

/**
 * `lint`'s hermeticity scan: every network reference a composition makes,
 * found statically. The upstream lint rules have no equivalent — a
 * composition whose GSAP `<script src>` points at an unresolvable host lints
 * completely clean — and the producer fetches those URLs on every render.
 */

function projectWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hfmpeg-hermetic-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

test("findRemoteReferences: flags a CDN <script src>, the exact case upstream lint misses", () => {
  const html = `<html><head>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script src="./vendor/gsap.min.js"></script>
  </head><body></body></html>`;
  const dir = projectWith({ "index.html": html });

  const refs = findRemoteReferences(html, dir, "index.html");
  assert.deepEqual(
    refs.map((r) => r.url),
    ["https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"],
  );
  assert.equal(refs[0].kind, "script");
  assert.equal(refs[0].file, "index.html");
});

test("findRemoteReferences: covers fonts, media, srcset and protocol-relative URLs", () => {
  const html = `<html><head>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat">
    <style>@font-face { font-family: X; src: url("https://example.com/x.woff2"); }</style>
  </head><body>
    <img src="//cdn.example.com/logo.png" srcset="//cdn.example.com/logo@2x.png 2x, ./local@3x.png 3x">
    <video src="https://example.com/clip.mp4" poster="https://example.com/p.jpg"></video>
    <a href="https://example.com/docs">not a fetch</a>
  </body></html>`;
  const dir = projectWith({ "index.html": html });

  const refs = findRemoteReferences(html, dir, "index.html");
  assert.deepEqual(refs.map((r) => `${r.kind} ${r.url}`), [
    "link https://fonts.googleapis.com/css2?family=Montserrat",
    "img //cdn.example.com/logo.png",
    "img[srcset] //cdn.example.com/logo@2x.png",
    "video https://example.com/clip.mp4",
    "video https://example.com/p.jpg",
    "css-url https://example.com/x.woff2",
  ]);
});

test("findRemoteReferences: follows local stylesheets, where @font-face usually lives", () => {
  const html = `<html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>`;
  const dir = projectWith({
    "index.html": html,
    "styles.css": `@import url("https://fonts.googleapis.com/css2?family=Inter");
      @font-face { font-family: Local; src: url("./fonts/local.woff2"); }
      .bg { background: url('https://cdn.example.com/bg.png'); }`,
  });

  const refs = findRemoteReferences(html, dir, "index.html");
  assert.deepEqual(refs.map((r) => `${r.kind} ${r.file} ${r.url}`), [
    "css-url styles.css https://cdn.example.com/bg.png",
    "css-import styles.css https://fonts.googleapis.com/css2?family=Inter",
  ]);
});

test("findRemoteReferences: a fully vendored pack reports nothing", () => {
  const html = `<html><head>
    <script src="./vendor/gsap.min.js"></script>
    <link rel="stylesheet" href="styles.css">
  </head><body>
    <img src="assets/logo.png">
    <img src="data:image/gif;base64,R0lGOD">
  </body></html>`;
  const dir = projectWith({
    "index.html": html,
    "styles.css": `@font-face { font-family: Local; src: url("./fonts/local.woff2"); }`,
  });

  assert.deepEqual(findRemoteReferences(html, dir, "index.html"), []);
});

test("findRemoteReferences: de-duplicates a URL referenced more than once", () => {
  const html = `<html><body>
    <img src="https://cdn.example.com/a.png">
    <img src="https://cdn.example.com/a.png">
  </body></html>`;
  const dir = projectWith({ "index.html": html });

  assert.equal(findRemoteReferences(html, dir, "index.html").length, 1);
});
