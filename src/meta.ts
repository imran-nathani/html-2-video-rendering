import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The archive/repo root: the directory containing `dist/` (or `src/` under
 * `tsx`), `package.json`, and — for a standalone install only —
 * `bin/node[.exe]`, `bin/ffmpeg[.exe]`, `bin/chrome-headless-shell/`.
 */
export function getArchiveRoot(): string {
  return join(__dirname, "..");
}

interface MinimalPackageJson {
  version: string;
}

let cachedHfmpegVersion: string | undefined;

/** Our own version, read from the sibling package.json (works from src/ via tsx or dist/ post-build). */
export function getHfmpegVersion(): string {
  if (cachedHfmpegVersion) return cachedHfmpegVersion;
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as MinimalPackageJson;
  cachedHfmpegVersion = pkg.version;
  return cachedHfmpegVersion;
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

export type Channel = "lite" | "standalone";

/**
 * Build channel, detected rather than baked in at compile time: a
 * standalone archive (`packaging/build.mjs --channel=standalone`) carries
 * its own `bin/node[.exe]` next to `dist/`; a lite archive or a repo
 * checkout does not (§4 "Release channel detection"). Self-describing, so
 * there is nothing separate to keep in sync when packaging changes.
 */
export function getChannel(): Channel {
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
