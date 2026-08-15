/**
 * Lightweight, regex-based composition metadata extraction shared by
 * `probe`, `lint`'s `--strict-variables` gate (via `args/variables.ts`), and
 * anything else that needs to answer questions about a composition's HTML
 * without paying for a browser.
 *
 * `@hyperframes/parsers`' own `parseHtml`/`extractCompositionMetadata`
 * require a global `DOMParser` that is not polyfilled by
 * `@hyperframes/producer`/`@hyperframes/engine` when imported from plain
 * Node (confirmed empirically: `new DOMParser()` throws `DOMParser is not
 * defined` even after importing the producer), so we deliberately do not
 * depend on them here. `@hyperframes/lint` takes the same regex-based
 * approach for the same reason (see its `readAttr`/`readDecodedAttr`
 * helpers), which is the precedent this module follows.
 */

/** Decode the small set of HTML entities that show up in attribute values written by tooling. */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Read `attrName="value"` (or `'value'`) out of a raw opening-tag string. */
export function extractAttr(tagText: string, attrName: string): string | undefined {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = tagText.match(re);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : decodeHtmlEntities(raw);
}

export interface CompositionVariableDeclaration {
  id: string;
  type: string;
  label?: string;
  description?: string;
  default?: unknown;
}

/**
 * Parse a `data-composition-variables` JSON attribute value into typed
 * declarations. Malformed entries are dropped rather than throwing, matching
 * `@hyperframes/parsers`' `parseCompositionVariables` leniency. The schema's
 * key is `id` (`CompositionVariableBase.id` in `@hyperframes/parsers`), not
 * `name`.
 */
export function parseVariablesAttr(raw: string | undefined): CompositionVariableDeclaration[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is CompositionVariableDeclaration =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string" &&
      typeof (entry as Record<string, unknown>).type === "string",
  );
}

/** Find the raw opening tag of the first element carrying `attrName`, anywhere in the document. */
function findFirstTagWithAttr(html: string, attrName: string): string | undefined {
  const re = new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*\\b[^>]*?\\b${attrName}\\s*=\\s*(?:"[^"]*"|'[^']*')[^>]*>`, "i");
  return html.match(re)?.[0];
}

/** Find the raw opening tags of every element carrying `attrName`, anywhere in the document. */
function findAllTagsWithAttr(html: string, attrName: string): string[] {
  const re = new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*\\b[^>]*?\\b${attrName}\\s*=\\s*(?:"[^"]*"|'[^']*')[^>]*>`, "gi");
  return html.match(re) ?? [];
}

function tagNameOf(tagText: string): string {
  return tagText.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase() ?? "";
}

export interface CompositionRootInfo {
  compositionId?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  variables: CompositionVariableDeclaration[];
}

/**
 * Extract `data-composition-id`/`data-width`/`data-height`/`data-fps`/
 * `data-duration`/`data-composition-variables` off the composition root —
 * the `[data-composition-id]` element (`00-PLAN.md` §2.1), which is not
 * necessarily `<html>`.
 */
export function extractCompositionRoot(html: string): CompositionRootInfo | undefined {
  const rootTag = findFirstTagWithAttr(html, "data-composition-id");
  if (!rootTag) return undefined;

  const toNumber = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    compositionId: extractAttr(rootTag, "data-composition-id"),
    width: toNumber(extractAttr(rootTag, "data-width")),
    height: toNumber(extractAttr(rootTag, "data-height")),
    fps: toNumber(extractAttr(rootTag, "data-fps")),
    durationSeconds: toNumber(
      extractAttr(rootTag, "data-duration") ?? extractAttr(rootTag, "data-composition-duration"),
    ),
    variables: parseVariablesAttr(extractAttr(rootTag, "data-composition-variables")),
  };
}

export interface ElementCounts {
  img: number;
  video: number;
  audio: number;
  canvas: number;
  other: number;
}

export interface TimelineSummary {
  clipCount: number;
  trackCount: number;
  elementCounts: ElementCounts;
}

/** Count timeline elements (`[data-start]`) by tag and distinct `data-track-index` values. */
export function summarizeTimeline(html: string): TimelineSummary {
  const tags = findAllTagsWithAttr(html, "data-start");
  const elementCounts: ElementCounts = { img: 0, video: 0, audio: 0, canvas: 0, other: 0 };
  const tracks = new Set<string>();

  for (const tag of tags) {
    const name = tagNameOf(tag);
    if (name === "img" || name === "video" || name === "audio" || name === "canvas") {
      elementCounts[name] += 1;
    } else {
      elementCounts.other += 1;
    }
    tracks.add(extractAttr(tag, "data-track-index") ?? "0");
  }

  return { clipCount: tags.length, trackCount: tracks.size, elementCounts };
}

export interface SubCompositionRef {
  src: string;
  elementId?: string;
}

/** Elements referencing a sub-composition via `data-composition-src`/`data-composition-file`. */
export function findSubCompositionRefs(html: string): SubCompositionRef[] {
  const attrNames = ["data-composition-src", "data-composition-file"];
  const refs: SubCompositionRef[] = [];
  for (const attrName of attrNames) {
    for (const tag of findAllTagsWithAttr(html, attrName)) {
      const src = extractAttr(tag, attrName);
      if (!src) continue;
      refs.push({ src, elementId: extractAttr(tag, "id") });
    }
  }
  return refs;
}

export interface AssetRef {
  src: string;
  /** `true` for a remote (`http(s)://`) or inline (`data:`) source — no local file to check. */
  remote: boolean;
  /** Only set for local sources: whether the referenced file exists relative to the project dir. */
  exists?: boolean;
}

const REMOTE_SRC_RE = /^(?:https?:|data:)/i;

/** Every `src=`/`data-src=` attribute value on `<img>`/`<video>`/`<audio>`/`<source>` elements. */
export function findAssetSources(html: string): string[] {
  const sources = new Set<string>();
  for (const attrName of ["src", "data-src"]) {
    const re = new RegExp(
      `<(?:img|video|audio|source)\\b[^>]*?\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')[^>]*>`,
      "gi",
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const raw = match[1] ?? match[2];
      if (raw) sources.add(decodeHtmlEntities(raw));
    }
  }
  return [...sources];
}

export { REMOTE_SRC_RE };
