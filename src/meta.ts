import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The archive/repo root: the directory containing `dist/` (or `src/` under
 * `tsx`), `package.json`, and — for standalone/editor installs — `bin/`
 * with `node[.exe]` and `chrome-headless-shell/` (standalone additionally
 * has `bin/ffmpeg[.exe]`/`bin/ffprobe[.exe]`; editor deliberately doesn't).
 */
export function getArchiveRoot(): string {
  return join(__dirname, "..");
}

interface MinimalPackageJson {
  version: string;
  /** Written by `packaging/build.mjs` onto the staged package.json for every channel — see `getChannel()`. */
  hfmpegChannel?: Channel;
}

let cachedPkg: MinimalPackageJson | undefined;

function readOwnPackageJson(): MinimalPackageJson {
  if (cachedPkg) return cachedPkg;
  const pkgPath = join(__dirname, "..", "package.json");
  cachedPkg = JSON.parse(readFileSync(pkgPath, "utf8")) as MinimalPackageJson;
  return cachedPkg;
}

/** Our own version, read from the sibling package.json (works from src/ via tsx or dist/ post-build). */
export function getHfmpegVersion(): string {
  return readOwnPackageJson().version;
}

let cachedProducerVersion: string | null | undefined;

/**
 * The installed `@hyperframes/producer` version, resolved via its own
 * package.json rather than a hardcoded string, so `hfmpeg version`/`doctor`
 * always report what is actually on disk. Returns `undefined` if the
 * package cannot be resolved (e.g. dependencies not installed yet).
 */
export function getProducerVersion(): string | undefined {
  if (cachedProducerVersion !== undefined) return cachedProducerVersion ?? undefined;
  try {
    const mainUrl = import.meta.resolve("@hyperframes/producer");
    // publishConfig.exports "." → "./dist/index.js" — package root is one level up.
    const pkgPath = join(dirname(fileURLToPath(mainUrl)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as MinimalPackageJson;
    cachedProducerVersion = pkg.version;
  } catch {
    cachedProducerVersion = null;
  }
  return cachedProducerVersion ?? undefined;
}

export type Channel = "lite" | "standalone" | "editor";

/**
 * Build channel, detected rather than baked in at compile time.
 * `packaging/build.mjs` writes an explicit `hfmpegChannel` field onto the
 * staged `package.json` for every channel it produces — reading that back
 * is unambiguous, unlike inferring a three-way channel from which files
 * happen to exist in `bin/` (lite bundles nothing, editor bundles Node +
 * Chromium but not FFmpeg, standalone bundles all three — "does `bin/node`
 * exist" alone can no longer tell editor and standalone apart).
 *
 * Falls back to the old file-presence heuristic when the field is absent —
 * true for a plain repo checkout (`npm run dev` / `node dist/cli.js` after
 * `npm run build`), which never gets a staged `package.json` at all.
 */
export function getChannel(): Channel {
  const marker = readOwnPackageJson().hfmpegChannel;
  if (marker) return marker;
  const bundledNode = join(getArchiveRoot(), "bin", process.platform === "win32" ? "node.exe" : "node");
  return existsSync(bundledNode) ? "standalone" : "lite";
}

/**
 * The `chrome-headless-shell` version upstream HyperFrames pins
 * (`packages/cli/src/browser/manager.ts`, `00-PLAN.md` §2.2/D5). `hfmpeg`
 * pins the same version so `deps chromium ensure` downloads a build that
 * matches the render output every other channel produces, and so a lite
 * install can reuse an existing `~/.cache/hyperframes/chrome` cache.
 */
export const PINNED_CHROMIUM_VERSION = "152.0.7928.2";
