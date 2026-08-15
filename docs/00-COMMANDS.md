# `hfmpeg` — command reference

> Implemented surface for the HyperFrames HTML → video CLI (see `docs/00-PLAN.md` §5 for phase
> status). Flag names deliberately mirror `hyperframes render` where an equivalent exists, so
> commands are copy-pasteable between the two tools (`00-PLAN.md` D6/D7).

```
hfmpeg <command> [input] [flags]
```

| Command | Purpose |
| --- | --- |
| [`render`](#render) | Render a composition to `mp4` / `webm` / `mov` / `gif` / `png-sequence`. The product. |
| [`probe`](#probe) | Print composition metadata without rendering (the `ffprobe` analogue). |
| [`lint`](#lint) | Static HTML checks on the composition. No browser. |
| [`doctor`](#doctor) | Report the environment: Node, FFmpeg, FFprobe, Chromium, CPU/RAM/disk, cache dirs. |
| [`deps`](#deps) | Manage the render dependencies (`chromium ensure/path/clear`, `ffmpeg path`). |
| [`version`](#version) | Print `hfmpeg` version, build channel, and the pinned upstream package versions. |
| [`help`](#help) | Usage for `hfmpeg` or one command. |
| [`completion`](#completion) | Emit a shell completion script. |

Deliberately absent: `preview`, `present`, `play`, `publish`, `init`, `add`, `catalog`,
`capture`, `transcribe`, `tts`, `remove-background`, `beats`, `check`, `snapshot`,
`keyframes`, `compare`, `benchmark`, `skills`, `figma`, `auth`, `cloud`, `lambda`,
`cloudrun`, `telemetry`, `feedback`, `upgrade`, `docs`.

---

## Global flags

Accepted by every command.

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | off | One machine-readable document on stdout, `{ ok, command, hfmpeg, data \| error }`. Suppresses decorative output. |
| `--quiet, -q` | off | Errors only. |
| `--verbose` | off | Extra diagnostics (resolved binaries, engine config, stage timings). |
| `--log-level <level>` | `info` | `silent`, `error`, `warn`, `info`, `debug`. |
| `--no-color` | auto | Disable ANSI colour (also honours `NO_COLOR`). |
| `--ffmpeg-path <path>` | resolved | Explicit FFmpeg binary. Sets `HYPERFRAMES_FFMPEG_PATH` for the run. |
| `--ffprobe-path <path>` | resolved | Explicit FFprobe binary. Sets `HYPERFRAMES_FFPROBE_PATH`. |
| `--chromium-path <path>` | resolved | Explicit Chrome / `chrome-headless-shell`. Sets `PRODUCER_HEADLESS_SHELL_PATH`. |
| `--tmp-dir <path>` | OS temp | Where render scratch directories are created. Sets `TMPDIR` (POSIX) / `TEMP`+`TMP` (Windows) for the process, so every temp-dir consumer (the engine's capture workDir, its frame-extraction cache, our own scratch usage) honours it, not just `hfmpeg`'s own code. Created if missing. |
| `--cache-dir <path>` | `~/.cache/hyperframes/chrome` | Where downloaded Chromium/FFmpeg live (lite builds). Sets a default for `hfmpeg deps chromium ensure\|clear` (which always accepts its own `--cache-dir` too — that wins when both are given). The default matches `@hyperframes/engine`'s own cache-scan directory (00-PLAN.md §2.2 item 4), not a `hfmpeg`-specific path, so `deps chromium ensure` requires no extra flag/env var for a render to auto-discover it. |
| `--version` | — | Same as `hfmpeg version`. |
| `--help, -h` | — | Same as `hfmpeg help [command]`. |

Never interactive. A missing required value fails immediately with a usage example.

`--verbose`, `--log-level`, `--no-color`, `--tmp-dir`, and `--cache-dir` are recognised in any
position, for every command (`src/args/global.ts` strips them from argv before command dispatch,
in `cli.ts`). `--json`/`--quiet` remain parsed per-command instead — `render` reserves `-q` for
`--quality`, so `--quiet`'s short form is deliberately absent there; see `args/parse.ts`.

---

## `render`

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

### Input & output

| Flag | Default | Description |
| --- | --- | --- |
| `[dir]` (positional) | `.` | Project directory. |
| `--input, -i <path>` | — | Alternative to the positional: a project directory **or** an `.html` file (split into dir + entry file automatically). |
| `--composition, -c <file>` | `index.html` | Entry HTML relative to the project dir. Sub-compositions using `<template>` wrappers must be referenced from the entry via `data-composition-src`. |
| `--output, -o <path>` | *required* (`00-PLAN.md` §9.1) | Output file, or a directory when `--format png-sequence`. Supports `{token}` substitution in `--batch` mode. |
| `--format <fmt>` | inferred from `-o` extension, else `mp4` | `mp4`, `webm`, `mov`, `gif`, `png-sequence`. `webm`/`mov`/`png-sequence` carry true alpha; `gif` is binary alpha. |
| `--overwrite, -y` | off | Overwrite an existing output. Without it, an existing file is an error (ffmpeg-like). |

### Timing & size

| Flag | Default | Description |
| --- | --- | --- |
| `--fps, -f <n>` | root `data-fps`, else `30` | Integer `1..240`, or an ffmpeg rational (`30000/1001`, `24000/1001`, `60000/1001`). |
| `--resolution <preset>` | the composition's authored size | Supersample via Chrome `deviceScaleFactor`: `landscape`, `portrait`, `landscape-4k`, `portrait-4k`, `square`, `square-4k`; aliases `1080p`, `4k`, `uhd`, `1080p-square`, `square-1080p`, `4k-square`. Aspect must match, scale must be a whole multiple, not with `--hdr`. |

Note: output width/height are **not** flags — they come from `data-width`/`data-height` on the
composition root. `--resolution` is the only way to change them.

### Quality & encoding

| Flag | Default | Description |
| --- | --- | --- |
| `--quality, -q <q>` | `standard` | `draft`, `standard`, `high`. Drives CRF/bitrate presets. |
| `--crf <n>` | from `--quality` | Override encoder CRF `0..51`. Mutually exclusive with `--video-bitrate`. |
| `--video-bitrate <rate>` | from `--quality` | e.g. `10M`, `5000k`. Mutually exclusive with `--crf`. |
| `--vp9-cpu-used <n>` | encoder default | libvpx-vp9 speed/quality trade-off `-8..8`, WebM only. Env: `PRODUCER_VP9_CPU_USED`. |
| `--gif-loop <n>` | `0` (infinite) | `0..65535`, `--format gif` only. |
| `--video-frame-format <f>` | `auto` | Source-video frame extraction: `auto`, `jpg`, `png`. Use `png` for UI recordings / screen captures. |
| `--hdr` | off | Force HDR10 even without HDR sources. MP4 only; incompatible with alpha formats. |
| `--sdr` | off | Force SDR even when HDR sources are detected. |

### Variables & batch

| Flag | Default | Description |
| --- | --- | --- |
| `--variables <json>` | — | JSON object merged over the composition's `data-composition-variables` defaults. |
| `--variables-file <path>` | — | Read those overrides from a JSON file (single object). |
| `--strict-variables` | off | Fail (instead of warn) on an undeclared or mistyped variable key. |
| `--batch <path>` | — | JSON array of rows, or `{ "rows": [...] }`. One render per row. |
| `--batch-concurrency <n>` | `1` | Rows rendered at once (each render already parallelises internally). |
| `--batch-fail-fast` | off | Stop launching rows after the first failure. |

In `--batch` mode `-o` is a template: `renders/{name}.mp4` substitutes keys from the row.

### Machine usage & limits

| Flag | Default | Description |
| --- | --- | --- |
| `--workers, -w <n\|auto>` | `auto` | `1..24` Chrome workers (~256 MB each). Auto weighs cores, RAM, and frame count. |
| `--gpu` | off | Hardware FFmpeg encoding (NVENC, VideoToolbox, AMF, VAAPI, QSV). |
| `--browser-gpu` / `--no-browser-gpu` | auto | Host GPU for Chrome/WebGL capture, or deterministic software (SwiftShader). |
| `--low-memory-mode` / `--no-low-memory-mode` | auto (≤ 8 GB RAM) | Safe profile: 1 worker, screenshot capture, no calibration. Env: `PRODUCER_LOW_MEMORY_MODE`. Containers should set this explicitly — detection reads host RAM. |
| `--page-side-compositing` / `--no-page-side-compositing` | on | Page-side WebGL for compatible SDR shader transitions (~6× faster). |
| `--experimental-fast-capture` / `--no-…` | on where it can engage | Chrome draw-element capture (~2× faster), self-verifies and falls back. Env: `PRODUCER_EXPERIMENTAL_FAST_CAPTURE`. |
| `--frames-cache-dir <path>` | `<tmpdir>/hyperframes-extract-cache-<uid>` | Extracted-source-frame cache location. `off`/`none`/`false`/`0` disables it. |
| `--max-concurrent-renders <n>` | `2` | Deferred — only relevant once server mode lands (`00-PLAN.md` §8). |

### Timeouts

| Flag | Unit | Default | Env fallback (ms) |
| --- | --- | --- | --- |
| `--browser-timeout <s>` | **seconds** | `60` | `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS` |
| `--player-ready-timeout <ms>` | ms | `45000` | `PRODUCER_PLAYER_READY_TIMEOUT_MS` |
| `--protocol-timeout <ms>` | ms | `300000`, auto-scaled by pixel area up to 30 min | `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` |

### Gates & diagnostics

| Flag | Default | Description |
| --- | --- | --- |
| `--best-effort` / `--no-best-effort` | on | Finish with capture-readiness warnings, or fail when media is missing/unready. |
| `--strict` | off | Fail on lint errors before rendering. |
| `--strict-all` | off | Fail on lint errors **and** warnings. |
| `--debug` | off | Keep intermediates and write render diagnostics. |
| `--progress <mode>` | `auto` | `auto`, `bar`, `plain`, `json`, `none`. `json` emits one NDJSON line per progress event. |
| `--dry-run` | off | Resolve everything (paths, binaries, config, duration, frame count) and print the plan without rendering. |

### `--json` result shape (draft)

```json
{
  "ok": true,
  "command": "render",
  "hfmpeg": { "version": "1.0.0", "channel": "standalone" },
  "data": {
    "output": "/abs/path/out.mp4",
    "format": "mp4",
    "width": 1920, "height": 1080,
    "fps": { "num": 30, "den": 1 },
    "durationSeconds": 10.5,
    "totalFrames": 315,
    "bytes": 4821004,
    "outcome": "completed",
    "warnings": [],
    "renderTimeMs": 41230,
    "dependencies": {
      "ffmpeg":   { "path": "…/bin/ffmpeg",   "source": "bundled", "version": "7.1" },
      "chromium": { "path": "…/chrome-headless-shell", "source": "bundled", "version": "152.0.7928.2" }
    }
  }
}
```

`SIGINT` aborts the render through the producer's abort signal, cleans up Chrome/FFmpeg children
and the scratch directory, and exits with the cancelled code.

---

## `probe`

Metadata only — no frames, no encoder. The `ffprobe` of this tool.

```bash
hfmpeg probe ./my-video
hfmpeg probe ./my-video --json
hfmpeg probe ./my-video -c compositions/intro.html
hfmpeg probe ./my-video --compositions   # list every composition in the project
hfmpeg probe ./my-video --variables      # declared variables + defaults
```

Reports: composition id, `width`×`height`, duration, `data-fps`, clip/track counts, element counts
by type (`img`/`video`/`audio`/`canvas`), declared variables, referenced sub-compositions,
external assets (with missing-file flags), whether HDR or alpha sources are present, and the
frame count that a given `--fps` would produce.

| Flag | Description |
| --- | --- |
| `--composition, -c <file>` | Probe a specific entry file. |
| `--compositions` | List all compositions instead of describing one. |
| `--variables` | Print only the declared variable schema. |
| `--assets` | Print only the asset inventory, with resolution status. |
| `--fps <n>` | Compute duration → frame count against this rate. |

## `lint`

Static HTML validation, no browser, fast. Backed by the lint helpers re-exported from
`@hyperframes/producer`.

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

## `doctor`

```bash
hfmpeg doctor
hfmpeg doctor --json
```

Rows: `hfmpeg` version and build channel · Node runtime (bundled vs host) · FFmpeg + FFprobe
(path, version, **and which resolution step won**) · Chromium (path, version, cache location) ·
CPU cores · total/free RAM and whether low-memory mode would auto-engage · free disk on the temp
and frames-cache directories · `/dev/shm` size on Linux · relevant env overrides currently set.

Because v1 archives are **not code-signed**, `doctor` also prints the platform unblock hint when it
detects a quarantined / SmartScreen-blocked install (macOS: `xattr -d com.apple.quarantine ./hfmpeg`).

`--json` always exits `0` when the command itself ran; health lives in the payload's `ok` field,
so CI gates on `hfmpeg doctor --json | jq -e '.ok'`. Home directories are redacted to `$HOME` in
JSON mode so output is safe to paste into an issue.

## `deps`

Manage the two external dependencies. Most useful in **lite** builds; in standalone builds these
commands report the bundled copies and refuse to download unless `--force` is given.

```bash
hfmpeg deps status                  # same rows doctor prints, dependency-only
hfmpeg deps chromium ensure         # download the pinned chrome-headless-shell
hfmpeg deps chromium ensure --force # discard a partial/corrupt download and refetch
hfmpeg deps chromium path           # print just the path (composes: $(hfmpeg deps chromium path))
hfmpeg deps chromium clear          # remove the downloaded copy
hfmpeg deps ffmpeg path             # print the resolved ffmpeg path
hfmpeg deps ffmpeg ensure           # only if we adopt fetch-on-first-run (00-PLAN.md Q3)
```

| Flag | Description |
| --- | --- |
| `--version <ver>` | Pin a specific Chromium version instead of the release's default. |
| `--cache-dir <path>` | Install/inspect somewhere other than the default cache. |
| `--force` | Re-download even if a copy exists. |
| `--json` | Machine-readable status. |

## `version`

```bash
hfmpeg version
hfmpeg version --json
```

```json
{
  "ok": true,
  "command": "version",
  "data": {
    "hfmpeg": "1.0.0",
    "channel": "standalone",
    "node": "22.x",
    "platform": "win32-x64",
    "upstream": { "@hyperframes/producer": "0.7.103" },
    "chromiumPinned": "152.0.7928.2"
  }
}
```

## `help`

```bash
hfmpeg help
hfmpeg help render
hfmpeg render --help
```

Grouped flag output (input/output, timing, quality, variables, machine, timeouts, gates) rather
than one flat wall, plus three copy-pasteable examples per command.

## `completion`

```bash
hfmpeg completion bash   >> ~/.bashrc
hfmpeg completion zsh    > "${fpath[1]}/_hfmpeg"
hfmpeg completion fish   > ~/.config/fish/completions/hfmpeg.fish
hfmpeg completion powershell | Out-String | Invoke-Expression
```

---

## Environment variables

`hfmpeg` reads its own small set and lets the rest reach the upstream engine.

**Why these stay live.** `hfmpeg` builds its engine config as `resolveConfig(flagOverrides)` rather
than as a literal object, so the merge order is **engine defaults ← env vars ← `hfmpeg` flags**. A flag
always beats an env var; an env var with no matching flag still takes effect. (Passing a hand-built
config object would have silenced the `PRODUCER_*` / `HF_*` / `FFMPEG_*` rows entirely — see
`00-PLAN.md` §2.4 / D11.)

The `HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH`, and `HYPERFRAMES_BROWSER_PATH` rows are
outside the engine config altogether — they are re-read from the environment at each call site, so
they are unaffected by config construction either way.

| Variable | Effect |
| --- | --- |
| `HFMPEG_FFMPEG_PATH` / `HFMPEG_FFPROBE_PATH` | Our aliases; map onto `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH`. |
| `HFMPEG_CHROMIUM_PATH` | Maps onto `PRODUCER_HEADLESS_SHELL_PATH`. |
| `HFMPEG_CACHE_DIR` | Default `--cache-dir`. |
| `HFMPEG_NO_BUNDLED_BINARIES` | Standalone builds ignore their bundled binaries and resolve from `PATH`. |
| `HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH` | Upstream FFmpeg overrides (highest priority in the resolver). |
| `PRODUCER_HEADLESS_SHELL_PATH`, `HYPERFRAMES_BROWSER_PATH` | Upstream Chromium overrides. |
| `HYPERFRAMES_EXTRACT_CACHE_DIR` | Extracted-frame cache location (`--frames-cache-dir`). Accepts `off`/`none`/`false`/`0` to disable. |
| `HYPERFRAMES_EXTRACT_CACHE_MAX_MB` | Soft LRU budget for that cache, in MB. |
| `PRODUCER_LOW_MEMORY_MODE` | Tri-state: `true`/`on`/`1`, `false`/`off`/`0`, or unset for auto-detect from total RAM. |
| `PRODUCER_VP9_CPU_USED`, `PRODUCER_EXPERIMENTAL_FAST_CAPTURE`, `HF_PAGE_SIDE_COMPOSITING`, `PRODUCER_FORCE_SCREENSHOT`, `PRODUCER_BROWSER_GPU_MODE`, `PRODUCER_MAX_WORKERS` | Engine tuning; each has a `--flag` equivalent that wins. |
| `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS`, `PRODUCER_PLAYER_READY_TIMEOUT_MS`, `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` | Timeout fallbacks for `--browser-timeout`, `--player-ready-timeout`, `--protocol-timeout` (all in ms, even where the flag takes seconds). |
| `PRODUCER_PUPPETEER_LAUNCH_TIMEOUT_MS` | Separate knob — Chrome **launch** budget, not page navigation. No `hfmpeg` flag. |
| `FFMPEG_ENCODE_TIMEOUT_MS`, `FFMPEG_PROCESS_TIMEOUT_MS`, `FFMPEG_STREAMING_TIMEOUT_MS` | Encoder timeouts. |
| `NO_COLOR` | Disable colour. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including `completed_with_warnings` under `--best-effort`). |
| `1` | Render failed. |
| `2` | Usage / validation error (bad flag, mutually exclusive flags, unparseable fps). |
| `3` | Missing dependency (FFmpeg, FFprobe, Chromium). |
| `4` | Lint or strict gate failed. |
| `5` | Composition invalid (no composition root, zero duration, unreadable entry file). |
| `6` | Cancelled (`SIGINT` / `SIGTERM`). |
| `7` | Output or IO error (output exists without `--overwrite`, unwritable path, disk full). |
