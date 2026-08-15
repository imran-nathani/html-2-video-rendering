import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractCompositionRoot,
  findAssetSources,
  findSubCompositionRefs,
  parseVariablesAttr,
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
