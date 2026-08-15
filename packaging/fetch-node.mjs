#!/usr/bin/env node
/**
 * packaging/fetch-node.mjs — Phase 5 (00-PLAN.md §1/§4): downloads the
 * pinned Node.js runtime for one platform, so the **standalone** archive
 * needs nothing from the host ("Zero host deps" — the release matrix's
 * "Contains" column lists `node` for both channels; lite instead allows
 * "requires host Node" per §1, which is what `packaging/build.mjs` does).
 *
 * Verified against Node.js's own published `SHASUMS256.txt` (HTTPS, not a
 * full GPG chain-of-trust check of `SHASUMS256.txt.sig` — a reasonable
 * trade-off for this project's scope, called out explicitly rather than
 * silently skipped).
 *
 * Usage:
 *   node packaging/fetch-node.mjs [--platform <win32|darwin|linux>] [--arch <x64|arm64>] [--out <dir>] [--force]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/** Keep in sync with `package.json`'s `engines.node` (">=22"). */
export const PINNED_NODE_VERSION = "22.23.2";

const DIST_TOKENS = {
  "win32-x64": { token: "win-x64", ext: "zip", binaryRelPath: "node.exe" },
  "darwin-x64": { token: "darwin-x64", ext: "tar.gz", binaryRelPath: "bin/node" },
  "darwin-arm64": { token: "darwin-arm64", ext: "tar.gz", binaryRelPath: "bin/node" },
  "linux-x64": { token: "linux-x64", ext: "tar.gz", binaryRelPath: "bin/node" },
  "linux-arm64": { token: "linux-arm64", ext: "tar.gz", binaryRelPath: "bin/node" },
};

function log(message) {
  process.stdout.write(`[fetch-node] ${message}\n`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  // `tar` (bsdtar on Windows, GNU tar on Linux/macOS) auto-detects both
  // `.tar.gz` and `.zip` from content, so one code path covers every
  // platform — no `Expand-Archive`/`unzip` special-casing needed.
  const result = spawnSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar extraction failed for ${archivePath}`);
}

/**
 * Download + extract the pinned Node runtime for `platformKey` (e.g.
 * `win32-x64`) into `outDir/node/...`, returning the path to the `node`
 * binary itself.
 */
export async function fetchNode(platformKey, outDir, { force = false, version = PINNED_NODE_VERSION } = {}) {
  const dist = DIST_TOKENS[platformKey];
  if (!dist) {
    throw new Error(`Unsupported platform "${platformKey}". Expected one of: ${Object.keys(DIST_TOKENS).join(", ")}.`);
  }

  const archiveName = `node-v${version}-${dist.token}.${dist.ext}`;
  const extractedRoot = join(outDir, `node-v${version}-${dist.token}`);
  const binaryPath = join(extractedRoot, dist.binaryRelPath);

  if (!force && existsSync(binaryPath)) {
    log(`${platformKey}: already fetched at ${binaryPath} (pass --force to re-download).`);
    return binaryPath;
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const shasumsUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  log(`Fetching ${shasumsUrl}`);
  const shasums = (await downloadToBuffer(shasumsUrl)).toString("utf8");
  const expectedLine = shasums.split("\n").find((line) => line.trim().endsWith(archiveName));
  if (!expectedLine) {
    throw new Error(`SHASUMS256.txt for v${version} has no entry for ${archiveName}.`);
  }
  const expectedHash = expectedLine.trim().split(/\s+/)[0];

  const archiveUrl = `https://nodejs.org/dist/v${version}/${archiveName}`;
  log(`Downloading ${archiveUrl}`);
  const archiveBuffer = await downloadToBuffer(archiveUrl);
  const actualHash = sha256(archiveBuffer);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${archiveName}: expected ${expectedHash} (from Node.js's own SHASUMS256.txt), got ${actualHash}.`,
    );
  }
  log(`${archiveName}: sha256 ${actualHash} (matches Node.js's published SHASUMS256.txt)`);

  const archivePath = join(outDir, archiveName);
  writeFileSync(archivePath, archiveBuffer);
  extractArchive(archivePath, outDir);
  rmSync(archivePath, { force: true });

  if (!existsSync(binaryPath)) {
    throw new Error(`Extraction succeeded but expected binary not found at ${binaryPath}.`);
  }
  return binaryPath;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const platform = get("--platform", process.platform);
  const arch = get("--arch", process.arch);
  const version = get("--version", PINNED_NODE_VERSION);
  const outDir = resolve(get("--out", join(repoRoot, "packaging", "vendor", "node", `${platform}-${arch}`)));
  const force = args.includes("--force");

  const binaryPath = await fetchNode(`${platform}-${arch}`, outDir, { force, version });
  log(`Done. Node binary: ${binaryPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`[fetch-node] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
