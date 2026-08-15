#!/usr/bin/env node
/**
 * packaging/fetch-ffmpeg.mjs — Phase 5 (00-PLAN.md §5/§2.5): downloads the
 * pinned static `ffmpeg`/`ffprobe` binaries for one platform, for the
 * standalone archive to bundle.
 *
 * Source: `eugeneware/ffmpeg-static`'s GitHub Releases — the same upstream
 * the `ffmpeg-static`/`@ffmpeg-installer/ffmpeg` npm packages use. It
 * re-publishes single static binaries (not a full build tree), one per
 * platform, each with its own LICENSE + README naming the actual builder:
 *   - win32-x64:      https://www.gyan.dev/ffmpeg/builds/         (GPL v3)
 *   - linux-x64/arm64: https://johnvansickle.com/ffmpeg/          (GPL v3)
 *   - darwin-x64:      https://evermeet.cx/pub/ffmpeg/            (GPL)
 *   - darwin-arm64:    https://osxexperts.net/                    (GPL)
 * `00-PLAN.md` §2.5: subprocess-only usage keeps `hfmpeg`'s own source
 * permissive; the bundled *binary* carries its GPL obligation, discharged by
 * shipping its LICENSE text + this documented corresponding-source URL
 * (handled by `THIRD-PARTY-LICENSES`, written by `packaging/build-standalone.mjs`).
 *
 * Usage:
 *   node packaging/fetch-ffmpeg.mjs [--platform <p>] [--arch <a>] [--out <dir>] [--force]
 *
 * Prints the sha256 of each downloaded binary. There is no upstream-published
 * checksum manifest for this source to verify against (unlike Chrome for
 * Testing's own signed metadata, which fetch-chromium.mjs *does* verify
 * against) — this script is trust-on-first-use: the computed hash is the
 * pin, recorded in `packaging/checksums.json` and checked on every
 * subsequent run for that exact (tag, platform, arch, binary) so a changed
 * asset is caught, not silently re-trusted.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const checksumsPath = join(__dirname, "checksums.json");

/** Pinned release tag of eugeneware/ffmpeg-static — bump deliberately, re-verify licenses on bump. */
export const FFMPEG_STATIC_TAG = "b6.1.1";
const FFMPEG_STATIC_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}`;

/** eugeneware/ffmpeg-static platform keys are exactly `${process.platform}-${process.arch}`. */
export const SUPPORTED_PLATFORMS = ["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function log(message) {
  process.stdout.write(`[fetch-ffmpeg] ${message}\n`);
}

function loadChecksums() {
  if (!existsSync(checksumsPath)) return {};
  return JSON.parse(readFileSync(checksumsPath, "utf8"));
}

function saveChecksums(data) {
  writeFileSync(checksumsPath, `${JSON.stringify(data, null, 2)}\n`);
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadGzBinary(url) {
  const gz = await downloadToBuffer(url);
  return gunzipSync(gz);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Fetch `ffmpeg` + `ffprobe` (+ their LICENSE/README) for `platformKey`
 * (e.g. `win32-x64`) into `outDir`. Verifies against
 * `packaging/checksums.json` if a pin exists for this tag; otherwise
 * records what it downloaded as the new pin.
 */
export async function fetchFfmpeg(platformKey, outDir, { force = false, requirePinned = false } = {}) {
  if (!SUPPORTED_PLATFORMS.includes(platformKey)) {
    throw new Error(`Unsupported platform "${platformKey}". Expected one of: ${SUPPORTED_PLATFORMS.join(", ")}.`);
  }

  const exeSuffix = platformKey.startsWith("win32") ? ".exe" : "";
  const ffmpegDest = join(outDir, `ffmpeg${exeSuffix}`);
  const ffprobeDest = join(outDir, `ffprobe${exeSuffix}`);
  const readmeDest = join(outDir, "SOURCE.txt");

  if (!force && existsSync(ffmpegDest) && existsSync(ffprobeDest)) {
    log(`${platformKey}: already fetched at ${outDir} (pass --force to re-download).`);
    return { ffmpeg: ffmpegDest, ffprobe: ffprobeDest };
  }

  mkdirSync(outDir, { recursive: true });

  const checksums = loadChecksums();
  const key = `${FFMPEG_STATIC_TAG}/${platformKey}`;
  const pinned = checksums[key];

  if (requirePinned && !pinned) {
    throw new Error(
      `--require-pinned: no checksum pin for "${key}" in packaging/checksums.json. ` +
        `Run this script once locally (without --require-pinned) to mint and commit a pin ` +
        `before release automation trusts this platform.`,
    );
  }

  const recorded = { ffmpeg: undefined, ffprobe: undefined };

  for (const [binName, dest] of [["ffmpeg", ffmpegDest], ["ffprobe", ffprobeDest]]) {
    const url = `${FFMPEG_STATIC_BASE}/${binName}-${platformKey}.gz`;
    log(`Downloading ${url}`);
    const bin = await downloadGzBinary(url);
    const hash = sha256(bin);

    if (pinned?.[binName] && pinned[binName] !== hash) {
      throw new Error(
        `Checksum mismatch for ${binName}-${platformKey} at tag ${FFMPEG_STATIC_TAG}: ` +
          `expected ${pinned[binName]}, got ${hash}. Refusing to bundle a changed asset ` +
          `— re-verify against the upstream builder before updating packaging/checksums.json.`,
      );
    }
    writeFileSync(dest, bin, { mode: 0o755 });
    log(`${binName}-${platformKey}: sha256 ${hash}${pinned?.[binName] ? " (verified against pin)" : " (new pin)"}`);
    recorded[binName] = hash;
  }

  checksums[key] = recorded;
  saveChecksums(checksums);

  try {
    const license = await downloadToBuffer(`${FFMPEG_STATIC_BASE}/${platformKey}.LICENSE`);
    writeFileSync(join(outDir, "LICENSE"), license);
    const readme = await downloadToBuffer(`${FFMPEG_STATIC_BASE}/${platformKey}.README`);
    writeFileSync(readmeDest, readme);
  } catch (err) {
    log(`Warning: could not fetch LICENSE/README for ${platformKey}: ${err.message}`);
  }

  return { ffmpeg: ffmpegDest, ffprobe: ffprobeDest };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const platform = get("--platform", process.platform);
  const arch = get("--arch", process.arch);
  const outDir = resolve(get("--out", join(repoRoot, "packaging", "vendor", "ffmpeg", `${platform}-${arch}`)));
  const force = args.includes("--force");
  const requirePinned = args.includes("--require-pinned");

  await fetchFfmpeg(`${platform}-${arch}`, outDir, { force, requirePinned });
  log(`Done. Binaries staged at ${outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`[fetch-ffmpeg] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
