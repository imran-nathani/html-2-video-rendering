# hfmpeg

An `ffmpeg`-style command line tool that renders a [HyperFrames](https://github.com/heygen-com/hyperframes)
HTML composition (a project directory or an `.html` file) to a video file
(`mp4`, `webm`, `mov`, `gif`, or a `png-sequence`).

```bash
hfmpeg render ./my-video -o out.mp4
```

All rendering work is delegated to the published `@hyperframes/producer`
package; `hfmpeg` owns argument parsing, dependency resolution, progress/JSON
output, exit codes, packaging, and releases.

## Installing

Download the latest release from the
[Releases page](../../releases/latest). Two channels are published for each
platform — see [Lite vs. standalone](#lite-vs-standalone) below for which one
to pick.

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
[`tsx`](https://github.com/privatenumber/tsx), no build step needed — e.g.
`npm run dev -- render ./my-video -o out.mp4`.

## Lite vs. standalone

| | **lite** | **standalone** |
| --- | --- | --- |
| Download size | small (~50-60 MB compressed) | large (~250-300 MB compressed) |
| Requires | a host Node.js `>=22` on `PATH` | nothing — zero host dependencies |
| FFmpeg / FFprobe | resolved from `PATH`, an explicit flag/env var, or a project-local `.hyperframes/bin/` | bundled inside the archive |
| Chromium (`chrome-headless-shell`) | resolved from a shared cache (`hfmpeg deps chromium ensure` downloads it) or `PATH`/env var | bundled inside the archive, pinned to a known-good version |
| `hfmpeg doctor` reports | `source: "path"` / `"env"` / `"system"` for each dependency it found | `source: "bundled"` for every dependency |
| Good for | machines that already have (or don't mind installing) FFmpeg/Chromium; smaller CI images | air-gapped machines, one-off installs, "just works" out of the box |

Both channels are extract-and-run archives with the identical `hfmpeg`
command surface — the only difference is where FFmpeg/FFprobe/Chromium come
from. Run `hfmpeg doctor` after extracting either one to see exactly what
was found and where.

If you're on the **lite** channel and don't have FFmpeg/Chromium yet:

```bash
hfmpeg deps chromium ensure     # downloads the pinned chrome-headless-shell
# then install ffmpeg yourself (apt/brew/choco/winget/scoop, or a static
# build), and make sure it's on PATH, or point --ffmpeg-path / the
# HFMPEG_FFMPEG_PATH env var at it.
```

There's currently no `hfmpeg deps ffmpeg ensure` (no auto-download for
FFmpeg) — see the [FAQ](#faq) for why.

## Commands

| Command | Purpose |
| --- | --- |
| [`render`](#render) | Render a composition to `mp4`/`webm`/`mov`/`gif`/`png-sequence`. |
| [`probe`](#probe) | Print composition metadata without rendering. |
| [`lint`](#lint) | Static HTML checks on a composition, no browser. |
| [`doctor`](#doctor) | Report the environment: Node, FFmpeg, FFprobe, Chromium, and where each was resolved from. |
| [`deps`](#deps) | Manage the FFmpeg/Chromium dependencies (`status`, `chromium ensure\|path\|clear`, `ffmpeg path`). |
| [`version`](#version) | Print `hfmpeg`'s version, build channel, and the pinned upstream package versions. |
| [`completion`](#completion) | Emit a shell completion script (`bash`, `zsh`, `fish`, `powershell`). |
| [`help`](#help) | Usage for `hfmpeg` or one command. |

Every command accepts `--json` for a single, stable, machine-readable
document on stdout: `{ ok, command, hfmpeg: { version, channel }, data | error }`.

### Global flags

Recognised in any position, for every command:

| Flag | Default | Description |
| --- | --- | --- |
| `--verbose` | off | Extra diagnostics on stderr (resolved plan/engine config, timings). Implies `--log-level debug`. |
| `--log-level <level>` | `info` | `silent`, `error`, `warn`, `info`, `debug`. |
| `--no-color` | auto | Disable ANSI colour in `doctor`/`deps`/progress/error output (also honours the `NO_COLOR` env var). |
| `--tmp-dir <path>` | OS temp | Redirects render scratch space here (sets `TMPDIR` on POSIX, `TEMP`+`TMP` on Windows). Created if missing. |
| `--cache-dir <path>` | `~/.cache/hyperframes/chrome` | Default cache location for `hfmpeg deps chromium ensure\|clear` (its own `--cache-dir` still wins if both are given). |

`--json` and `--quiet`/`-q` are accepted by every command too, but are parsed
per-command rather than globally — `render` reserves `-q` for `--quality`, so
`--quiet` has no short form there.

---

### `render`

Render a composition to a video file.

```bash
# Project directory (renders its index.html)
hfmpeg render ./my-video -o out.mp4

# A specific composition file
hfmpeg render ./my-video -c compositions/intro.html -o intro.mp4

# ffmpeg-style shorthand: -i takes a directory OR an .html file
hfmpeg render -i ./my-video/index.html -o out.mp4

# Transparent overlay
hfmpeg render ./my-video --format webm -o overlay.webm

# 60 fps, high quality, hardware encoder
hfmpeg render ./my-video --fps 60 --quality high --gpu -o hd.mp4

# NTSC rational frame rate
hfmpeg render ./my-video --fps 30000/1001 -o ntsc.mp4

# Parametrised render
hfmpeg render ./my-video --variables '{"title":"Q4 Report"}' -o q4.mp4

# One output per row of a JSON array
hfmpeg render ./my-video --batch rows.json -o "renders/{name}.mp4" --json
```

**Input & output**

| Flag | Default | Description |
| --- | --- | --- |
| `[dir]` (positional) | `.` | Project directory. |
| `--input, -i <path>` | — | Alternative to the positional: a project directory **or** an `.html` file (split into dir + entry file automatically). |
| `--composition, -c <file>` | `index.html` | Entry HTML relative to the project dir. |
| `--output, -o <path>` | *required* | Output file, or a directory when `--format png-sequence`. Supports `{token}` substitution in `--batch` mode. |
| `--format <fmt>` | inferred from `-o` extension, else `mp4` | `mp4`, `webm`, `mov`, `gif`, `png-sequence`. `webm`/`mov`/`png-sequence` carry true alpha; `gif` is binary alpha. |
| `--overwrite, -y` | off | Overwrite an existing output. Without it, an existing file is an error (ffmpeg-like). |

Output width/height are **not** flags — they come from `data-width`/
`data-height` on the composition root. `--resolution` (below) is the only way
to change them.

**Timing & size**

| Flag | Default | Description |
| --- | --- | --- |
| `--fps, -f <n>` | root `data-fps`, else `30` | Integer `1..240`, or an ffmpeg rational (`30000/1001`, `24000/1001`, `60000/1001`). |
| `--resolution <preset>` | the composition's authored size | Supersample via Chrome's device scale factor: `landscape`, `portrait`, `landscape-4k`, `portrait-4k`, `square`, `square-4k`; aliases `1080p`, `4k`, `uhd`, `1080p-square`, `square-1080p`, `4k-square`. Not combinable with `--hdr` or an alpha format. |

**Quality & encoding**

| Flag | Default | Description |
| --- | --- | --- |
| `--quality, -q <q>` | `standard` | `draft`, `standard`, `high`. |
| `--crf <n>` | from `--quality` | Encoder CRF `0..51`. Mutually exclusive with `--video-bitrate`. |
| `--video-bitrate <rate>` | from `--quality` | e.g. `10M`, `5000k`. Mutually exclusive with `--crf`. |
| `--vp9-cpu-used <n>` | encoder default | libvpx-vp9 speed/quality trade-off `-8..8`. `--format webm` only. |
| `--gif-loop <n>` | `0` (infinite) | `0..65535`. `--format gif` only. |
| `--video-frame-format <f>` | `auto` | Source-video frame extraction: `auto`, `jpg`, `png`. |
| `--hdr` | off | Force HDR10 even without HDR sources. MP4 only; incompatible with alpha formats and `--resolution`. |
| `--sdr` | off | Force SDR even when HDR sources are detected. Mutually exclusive with `--hdr`. |

**Variables & batch**

| Flag | Default | Description |
| --- | --- | --- |
| `--variables <json>` | — | JSON object merged over the composition's `data-composition-variables` defaults. Wins over `--variables-file` when both are given. |
| `--variables-file <path>` | — | Read those overrides from a JSON file (single object). |
| `--strict-variables` | off | Fail instead of silently falling back when a declared variable has no value. |
| `--batch <path>` | — | A JSON array of row objects, or `{ "rows": [...] }`. One render per row. |
| `--batch-concurrency <n>` | `1` | Rows rendered at once. |
| `--batch-fail-fast` | off | Stop launching new rows after the first failure (in-flight rows still finish). |

In `--batch` mode, `-o` is a template: `renders/{name}.mp4` substitutes keys
from each row.

**Machine usage & limits**

| Flag | Default | Description |
| --- | --- | --- |
| `--workers, -w <n\|auto>` | `auto` | `1..24` Chrome workers. |
| `--gpu` | off | Hardware FFmpeg encoding. |
| `--browser-gpu` / `--no-browser-gpu` | auto | Host GPU for Chrome/WebGL capture, vs. deterministic software rendering. |
| `--low-memory-mode` / `--no-low-memory-mode` | auto (≤ 8 GB RAM) | Safe profile: 1 worker, screenshot capture, no calibration. Containers/CI should set this explicitly — detection reads host RAM. |
| `--page-side-compositing` / `--no-page-side-compositing` | on | Page-side WebGL for compatible SDR shader transitions. |
| `--experimental-fast-capture` / `--no-experimental-fast-capture` | on where it can engage | Faster Chrome draw-element capture; self-verifies and falls back. |
| `--frames-cache-dir <path>` | `<tmpdir>/hyperframes-extract-cache-<uid>` | Extracted-source-frame cache location. `off`/`none`/`false`/`0` disables it. |

**Timeouts**

| Flag | Unit | Default |
| --- | --- | --- |
| `--browser-timeout <s>` | seconds | `60` |
| `--player-ready-timeout <ms>` | milliseconds | `45000` |
| `--protocol-timeout <ms>` | milliseconds | `300000` (auto-scaled by pixel area) |

**Gates & diagnostics**

| Flag | Default | Description |
| --- | --- | --- |
| `--best-effort` / `--no-best-effort` | on | Finish with capture-readiness warnings, or fail when media is missing/unready. |
| `--strict` | off | Run the lint gate first; fail on lint errors before rendering. |
| `--strict-all` | off | Same, but warnings fail the gate too. |
| `--debug` | off | Keep intermediates and write extra render diagnostics. |
| `--progress <mode>` | `auto` | `auto` (bar on a TTY, plain lines otherwise), `bar`, `plain`, `json` (one NDJSON line per event, on stderr), `none`. |
| `--dry-run` | off | Resolve paths/binaries/config/duration/frame count and print the plan — no Chrome, no FFmpeg. |
| `--ffmpeg-path <path>` | resolved | Explicit FFmpeg binary for this render. Sets `HYPERFRAMES_FFMPEG_PATH`. |
| `--ffprobe-path <path>` | resolved | Explicit FFprobe binary. Sets `HYPERFRAMES_FFPROBE_PATH`. |
| `--chromium-path <path>` | resolved | Explicit Chrome/`chrome-headless-shell`. Sets `PRODUCER_HEADLESS_SHELL_PATH`. |

**`--json` result shape**

```json
{
  "ok": true,
  "command": "render",
  "data": {
    "output": "/abs/path/out.mp4",
    "format": "mp4",
    "fps": { "num": 30, "den": 1 },
    "outcome": "completed",
    "warnings": [],
    "totalFrames": 300,
    "framesRendered": 300,
    "durationSeconds": 10,
    "renderTimeMs": 41230
  },
  "hfmpeg": { "version": "0.1.0", "channel": "lite" }
}
```

`outcome` is `"completed"` or `"completed_with_warnings"` (under
`--best-effort`, still exit code `0`). A `--batch` render's `data` is
`{ rows: [...], succeeded, failed }` instead, one entry per row.

`SIGINT` (Ctrl-C) aborts the render through the producer's own abort signal
and exits with the cancelled code (`6`) once it's finished tearing down.

---

### `probe`

Metadata only — no frames, no encoder. The `ffprobe` of this tool.

```bash
hfmpeg probe ./my-video
hfmpeg probe ./my-video --json
hfmpeg probe ./my-video -c compositions/intro.html
hfmpeg probe ./my-video --compositions   # list every composition in the project
hfmpeg probe ./my-video --variables      # declared variables + defaults
hfmpeg probe ./my-video --assets         # asset inventory, with resolution status
```

Reports the composition id, `width`×`height`, `fps`, duration, clip/track
counts, element counts by type (`img`/`video`/`audio`/`canvas`/other),
declared variables, referenced sub-compositions, and external asset
references (flagging any local file that's missing).

| Flag | Description |
| --- | --- |
| `--composition, -c <file>` | Probe a specific entry file. |
| `--compositions` | List every composition in the project instead of describing one. |
| `--variables` | Print only the declared variable schema. |
| `--assets` | Print only the asset inventory. |
| `--fps <n>` | Also compute duration → frame count against this rate. |

### `lint`

Static HTML validation, no browser, fast — backed by the lint helpers
re-exported from `@hyperframes/producer`.

```bash
hfmpeg lint ./my-video
hfmpeg lint ./my-video --verbose   # include info-level findings
hfmpeg lint ./my-video --json
hfmpeg lint ./my-video --strict    # warnings fail too
```

| Flag | Description |
| --- | --- |
| `--composition, -c <file>` | Lint a specific entry file. |
| `--strict` | Exit non-zero on warnings as well as errors. |
| `--verbose` | Include info-level findings (hidden by default). |
| `--json` | `{ errorCount, warningCount, infoCount, findings[] }`. |

`render --strict`/`--strict-all` run this same gate automatically before
capturing any frames.

### `doctor`

```bash
hfmpeg doctor
hfmpeg doctor --json
```

Reports: `hfmpeg` version and build channel, the Node runtime in use,
the resolved `@hyperframes/producer` version, FFmpeg/FFprobe/Chromium (path
and where each was resolved from — `bundled`, `env`, or `system`), free/total
memory (and whether low-memory mode would auto-engage), and CPU core count.

`doctor` always exits `0` when the command itself ran — environment health
lives in the JSON payload's top-level `ok` field, so scripts should gate on
`hfmpeg doctor --json` and check `.ok`, not the exit code.

### `deps`

Manage the FFmpeg/Chromium dependencies. Most useful on the **lite**
channel; a standalone build already has both bundled.

```bash
hfmpeg deps status                  # same rows doctor prints, dependency-only
hfmpeg deps chromium ensure         # download the pinned chrome-headless-shell
hfmpeg deps chromium ensure --force # re-download even if a copy exists
hfmpeg deps chromium path           # print just the resolved path
hfmpeg deps chromium clear          # remove the downloaded copy
hfmpeg deps ffmpeg path             # print the resolved ffmpeg path
```

There is currently no `hfmpeg deps ffmpeg ensure` — see the
[FAQ](#faq) for why.

| Flag | Description |
| --- | --- |
| `--version <ver>` | Pin a specific Chromium version instead of the release default. |
| `--cache-dir <path>` | Install/inspect somewhere other than the default cache. |
| `--force` | Re-download even if a copy exists. |
| `--json` | Machine-readable output. |

### `version`

```bash
hfmpeg version
hfmpeg version --json
```

```json
{
  "ok": true,
  "command": "version",
  "data": {
    "hfmpeg": "0.1.0",
    "channel": "lite",
    "node": "v22.x",
    "platform": "win32-x64",
    "upstream": { "@hyperframes/producer": "0.7.103" },
    "chromiumPinned": "152.0.7928.2"
  }
}
```

### `help`

```bash
hfmpeg help
hfmpeg help render
hfmpeg render --help
```

Prints usage, a copy-pasteable example or two, and the flag list for the
given command (or the top-level command list with no argument).

### `completion`

```bash
hfmpeg completion bash        >> ~/.bashrc
hfmpeg completion zsh         > "${fpath[1]}/_hfmpeg"
hfmpeg completion fish        > ~/.config/fish/completions/hfmpeg.fish
hfmpeg completion powershell | Out-String | Invoke-Expression
```

---

## Environment variables

`hfmpeg` reads a small set of its own, and lets a much larger set reach the
upstream engine untouched (engine config is always built by taking the
engine's own defaults and layering env vars, then explicit `hfmpeg` flags on
top — a flag always wins, but an env var with no matching flag still takes
effect).

| Variable | Effect |
| --- | --- |
| `HFMPEG_FFMPEG_PATH` / `HFMPEG_FFPROBE_PATH` | Aliases; fill in `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` when those aren't already set. |
| `HFMPEG_CHROMIUM_PATH` | Alias for `PRODUCER_HEADLESS_SHELL_PATH`. |
| `HFMPEG_CACHE_DIR` | Default for `--cache-dir` (see `deps`). |
| `HFMPEG_NO_BUNDLED_BINARIES` | Standalone archives ignore their bundled binaries and resolve from `PATH`/env instead. |
| `HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH` | Upstream FFmpeg overrides — read fresh on every call, highest priority. |
| `PRODUCER_HEADLESS_SHELL_PATH`, `HYPERFRAMES_BROWSER_PATH` | Upstream Chromium overrides. |
| `HYPERFRAMES_EXTRACT_CACHE_DIR` | Extracted-source-frame cache location (same thing `--frames-cache-dir` sets). Accepts `off`/`none`/`false`/`0` to disable. |
| `HYPERFRAMES_EXTRACT_CACHE_MAX_MB` | Soft LRU budget for that cache, in MB. |
| `PRODUCER_LOW_MEMORY_MODE` | Tri-state: `true`/`on`/`1`, `false`/`off`/`0`, or unset for auto-detect from total RAM. |
| `PRODUCER_VP9_CPU_USED`, `PRODUCER_EXPERIMENTAL_FAST_CAPTURE`, `HF_PAGE_SIDE_COMPOSITING`, `PRODUCER_BROWSER_GPU_MODE` | Engine tuning knobs; each has a `--flag` equivalent on `render` that wins. |
| `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS`, `PRODUCER_PLAYER_READY_TIMEOUT_MS`, `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` | Fallbacks for `--browser-timeout`, `--player-ready-timeout`, `--protocol-timeout` (all in ms, even where the flag itself takes seconds). |
| `NO_COLOR` | Disable ANSI colour (same as the global `--no-color` flag). |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including `completed_with_warnings` under `--best-effort`). |
| `1` | Render failed. |
| `2` | Usage / validation error (bad flag, mutually exclusive flags, unparseable fps). |
| `3` | Missing dependency (FFmpeg, FFprobe, or Chromium not found). |
| `4` | Lint or strict gate failed. |
| `5` | Composition invalid (no composition root, zero duration, unreadable entry file). |
| `6` | Cancelled (`SIGINT`). |
| `7` | Output/IO error (output exists without `--overwrite`, unwritable path). |

## Packaging (for maintainers)

```bash
npm run package:lite         # produces packaging/out/hfmpeg-<version>-<os>-<arch>-lite.<ext>
npm run package:standalone   # + a bundled Node runtime, ffmpeg/ffprobe, and pinned chrome-headless-shell
```

Both build the archive for the *host* platform and then smoke-test the
packaged archive itself (not the source tree) — see
[`packaging/build.mjs`](packaging/build.mjs). Cross-platform matrix builds
happen in CI (`.github/workflows/release.yml`), one native runner per
platform (`win-x64`, `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`).

## Testing

```bash
npm test              # unit tests (node:test via tsx) — no browser required
npm run typecheck      # type-checks src/ and test/
```

Unit tests cover the pure arg/fps/batch/composition-parsing layer, the exact
`render` flag → engine-config mapping, exit-code handling, and the global
flag plumbing. `test/integration/` additionally has two tests that need a
real FFmpeg/Chromium toolchain (a golden-output regression render, and a
cancel/cleanup check) — both self-skip with a clear reason unless
`HFMPEG_INTEGRATION_TESTS=1` is set and the toolchain is actually available.
CI (`.github/workflows/ci.yml`) builds and smoke-renders the packaged lite
archive on every supported OS for every push/PR.

## FAQ

**What's the actual difference between lite and standalone?**
Nothing in the command surface — same flags, same output, same exit codes.
The only difference is where FFmpeg/FFprobe/Chromium come from: lite expects
you to already have them (or fetches Chromium on demand via
`deps chromium ensure`); standalone bundles pinned copies of all three so
the archive works with zero host dependencies. Run `hfmpeg doctor` on either
one to see exactly what it found.

**Where does hfmpeg look for FFmpeg/FFprobe/Chromium?**
In order: an explicit `--ffmpeg-path`/`--ffprobe-path`/`--chromium-path`
flag (on `render`), then `HYPERFRAMES_FFMPEG_PATH`/`HYPERFRAMES_FFPROBE_PATH`/
`PRODUCER_HEADLESS_SHELL_PATH`/`HYPERFRAMES_BROWSER_PATH` (or the `HFMPEG_*`
aliases above), then `PATH`, then a project-local `./.hyperframes/bin/`
folder relative to the current directory, then (for Chromium only) a shared
cache under `~/.cache/hyperframes/chrome` or `~/.cache/puppeteer`. Run
`hfmpeg doctor` to see which of these actually resolved each one.

**I don't have FFmpeg or Chromium — what do I do?**
For Chromium: `hfmpeg deps chromium ensure` downloads the exact pinned
version automatically. For FFmpeg: there's no auto-download today (see the
next question) — install it via your platform's package manager
(`apt`/`brew`/`choco`/`winget`/`scoop`) or grab a static build, and either
put it on `PATH`, drop it in `./.hyperframes/bin/`, or point `--ffmpeg-path`/
`HFMPEG_FFMPEG_PATH` at it. Or just use the **standalone** channel, which
needs none of this.

**Why is there a `deps chromium ensure` but no `deps ffmpeg ensure`?**
Chromium has a single trusted, versioned, checksummed distribution point
(the Chrome for Testing program) that's cheap and safe to script against.
FFmpeg doesn't have an equivalent upstream — static builds come from several
different third-party builders per platform, each with its own licensing
and provenance story, which is a bigger thing to take on trust
automatically. It's a real gap, just not implemented yet.

**My render failed instantly with exit code 3 — what happened?**
`render` checks that FFmpeg/FFprobe/Chromium are resolvable *before*
launching Chrome or capturing any frames, specifically so a missing
dependency fails in about a second instead of after a full (possibly
minutes-long) capture pass. Run `hfmpeg doctor` to see what's missing and
where `hfmpeg` looked for it.

**Why is the standalone archive so big?**
It bundles a full Node runtime, `chrome-headless-shell` (Chromium, minus the
browser UI), and static `ffmpeg`/`ffprobe` binaries — none of those compress
or shrink meaningfully, and none of it is optional if the goal is zero host
dependencies. The lite archive doesn't carry any of this.

**Why does my OS say this is unsafe to run?**
Releases aren't code-signed or notarized yet — see
[Unsigned binaries](#unsigned-binaries) above for the one-line workaround on
each platform. Always check `SHA256SUMS` against what you downloaded first.

**Can I run hfmpeg in Docker / CI / a headless environment?**
Yes — that's most of what `--low-memory-mode`, `--browser-gpu`/
`--no-browser-gpu`, and the standalone channel exist for. In a container,
explicitly pass `--low-memory-mode`/`--no-low-memory-mode` rather than
relying on auto-detection (it reads host RAM, which can be misleading
inside a container), and prefer `--no-browser-gpu` unless you've actually
wired up GPU passthrough.

**How do I make a transparent/overlay video?**
`--format webm` or `--format mov` for a real alpha channel (`--format gif`
also supports transparency, but it's binary — no partial alpha).
`png-sequence` is the losslessly-alpha option if you need individual frames.

**How do I script against hfmpeg?**
Pass `--json` to any command for one stable machine-readable document on
stdout (`{ ok, command, hfmpeg, data | error }`), and check the process exit
code against the [Exit codes](#exit-codes) table above. `--progress json`
additionally emits one NDJSON progress line per event on stderr during a
render, so stdout stays reserved for the final envelope.

**How do I cancel a running render?**
Ctrl-C (`SIGINT`). `hfmpeg` finishes cancelling cleanly and exits with code
`6`.

**Does hfmpeg send my composition or render anywhere?**
No. Everything runs locally — a local headless Chrome captures the frames,
a local FFmpeg encodes them. There's no telemetry, no network calls at
render time, and no update checks.

**What versions of FFmpeg/Chromium does this target?**
Chromium (`chrome-headless-shell`) is pinned per `hfmpeg` release — run
`hfmpeg version --json` and check `chromiumPinned`, or
`hfmpeg deps chromium ensure` to fetch exactly that version. FFmpeg isn't
version-pinned for the lite channel (whatever you have on `PATH` is used);
the standalone channel bundles a specific static build per platform.

**Can I build this myself for Linux/macOS from a Windows/Docker machine?**
Mechanically yes — the archive is a repackaging job (fetch the target
platform's Node/FFmpeg/Chromium, stage, zip), not a cross-compile, so any
host can assemble any target's *contents*. What you can't do without the
real OS is actually **run and smoke-test** the result — a Linux build can be
genuinely validated inside a Linux Docker container, but there's no way to
run or verify a macOS build without real Apple hardware (macOS can't be
virtualized in Docker on non-Apple hardware).
