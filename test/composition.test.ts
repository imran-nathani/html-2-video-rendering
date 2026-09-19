import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractCompositionRoot,
  findAssetSources,
  findSubCompositionRefs,
  parseVariablesAttr,
  resolveFallbackDurationSeconds,
  summarizeTimeline,
} from "../src/composition.js";

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
  <head></head>
  <body>
    <main
      id="root"
      data-composition-id="sample"
      data-start="0"
      data-duration="5"
      data-width="1920"
      data-height="1080"
      data-fps="30"
      data-composition-variables="[{&quot;id&quot;:&quot;title&quot;,&quot;type&quot;:&quot;string&quot;,&quot;label&quot;:&quot;Title&quot;,&quot;default&quot;:&quot;Hello&quot;}]"
    >
      <img id="logo" data-start="0" data-duration="5" data-track-index="0" src="./logo.png" />
      <video id="clip" data-start="1" data-duration="3" data-track-index="1" src="https://example.com/clip.mp4"></video>
      <section id="sub" data-start="0" data-duration="5" data-composition-src="./sub-comp.html"></section>
    </main>
  </body>
</html>
`;

test("extractCompositionRoot: reads the [data-composition-id] root's attributes", () => {
  const root = extractCompositionRoot(SAMPLE_HTML);
  assert.ok(root);
  assert.equal(root?.compositionId, "sample");
  assert.equal(root?.width, 1920);
  assert.equal(root?.height, 1080);
  assert.equal(root?.fps, 30);
  assert.equal(root?.durationSeconds, 5);
  assert.equal(root?.variables.length, 1);
  assert.equal(root?.variables[0].id, "title");
  assert.equal(root?.variables[0].default, "Hello");
});

test("extractCompositionRoot: returns undefined when there is no composition root", () => {
  assert.equal(extractCompositionRoot("<html><body>hi</body></html>"), undefined);
});

// Real-world authoring split: data-composition-id lives on <html>, but the
// timeline's own root duration lives on a separate .clip element — e.g.
// GX-BROLL/graphic/lower-third-minimal's <main class="clip" data-duration>.
// extractCompositionRoot correctly reports no duration here (it only reads
// off the [data-composition-id] tag); resolveFallbackDurationSeconds exists
// to answer "what's this file's duration" for --poster/probe anyway.
const SPLIT_ROOT_HTML = `<!doctype html>
<html data-composition-id="split" data-width="1920" data-height="1080">
  <body>
    <main id="root" class="clip" data-start="0" data-duration="4.5" data-width="1920" data-height="1080">
      <div class="content"></div>
    </main>
  </body>
</html>
`;

test("extractCompositionRoot: does not see a data-duration declared off a separate timeline-root element", () => {
  const root = extractCompositionRoot(SPLIT_ROOT_HTML);
  assert.equal(root?.compositionId, "split");
  assert.equal(root?.durationSeconds, undefined);
});

test("resolveFallbackDurationSeconds: recovers the duration from the timeline-root .clip element", () => {
  assert.equal(resolveFallbackDurationSeconds(SPLIT_ROOT_HTML), 4.5);
});

test("resolveFallbackDurationSeconds: returns undefined when nothing declares a positive data-duration", () => {
  assert.equal(resolveFallbackDurationSeconds("<html><body><div data-duration=\"0\"></div></body></html>"), undefined);
  assert.equal(resolveFallbackDurationSeconds("<html><body>hi</body></html>"), undefined);
});

test("resolveFallbackDurationSeconds: takes the latest data-start + data-duration end across multiple elements", () => {
  const html = `<html><body>
    <div data-start="0" data-duration="2"></div>
    <div data-start="3" data-duration="1.5"></div>
  </body></html>`;
  // 0+2=2, 3+1.5=4.5 -> latest end wins.
  assert.equal(resolveFallbackDurationSeconds(html), 4.5);
});

test("extractCompositionRoot: still prefers its own data-duration when the root declares one directly", () => {
  const root = extractCompositionRoot(SAMPLE_HTML);
  assert.equal(root?.durationSeconds, 5);
  // resolveFallbackDurationSeconds would agree here too (root also carries
  // data-start/data-duration itself), so callers can safely `??` the two.
  assert.equal(resolveFallbackDurationSeconds(SAMPLE_HTML), 5);
});

test("parseVariablesAttr: drops malformed declarations instead of throwing", () => {
  assert.deepEqual(parseVariablesAttr(undefined), []);
  assert.deepEqual(parseVariablesAttr("not json"), []);
  assert.deepEqual(parseVariablesAttr("[]"), []);
  // A declaration needs both `id` and `type` (strings) to count.
  assert.deepEqual(parseVariablesAttr(JSON.stringify([{ id: "a" }, { notAnId: true }])), []);
  assert.deepEqual(parseVariablesAttr(JSON.stringify([{ id: "a", type: "string" }])), [{ id: "a", type: "string" }]);
});

test("summarizeTimeline: counts clips, tracks, and element types", () => {
  const summary = summarizeTimeline(SAMPLE_HTML);
  // Every element carrying data-start counts as a clip, including the
  // composition root (<main>) and the sub-composition reference (<section>).
  assert.equal(summary.clipCount, 4);
  assert.equal(summary.elementCounts.img, 1);
  assert.equal(summary.elementCounts.video, 1);
  assert.equal(summary.elementCounts.other, 2); // <main> + <section>
  // data-track-index: img -> "0", video -> "1"; <main>/<section> default to "0".
  assert.equal(summary.trackCount, 2);
});

test("findSubCompositionRefs: finds data-composition-src references", () => {
  const refs = findSubCompositionRefs(SAMPLE_HTML);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].src, "./sub-comp.html");
  assert.equal(refs[0].elementId, "sub");
});

test("findAssetSources: collects src attributes off media elements", () => {
  const sources = findAssetSources(SAMPLE_HTML);
  assert.ok(sources.includes("./logo.png"));
  assert.ok(sources.includes("https://example.com/clip.mp4"));
});
