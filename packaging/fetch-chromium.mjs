#!/usr/bin/env node
/**
 * packaging/fetch-chromium.mjs — Phase 5 (00-PLAN.md §5/§2.2): downloads the
 * pinned `chrome-headless-shell` build for one platform via
 * `@puppeteer/browsers`, for the standalone archive to bundle. Unlike
 * `fetch-ffmpeg.mjs`'s source, Chrome for Testing publishes its own
 * checksummed download metadata, which `@puppeteer/browsers` verifies
 * against internally — no separate checksum pinning needed here.
 *
 * Chromium/`chrome-headless-shell` redistribution is BSD-style: its LICENSE
 * is carried alongside the binary into `THIRD-PARTY-LICENSES`
 * (00-PLAN.md §2.5), written by `packaging/build-standalone.mjs`.
 *
 * No Chrome-for-Testing `chrome-headless-shell` build exists for
 * `linux_arm` (00-PLAN.md D5) — `linux-arm64` therefore stays lite-only.
 *
 * Usage:
 *   node packaging/fetch-chromium.mjs [--platform <win64|win32|mac|mac_arm|linux>] [--version <ver>] [--out <dir>] [--force]
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/** Fallback pin — keep in sync with `src/meta.ts`'s `PINNED_CHROMIUM_VERSION`. */
const FALLBACK_PINNED_CHROMIUM_VERSION = "152.0.7928.2";

function log(message) {
  process.stdout.write(`[fetch-chromium] ${message}\n`);
}

/** Prefer the compiled CLI's own constant (single source of truth) when `dist/` exists; else fall back. */
async function resolvePinnedChromiumVersion() {
  const metaPath = join(repoRoot, "dist", "meta.js");
  if (existsSync(metaPath)) {
    try {
      const mod = await import(pathToFileURL(metaPath).href);
      if (mod.PINNED_CHROMIUM_VERSION) return mod.PINNED_CHROMIUM_VERSION;
    } catch {
      // fall through to the hardcoded fallback
    }
  }
  return FALLBACK_PINNED_CHROMIUM_VERSION;
}

/**
 * Download `chrome-headless-shell` for `platform` (a `BrowserPlatform`
 * value) into `outDir`, laid out exactly as `@puppeteer/browsers` extracts
 * it — the standalone launcher points `PRODUCER_HEADLESS_SHELL_PATH`
 * directly at the returned executable path, so no particular directory
 * convention needs to be reconstructed (unlike `deps chromium ensure`,
 * which stages into `@hyperframes/engine`'s auto-discovery cache layout).
 */
export async function fetchChromium(platform, version, outDir, { force = false } = {}) {
  const { install, Browser } = await import("@puppeteer/browsers");

  if (force) rmSync(outDir, { recursive: true, force: true });

  // `install()` is itself idempotent (it checks its own cache metadata and
  // skips re-downloading), so there is no separate "already fetched" path
  // to maintain here beyond `--force` blowing away the cache first.
  const installed = await install({
    cacheDir: outDir,
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: version,
    platform,
    unpack: true,
  });
  log(`chrome-headless-shell ${version} (${platform}) -> ${installed.executablePath}`);
  return installed.executablePath;
}

/**
 * Chrome for Testing ships each build's LICENSE inside the archive itself
 * (`chrome-headless-shell-<platform>/LICENSE`, no network round trip
 * needed) — copy it out next to the binary for `THIRD-PARTY-LICENSES`.
 */
export function copyChromiumLicense(executablePath, destDir) {
  const dir = dirname(executablePath);
  const candidate = ["LICENSE.headless_shell", "LICENSE"].map((name) => join(dir, name)).find(existsSync);
  if (!candidate) {
    log(`Warning: no LICENSE found next to ${executablePath}`);
    return undefined;
  }
  const licenseDest = join(destDir, "chrome-headless-shell.LICENSE");
  cpSync(candidate, licenseDest);
  return licenseDest;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const { detectBrowserPlatform } = await import("@puppeteer/browsers");
  const platform = get("--platform", detectBrowserPlatform());
  if (!platform) throw new Error(`Could not detect a supported platform for ${process.platform}-${process.arch}.`);
  const version = get("--version", await resolvePinnedChromiumVersion());
  const outDir = resolve(get("--out", join(repoRoot, "packaging", "vendor", "chrome-headless-shell", platform)));
  const force = args.includes("--force");

  const executablePath = await fetchChromium(platform, version, outDir, { force });
  copyChromiumLicense(executablePath, outDir);
  log(`Done. Executable: ${executablePath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`[fetch-chromium] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
