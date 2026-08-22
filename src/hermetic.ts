import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { decodeHtmlEntities, extractAttr } from "./composition.js";

/**
 * Static detection of every network reference a composition makes, so
 * "is this pack hermetic?" is answerable without rendering it.
 *
 * Why this exists: the producer resolves remote `<script src>` with a live
 * `fetch()` at compile time (and Google Fonts families likewise), with no
 * disk cache. A pack authored against a CDN therefore renders fine on the
 * author's machine and degrades — often *silently*, with exit 0 and no
 * structured warning — on an offline or locked-down one. Upstream lint has
 * no rule for this: a composition whose GSAP `<script src>` points at an
 * unresolvable host lints completely clean.
 *
 * Deliberately static and offline: no HEAD checks, no DNS. The question
 * being answered is "does this reference the network at all", which is a
 * property of the source, not of today's connectivity. (`@hyperframes/lint`
 * does export a `lintMediaUrls` that HEAD-checks remote media, but making a
 * lint run depend on the network is exactly the failure mode this is meant
 * to expose.)
 *
 * Regex-based for the same reason `composition.ts` is — see its header: the
 * upstream parsers need a `DOMParser` that isn't available in plain Node,
 * and `@hyperframes/lint` itself takes the same approach.
 */
export interface RemoteReference {
  /** The absolute or protocol-relative URL as written in the source. */
  url: string;
  /** `script`, `link`, `img`, `video`, `css-url`, `css-import`, … */
  kind: string;
  /** Project-relative file the reference was found in. */
  file: string;
}

/** Attributes that can pull bytes over the network, by tag. */
const URL_ATTRIBUTES = ["src", "href", "poster", "data-src", "data-composition-src"];

/** Tags whose `href` is a navigation target rather than a fetched sub-resource. */
const NON_FETCHING_HREF_TAGS = new Set(["a", "area", "base"]);

function isRemote(url: string): boolean {
  // Protocol-relative (`//cdn.example/x.js`) fetches over the network just
  // like an absolute URL does; `data:`/`blob:`/`#`/relative paths do not.
  return /^(https?:)?\/\//i.test(url.trim());
}

function scanHtml(html: string, file: string): RemoteReference[] {
  const found: RemoteReference[] = [];

  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    for (const attr of URL_ATTRIBUTES) {
      if (attr === "href" && NON_FETCHING_HREF_TAGS.has(tag)) continue;
      const value = extractAttr(attrs, attr);
      if (value && isRemote(value)) found.push({ url: value, kind: tag, file });
    }
    // `<img srcset>` / `<source srcset>`: comma-separated "<url> <descriptor>".
    const srcset = extractAttr(attrs, "srcset");
    if (srcset) {
      for (const candidate of srcset.split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url && isRemote(url)) found.push({ url, kind: `${tag}[srcset]`, file });
      }
    }
  }

  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    found.push(...scanCss(decodeHtmlEntities(style[1]), file));
  }

  return found;
}

export function scanCss(css: string, file: string): RemoteReference[] {
  const found: RemoteReference[] = [];

  // Imports first: `@import url("…")` also matches the `url()` scan below,
  // and reporting one stylesheet import as two separate references (once
  // mislabelled `css-url`) would inflate every count downstream.
  const imports = new Set<string>();
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi)) {
    const url = match[1].trim();
    if (isRemote(url)) imports.add(url);
  }

  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const url = match[2].trim();
    if (isRemote(url) && !imports.has(url)) found.push({ url, kind: "css-url", file });
  }
  for (const url of imports) {
    found.push({ url, kind: "css-import", file });
  }

  return found;
}

/**
 * Local stylesheets linked from the entry HTML, so a remote `@font-face
 * src` or Google Fonts `@import` in a project's own `styles.css` is found
 * too — that is where they usually live, and missing them would make a
 * "hermetic" verdict actively misleading.
 *
 * Only same-project files are followed (a `..` escape or an unreadable file
 * is skipped, not an error) and only one level deep: nested `@import` of a
 * local stylesheet is rare enough that chasing it isn't worth the cycle
 * detection it would need.
 */
function localStylesheetPaths(html: string, projectDir: string, entryDir: string): string[] {
  const paths: string[] = [];

  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1];
    const rel = extractAttr(attrs, "rel");
    const href = extractAttr(attrs, "href");
    if (!href || isRemote(href)) continue;
    if (rel && !/\bstylesheet\b/i.test(rel)) continue;
    if (!rel && !href.toLowerCase().endsWith(".css")) continue;

    const absolute = resolve(entryDir, href.split(/[?#]/)[0]);
    const rel2 = relative(projectDir, absolute);
    if (rel2.startsWith("..")) continue;
    if (existsSync(absolute)) paths.push(absolute);
  }

  return paths;
}

/**
 * Every network reference reachable from a composition's entry HTML.
 * Deduplicated by url+kind+file so a stylesheet referenced twice reports
 * once.
 */
export function findRemoteReferences(
  html: string,
  projectDir: string,
  entryFile: string | undefined,
): RemoteReference[] {
  const entryRelative = entryFile ?? "index.html";
  const entryDir = dirname(join(projectDir, entryRelative));

  const found = scanHtml(html, entryRelative);

  for (const stylesheet of localStylesheetPaths(html, projectDir, entryDir)) {
    let css: string;
    try {
      css = readFileSync(stylesheet, "utf8");
    } catch {
      continue;
    }
    found.push(...scanCss(css, relative(projectDir, stylesheet).replaceAll("\\", "/")));
  }

  const seen = new Set<string>();
  return found.filter((ref) => {
    const key = `${ref.kind}\u0000${ref.url}\u0000${ref.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
