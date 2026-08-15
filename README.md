# hfmpeg

An `ffmpeg`-style command line tool that renders a [HyperFrames](https://github.com/heygen-com/hyperframes)
HTML composition (a project directory or an `.html` file) to a video file
(`mp4`, `webm`, `mov`, `gif`, or a `png-sequence`).

```bash
hfmpeg render ./my-video -o out.mp4
```

All rendering work is delegated to the published `@hyperframes/producer`
package; `hfmpeg` owns argument parsing, dependency resolution, progress/JSON
output, exit codes, packaging, and releases. See
[`docs/00-PLAN.md`](docs/00-PLAN.md) for the full design rationale and
[`docs/00-COMMANDS.md`](docs/00-COMMANDS.md) for the complete command
reference.

## Installing

Download the latest release from the
[Releases page](../../releases/latest). Two channels are published for each
platform:

| Channel | Size | Requires | Resolves ffmpeg/Chromium from |
| --- | --- | --- | --- |
| **lite** | smaller | a host Node.js `>=22` | `PATH` / env vars / a shared cache |
| **standalone** | larger | nothing — zero host deps | bundled inside the archive |

Extract the archive and run the launcher directly — no install step:

```bash
# macOS / Linux
./bin/hfmpeg version
```

```powershell
# Windows
.\bin\hfmpeg.cmd version
```

Run `hfmpeg doctor` after extracting to confirm what it found (Node, FFmpeg,
FFprobe, Chromium — and, for a standalone archive, that every dependency's
`source` is `"bundled"`).

### Unsigned binaries

Releases are **not code-signed or notarized** for v1 — not a red flag about
the binary itself, just a certificate we don't have yet. Your OS will still
flag it on first run:

- **macOS** (Gatekeeper): `xattr -d com.apple.quarantine ./bin/hfmpeg`, or
  right-click the binary → *Open* once.
- **Windows** (SmartScreen): "Windows protected your PC" → *More info* →
  *Run anyway*.

Verify the archive you downloaded against the release's `SHA256SUMS` file
before running either workaround.

## Building from source

```bash
npm install
npm run build
node dist/cli.js version
```

Requires Node.js `>=22`. `npm run dev` runs the CLI directly from `src/` via
[`tsx`](https://github.com/privatenumber/tsx), no build step needed.

## Commands

| Command | Purpose |
| --- | --- |
| `render` | Render a composition to `mp4`/`webm`/`mov`/`gif`/`png-sequence`. |
| `probe` | Print composition metadata without rendering. |
| `lint` | Static HTML checks on a composition, no browser. |
| `doctor` | Report the environment: Node, FFmpeg, FFprobe, Chromium, and where each was resolved from. |
| `deps` | Manage the FFmpeg/Chromium dependencies (`status`, `chromium ensure\|path\|clear`, `ffmpeg path`). |
| `version` | Print `hfmpeg`'s version, build channel, and the pinned upstream package versions. |
| `completion` | Emit a shell completion script (`bash`, `zsh`, `fish`, `powershell`). |
| `help` | Usage for `hfmpeg` or one command. |

Every command accepts `--json` for a single, stable, machine-readable
document on stdout. See [`docs/00-COMMANDS.md`](docs/00-COMMANDS.md) for the
complete flag reference and exit codes.

## Packaging (for maintainers)

```bash
npm run package:lite         # produces packaging/out/hfmpeg-<version>-<os>-<arch>-lite.<ext>
npm run package:standalone   # + a bundled Node runtime, ffmpeg/ffprobe, and pinned chrome-headless-shell
```

Both build the archive for the *host* platform and then smoke-test the
packaged archive itself (not the source tree) — see
[`packaging/build.mjs`](packaging/build.mjs). Cross-platform matrix builds
happen in CI (`.github/workflows/release.yml`), one native runner per Tier 1
target; see [`docs/00-PLAN.md` §4](docs/00-PLAN.md) for why cross-assembly
from a single host is a fallback, not the validated path.

## Testing

```bash
npm test
```

Unit tests ([`node:test`](https://nodejs.org/api/test.html) via `tsx`) cover
the pure arg/fps/batch/composition-parsing layer — no browser required. CI
(`.github/workflows/ci.yml`) additionally builds and smoke-renders the
packaged lite archive on every Tier 1 OS for every push/PR.
