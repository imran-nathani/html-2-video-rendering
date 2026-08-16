#!/usr/bin/env node
/**
 * packaging/release-notes.mjs — Phase 6 (00-PLAN.md §5): generates the
 * GitHub Release body. Prints to stdout; `release.yml` redirects it to a
 * file and passes that to `gh release create --notes-file`.
 *
 * Usage: node packaging/release-notes.mjs
 * (Run after `npm run build`, so `dist/meta.js` exists.)
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

async function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const { getHfmpegVersion, getProducerVersion, PINNED_CHROMIUM_VERSION } = await import(
    pathToFileURL(join(repoRoot, "dist", "meta.js")).href
  );

  const hfmpegVersion = getHfmpegVersion();
  const producerVersion = getProducerVersion() ?? "unknown";

  const notes = `# hfmpeg v${hfmpegVersion}

An ffmpeg-style CLI that renders HyperFrames HTML compositions to
mp4/webm/mov/gif/png-sequence. See the repo's README for the full command
reference.

## Upstream compatibility

| Component | Version |
| --- | --- |
| \`@hyperframes/producer\` (pinned) | ${pkg.dependencies["@hyperframes/producer"]} |
| \`@hyperframes/producer\` (resolved at build time) | ${producerVersion} |
| \`chrome-headless-shell\` (pinned) | ${PINNED_CHROMIUM_VERSION} |
| Node.js (bundled in standalone archives) | see \`packaging/fetch-node.mjs\`'s \`PINNED_NODE_VERSION\` |

## Which archive do I want?

- **lite** — smaller download; resolves \`ffmpeg\`/\`ffprobe\`/Chromium from
  your \`PATH\` or a shared cache. Requires a host Node.js ${pkg.engines.node}.
  Run \`hfmpeg doctor\` after extracting to check what it found.
- **standalone** — larger download; bundles its own Node runtime,
  \`ffmpeg\`/\`ffprobe\`, and the pinned Chromium build. Zero host
  dependencies. \`hfmpeg doctor\`/\`hfmpeg version --json\` report
  \`"channel": "standalone"\` and every dependency's \`source\` as
  \`"bundled"\`.

Both are unpack-and-run: extract the archive and invoke \`bin/hfmpeg\`
(\`bin\\hfmpeg.cmd\` on Windows).

## Unsigned binaries

These archives are **not code-signed or notarized** for v1 — no certificate,
not a security concern with the binary itself. Your OS will still flag them
on first run:

- **macOS**: Gatekeeper blocks it. Run \`xattr -d com.apple.quarantine
  ./bin/hfmpeg\` after extracting, or right-click the binary → *Open* once.
- **Windows**: SmartScreen shows "Windows protected your PC". Click *More
  info* → *Run anyway*.

Verify the archive you downloaded against \`SHA256SUMS\` (attached to this
release) before running either workaround.

## Third-party licenses (standalone only)

Standalone archives bundle FFmpeg (GPL v3) and Chromium's
\`chrome-headless-shell\` (BSD-style) as subprocess binaries — see each
archive's \`THIRD-PARTY-LICENSES/\` directory for license text and
corresponding-source URLs. \`hfmpeg\`'s own source stays under its own
license regardless; only the bundled *binaries* carry these obligations
("mere aggregation").
`;

  process.stdout.write(notes);
}

main().catch((err) => {
  process.stderr.write(`[release-notes] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
