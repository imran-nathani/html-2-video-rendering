# `hfmpeg` — HyperFrames HTML → MP4/WebM renderer CLI

> Status: **implemented — Phases 0-7 (§5) are all in place.** This document
> is kept as the design record/rationale (decisions in §7 still hold); it is
> no longer a forward-looking plan. See the README and `00-COMMANDS.md` for
> the current, accurate command/flag surface, and §5 below for what each
> phase actually shipped.
> Repo: `html-2-video-rendering` · Reference checkout: `../hyperframes` (upstream monorepo, Apache-2.0)

---

## 1. What we are building

A single-purpose, ffmpeg-style command line tool called **`hfmpeg`** that takes a HyperFrames
HTML composition (a project directory or an `.html` file) and produces a video file
(`mp4`, `webm`, `mov`, `gif`, `png-sequence`).

- **Thin args layer.** All rendering work is delegated to the published upstream packages
  (`@hyperframes/producer`, which internally uses `@hyperframes/engine`, `@hyperframes/core`,
  `@hyperframes/parsers`, `@hyperframes/lint`). We own: argument parsing, validation,
  binary/dependency resolution, progress/JSON output, exit codes, packaging, releases.
- **No previewer, no studio, no scaffolding, no AI/agent surface.** Explicitly out of scope:
  `preview`, `present`, `play`, `publish`, `init`, `add`, `catalog`, `capture`, `transcribe`,
  `tts`, `remove-background`, `beats`, `skills`, `figma`, `auth`, `cloud`, `lambda`,
  `cloudrun`, telemetry, feedback prompts, auto-update nags.
- **Distributed like ffmpeg.** GitHub Releases carry per-OS/arch archives:
  - **standalone** — bundles Node runtime + `ffmpeg`/`ffprobe` + `chrome-headless-shell`. Zero host deps.
  - **lite** — bundles only our JS + Node runtime (or requires host Node), and resolves
    `ffmpeg`, `ffprobe`, and Chromium from `PATH` / env vars.

---

## 2. What the research established (upstream facts we build on)

### 2.1 The real producer API (the README is stale)

`packages/producer/README.md` shows `executeRenderJob(job, progress)` with `inputPath`/
`width`/`height` in the config. The actual source is different:

```ts
// packages/producer/src/services/renderOrchestrator.ts
export type RenderConfigInput = Omit<RenderConfig, "fps"> & { fps: FpsInput };
export function createRenderJob(config: RenderConfigInput): RenderJob;
export async function executeRenderJob(
  job: RenderJob,
  projectDir: string,
  outputPath: string,
  progressSink?: ProgressCallback,
  abortSignal?: AbortSignal,
): Promise<void>;
```

Consequences for our arg layer:

- The unit of work is a **project directory + `entryFile`** (default `index.html`), not a single file.
  A bare `.html` path must be normalised to `{ projectDir: dirname, entryFile: basename }`.
- **Output dimensions are NOT config inputs.** They come from `data-width` / `data-height` on the
  `[data-composition-id]` root; `--resolution` only supersamples via Chrome `deviceScaleFactor`
  (integer multiple, matching aspect, not with HDR).
- `fps` is an exact rational (`{ num, den }`) — `createRenderJob` accepts `FpsInput`, so
  `30000/1001` style args are supported. Default resolution order: `--fps` → root `data-fps` → 30.
- `RenderConfig` fields we can expose 1:1: `fps`, `quality`, `format`, `gifLoop`, `workers`,
  `useGpu`, `debug`, `strictness`, `entryFile`, `producerConfig` (full `EngineConfig` override),
  `logger`, `crf`, `videoBitrate`, `videoFrameFormat`, `hdrMode`, `variables`,
  `outputResolution`, `outputResolutionAspectAgnostic`.
- Everything else in the upstream CLI's `render` (timeouts, low-memory mode, page-side
  compositing, fast capture, frames cache dir) is reached either through `producerConfig`
  (`EngineConfig`) or through env vars read by `@hyperframes/engine`'s `resolveConfig`.
- Progress is a callback `(job, message)` with `job.progress` 0..1 — enough for a
  TTY progress bar and for `--progress json` line output.
- Useful extras already exported from `@hyperframes/producer`: `prepareHyperframeLintBody` /
  `runHyperframeLint` (so `hfmpeg lint` needs no extra dep), `getCompositionDuration`,
  `resolveRenderPaths`, `RenderCancelledError`, `normalizeErrorMessage`, `resolveConfig`.

### 2.2 Binary resolution is already env-driven — this is what makes standalone/lite cheap

`packages/parsers/src/ffBinaries.ts` resolves FFmpeg in this order:

1. `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` (env override, re-read every call)
2. `PATH` scan (native scan on Windows incl. `PATHEXT` + cwd; `which` + PATH scan on Unix)
3. project-local `./.hyperframes/bin/ffmpeg[.exe]`
4. well-known Unix dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/snap/bin`)
5. last resort: bare name `ffmpeg` (so the spawn error names what to install)

`packages/engine/src/services/browserManager.ts` → `resolveHeadlessShellPath()`:

1. `EngineConfig.chromePath`
2. `PRODUCER_HEADLESS_SHELL_PATH` (throws if set-but-missing)
3. `HYPERFRAMES_BROWSER_PATH` (throws if set-but-missing)
4. `~/.cache/hyperframes/chrome/chrome-headless-shell/<version>/…`
5. `~/.cache/puppeteer/chrome-headless-shell/<version>/…`
6. otherwise `undefined` → Puppeteer's own bundled Chrome is used

So:

- **standalone** = ship the binaries inside the release dir and have the `hfmpeg` launcher set
  `HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH`, `PRODUCER_HEADLESS_SHELL_PATH`
  to the bundled copies (unless the user already set them, or passed `--ffmpeg-path` etc.).
- **lite** = set nothing, let the upstream resolvers use `PATH`; `hfmpeg doctor` explains what is missing.
- Upstream pins Chrome `152.0.7928.2` (`packages/cli/src/browser/manager.ts`) and installs via
  `@puppeteer/browsers` into `~/.cache/hyperframes/chrome`. We should pin the **same** version
  per release so the lite build can reuse an existing hyperframes cache, and so renders match.
- Chromium determinism note: `chrome-headless-shell` + BeginFrame is the deterministic path;
  alpha formats (`webm`/`mov`/`png-sequence`/`gif`) force screenshot capture.

### 2.3 Packaging constraints discovered (this drives the whole release design)

`packages/producer/build.mjs` and the runtime loaders reveal that `@hyperframes/producer`
is **not** a self-contained single JS file:

- `external: ["puppeteer", "esbuild", "postcss"]` — these must exist as real `node_modules`.
- `hyperframeRuntimeLoader.ts` reads a **sibling** `hyperframe.manifest.json` + the runtime
  `*.iife.js` off disk (`dirname(fileURLToPath(import.meta.url))`) and verifies its sha256.
  Overridable with `PRODUCER_HYPERFRAME_MANIFEST_PATH`.
- Worker entrypoints are separate files spawned by path: `dist/services/shaderTransitionWorker.js`,
  `dist/services/healthWorkerThread.js`.
- Fonts are baked in from `@fontsource/*` at producer build time.
- `resolveRenderPaths` derives its default renders dir from the producer module's own location
  (`PRODUCER_RENDERS_DIR` overrides). Our CLI should always pass an explicit output path so
  nothing ever lands next to the bundled runtime.

**Therefore: do not attempt a true single-file executable (Node SEA / `bun build --compile`) for v1.**
The realistic shape is an **archive** containing a Node runtime, a pruned `node_modules`
(`@hyperframes/*`, `puppeteer`/`puppeteer-core`, `postcss`, `esbuild`, `hono`, `linkedom`, …),
our thin CLI, and (standalone only) `bin/ffmpeg`, `bin/ffprobe`, `bin/chrome-headless-shell/`,
plus a tiny native launcher/shim named `hfmpeg` / `hfmpeg.exe`. A single-file build can be
revisited later if we vendor+patch the on-disk asset lookups.

### 2.4 `producerConfig` vs env vars — the conflict, and the resolution

The doc comment on `RenderConfig.producerConfig` says *"When provided, env vars are not read"*
(`renderOrchestrator.ts:323-324`), and it is literally true — the orchestrator does:

```ts
const cfg = { ...(job.config.producerConfig ?? resolveConfig()) };  // renderOrchestrator.ts:1994
```

So passing a hand-built `EngineConfig` object **silences every engine env var**. That would make
half of `00-COMMANDS.md`'s env table dead on arrival.

**Resolution: never construct an `EngineConfig` literal. Always pass
`producerConfig: resolveConfig(overridesFromFlags)`.** `resolveConfig` is exported from
`@hyperframes/producer` and merges in exactly the order we want
(`packages/engine/src/config.ts:886-890`):

```
DEFAULT_CONFIG  ←  env vars  ←  our explicit flag overrides
```

This gives us all three properties at once: env vars stay live, our flags win over env, and
`runtime/env.ts` stays one small typed adapter that only maps the flags it actually owns.

The *reason* this matters beyond convenience — `resolveConfig` is not a dumb merge. It also applies
host-adaptive and derived logic we must not reimplement:

- the default-on `useDrawElement` host clamp (`resolveDefaultDrawElement`, platform + GPU mode + worker-encode)
- software-GPU → `forceScreenshot` coercion, with explicit-opt-out provenance tracking
- the win32 software-GPU compound auto-disable of `enableStreamingEncode`
- memory-adaptive `frameDataUriCache*` limits, and the `lowMemoryMode` tri-state (`true`/`false`/auto-from-RAM)
- `HYPERFRAMES_EXTRACT_CACHE_DIR` alias parsing (`off`/`none`/`false`/`0`)

A hand-built object would also **fail validation** on the serialized/distributed path:
`validateEngineConfigSnapshot` requires *every* `DEFAULT_CONFIG` key to be present and rejects
unknown fields (`config.ts:411-423`). Only a fully resolved snapshot is legal there.

Two further details the adapter must respect:

- **`chromePath` is env-fed too.** `resolveConfig` reads `PRODUCER_HEADLESS_SHELL_PATH` into
  `chromePath` (`config.ts:790`), so `--chromium-path` is passed as an *override* and precedence
  falls out for free (flag > env > cache scan). `HYPERFRAMES_BROWSER_PATH` is **not** an
  `EngineConfig` field — `browserManager` reads it directly, so it survives regardless.
- **`HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` are not `EngineConfig` fields at all.**
  `ffBinaries` re-reads them from `process.env` on every call, so they are immune to this whole
  question — which is also why setting them is the correct standalone-bundle mechanism (§2.2).
- **Do not push our `--fps` into `producerConfig.fps`.** `EngineConfig.fps` is typed `24 | 30 | 60`
  and validated as such; render frame rate belongs on `RenderConfig.fps`, which accepts any
  `FpsInput` rational.

### 2.5 Licensing / distribution facts

- Upstream HyperFrames is **Apache-2.0** — vendoring/depending is fine with attribution.
- The npm packages exist and are published (`hyperframes`, `@hyperframes/core|engine|producer|studio`,
  currently the `0.7.x` line). We can consume them from the registry; no need to vendor source.
- **FFmpeg: subprocess-only, so our source stays permissive.** We invoke `ffmpeg`/`ffprobe` as
  child processes (upstream does this via `spawn` in `packages/engine/src/utils/runFfmpeg.ts`) and
  never link against libav*. That means **no GPL obligation on the `hfmpeg` source**, even when the
  bundled binary is a GPL build.
  The remaining obligation applies **only to the bundled binary we redistribute** ("mere
  aggregation"): ship its license text and provide **corresponding source** — in practice a
  documented URL to the exact upstream build's sources. Handled by a `THIRD-PARTY-LICENSES` file
  plus a source-offer line in the release notes. Not a blocker; a Phase 5 checklist item.
- Chromium/`chrome-headless-shell` redistribution: BSD-style, needs the LICENSE files carried along.
- Standalone archives will be flagged by macOS Gatekeeper and Windows SmartScreen because we are
  **not** code-signing for v1. Mitigation is documentation, not a certificate: the README, the
  release notes, and `hfmpeg doctor` all print the unblock steps
  (`xattr -d com.apple.quarantine ./hfmpeg` on macOS; "More info → Run anyway" on Windows).

---

## 3. Proposed architecture

```
html-2-video-rendering/
  docs/                     00-PLAN.md, 00-COMMANDS.md, …
  src/
    cli.ts                  entry: arg dispatch, global flags, exit codes
    commands/
      render.ts             the one that matters
      probe.ts              composition metadata (ffprobe analogue)
      lint.ts               static HTML checks (via producer's lint re-exports)
      doctor.ts             environment report
      deps.ts               chromium/ffmpeg ensure|path|clear (lite builds)
      version.ts, help.ts, completion.ts
    args/
      parse.ts              flag table → typed options (no interactive prompts, ever)
      validate.ts           mutual exclusions, ranges, format/extension coherence
      fps.ts                integer + rational parsing
      resolution.ts         preset + aspect-agnostic alias handling
      batch.ts              --batch rows, concurrency, {token} output templates
    runtime/
      binaries.ts           resolve + inject HYPERFRAMES_*_PATH / PRODUCER_HEADLESS_SHELL_PATH
      producer.ts           single lazy import boundary for @hyperframes/producer
      env.ts                flags → Partial<EngineConfig>, handed to resolveConfig() (never a
                            hand-built EngineConfig literal — see §2.4)
    output/
      progress.ts           TTY bar; --progress none|plain|json
      json.ts               stable machine envelope for every command
      errors.ts             error classes → exit codes + actionable hints
  packaging/
    build.mjs               bundle CLI, prune node_modules, stage runtime assets
    fetch-ffmpeg.mjs        per-platform ffmpeg/ffprobe acquisition (standalone)
    fetch-chromium.mjs      pinned chrome-headless-shell via @puppeteer/browsers
    launcher/               shell + .cmd (or small Go/Rust) shim that sets env then execs node
  .github/workflows/
    ci.yml                  lint, typecheck, unit tests, smoke render on each Tier 1 runner
    release.yml             tag → matrix build → archives + SHA256SUMS → GitHub Release
```

Design rules:

- **Zero heavy imports at startup.** `@hyperframes/producer` cold-imports slowly; only load it
  inside the command that needs it, so `hfmpeg --help` / `hfmpeg version` / `hfmpeg doctor` stay instant.
- **Never prompt.** Every input is a flag or env var; a missing required value fails with usage.
- **`--json` on everything**, one final document per invocation, wrapped in a stable envelope
  (`{ ok, command, hfmpeg: {version, channel}, data | error }`).
- **Deterministic by default**: no telemetry, no network at render time, no update checks.
- **Stable exit codes** (draft): `0` ok · `1` render failure · `2` usage/validation error ·
  `3` missing dependency (ffmpeg/chromium/node) · `4` lint/strict gate failed ·
  `5` composition invalid / zero duration · `6` cancelled (SIGINT → abort signal) ·
  `7` output/IO error. Warnings-only success under `--best-effort` stays `0`
  (surfaced as `outcome: "completed_with_warnings"`).

### Release channel detection

The binary reports which build it is (`hfmpeg version --json` → `"channel": "standalone" | "lite"`)
and where each dependency came from (`bundled` | `env` | `path` | `cache` | `flag`), because
"which ffmpeg did it actually use" is the single most common support question for a tool like this.

---

## 4. Release matrix (draft)

**Tier 1** — full standalone + lite, smoke-rendered in CI on a real runner:

| Asset | OS/arch | Contains |
| --- | --- | --- |
| `hfmpeg-<ver>-win-x64-standalone.zip` | Windows x64 | node, CLI, node_modules, ffmpeg+ffprobe, chrome-headless-shell |
| `hfmpeg-<ver>-linux-x64-standalone.tar.gz` | Linux x64 (glibc) | same |
| `hfmpeg-<ver>-macos-arm64-standalone.tar.gz` | macOS arm64 | same |
| `hfmpeg-<ver>-macos-x64-standalone.tar.gz` | macOS x64 | same |
| `hfmpeg-<ver>-<os>-<arch>-lite.tar.gz` / `.zip` | all of the above | node, CLI, node_modules only |
| `SHA256SUMS` | — | integrity (unsigned for v1 — no code-signing identity) |

**Tier 2** — best-effort, lite only:

| Asset | OS/arch | Why it is not Tier 1 |
| --- | --- | --- |
| `hfmpeg-<ver>-linux-arm64-lite.tar.gz` | Linux arm64 | Chrome for Testing publishes **no** linux-arm64 headless shell; needs Playwright's Chromium build, so the standalone bundle can't be assembled from the same source as the others |

### Building macOS/Linux artifacts without owning that machine

The archive is a **repackaging** job, not a compile: per-platform Node runtime tarball +
per-platform `chrome-headless-shell` + per-platform ffmpeg + our platform-agnostic JS. Any host
can assemble any target. Two things to get right, and one limit:

- **Exec bits and symlinks must be written explicitly** into the tar (Windows filesystems don't
  carry a mode). Our tar writer stamps `0o755` on `bin/*` and the launcher.
- **No signing** without a Mac — accepted for v1 (see §2.5).
- **We cannot smoke-test macOS locally.** GitHub Actions provides macOS arm64 and x64 runners
  free for public repos, so CI builds *and actually renders on real hardware* for every Tier 1
  target. Cross-assembly from a single host is the fallback for local/emergency builds, never the
  validated path.

A `bun build --compile --target=bun-darwin-arm64` cross-compile would also work in principle, but
it only pays off for a true single-file binary — which §2.3 rules out for v1. Bun stays a possible
later optimization, not a v1 dependency.

---

## 5. Implementation phases

**Phase 0 — decisions.** ✅ Done — see §7.

**Phase 1 — walking skeleton.** ✅ Done. `hfmpeg render <dir> -o out.mp4` on top of `@hyperframes/producer`
with `--fps --format --quality --output --composition --workers --quiet --json`. Plus `hfmpeg version`,
`hfmpeg help`, `hfmpeg doctor`. Runs from a repo checkout with `node`. (`src/commands/render.ts`,
`version.ts`, `help.ts`, `doctor.ts`.)

**Phase 2 — full render surface.** ✅ Done. Every flag in `00-COMMANDS.md`: crf/bitrate/vp9, hdr/sdr,
resolution presets, variables + variables-file + strict-variables, batch + concurrency +
fail-fast + `{token}` output templates, timeouts, low-memory, gpu/browser-gpu, frames-cache-dir,
best-effort/strict/strict-all, debug. Progress bar + `--progress json`. SIGINT → abort. The
"Global flags" table (`--verbose`, `--log-level`, `--no-color`, `--tmp-dir`, `--cache-dir`) is
handled uniformly for every command via `src/args/global.ts`, rather than re-parsed per command
(`--json`/`--quiet` stay per-command, for the `-q` short-flag reason noted in `args/parse.ts`).

**Phase 3 — sibling commands.** ✅ Done. `hfmpeg probe`, `hfmpeg lint`, `hfmpeg deps` (`chromium ensure|path|clear`,
`ffmpeg path`), `hfmpeg completion`.

**Phase 4 — packaging.** ✅ Done. `packaging/build.mjs` producing the lite archive; verifies the producer's
on-disk runtime assets (`hyperframe.manifest.json`, `*.iife.js`, worker files, fonts) survive
pruning; launcher shims; smoke render inside the archive on every Tier 1 target in CI.

**Phase 5 — standalone.** ✅ Done. Vendors ffmpeg/ffprobe + pinned `chrome-headless-shell`
(`packaging/fetch-node.mjs`/`fetch-ffmpeg.mjs`/`fetch-chromium.mjs`); launcher injects
the env overrides; `hfmpeg doctor` proves `source: bundled`; size budget check (expect ~250-400 MB
uncompressed, dominated by Chromium). Ships `THIRD-PARTY-LICENSES` (FFmpeg GPL text + Chromium BSD
text) and the FFmpeg corresponding-source URL — the only two obligations that survive
subprocess-only usage.

**Phase 6 — release automation.** ✅ Done. Tag-driven matrix workflow (`.github/workflows/release.yml`)
across the Tier 1 targets, real-runner smoke render per OS, checksums, release notes
(`packaging/release-notes.mjs`), upstream-version compatibility table, and the
unsigned-binary unblock instructions (Gatekeeper / SmartScreen) in the release body and README.

**Phase 7 — hardening.** ✅ Done, with two items authored but requiring a real FFmpeg/Chromium
toolchain to execute (never available on every dev machine, by design — see the note in each
file):

- Pure, browser-free unit coverage: `test/render-plan.test.ts` (every mutual-exclusion/range
  check and flag → `RenderConfig`/`EngineConfig` mapping in `buildRenderPlan`), `test/errors.test.ts`
  (the exit-code mapping in `handleRuntimeError`), `test/global-flags.test.ts` (the new global-flag
  plumbing), `test/unicode-paths.test.ts` (Windows-unicode-path project dirs/entry files/batch
  templates).
- Golden-output regression render: `test/integration/golden-render.test.ts`, compared by PSNR
  against a committed reference frame generated once via `npm run golden:update`
  (`packaging/generate-golden.mjs`) — self-skips until that fixture is committed.
- Cancel/cleanup + long-render temp-dir behaviour: `test/integration/cancel-cleanup.test.ts` spawns
  a real `hfmpeg render`, sends a real `SIGINT` mid-render, and asserts (a) the exit code is
  `EXIT_CODES.CANCELLED`, (b) `--tmp-dir` actually redirected render scratch space, and (c) no
  `ffmpeg`/`chrome-headless-shell` process referencing that scratch dir survives — opt-in via
  `HFMPEG_INTEGRATION_TESTS=1` (wired into CI's `smoke-render` job), POSIX-only (Windows delivers
  `child.kill("SIGINT")` as a hard terminate per Node's own docs, not a graceful signal).
- Low-memory/8 GB path: `EngineConfig.lowMemoryMode`'s RAM-based auto-detection is upstream's
  (`resolveConfig()`) responsibility, not `hfmpeg`'s; what's ours is the `--low-memory-mode`/
  `--no-low-memory-mode` flag plumbing, covered in `render-plan.test.ts`.

### Testing strategy

Note: this machine cannot run the test suite — tests are authored here and executed in CI /
elsewhere. Layers, as implemented:

1. **Unit tests** (`npm test`, `node:test` via `tsx`, no browser): the pure arg/validation/fps/
   resolution/batch layer (`test/fps.test.ts`, `test/batch.test.ts`, `test/variables.test.ts`,
   `test/composition.test.ts`), the exact `RenderConfig`/`EngineConfig` mapping a given argv
   produces (`test/render-plan.test.ts` — this is the "mocked-producer layer" the original plan
   called for, minus an actual mock: `buildRenderPlan` never touches the producer, so it's testable
   directly), exit-code mapping (`test/errors.test.ts`), the global-flag plumbing
   (`test/global-flags.test.ts`), and Windows-unicode-path handling (`test/unicode-paths.test.ts`).
   `npm run typecheck` (`tsconfig.test.json`) type-checks `test/` alongside `src/`, since `tsx`
   itself only transpiles and does not type-check.
2. **Integration tests** (`test/integration/*.test.ts`, same `npm test` glob, opt-in via
   `HFMPEG_INTEGRATION_TESTS=1` and individually self-skipping wherever their environment isn't
   capable — see Phase 7 above): the golden-output regression render and the cancel/cleanup +
   `--tmp-dir` end-to-end check.
3. **Packaged-archive smoke renders** (`packaging/build.mjs`'s own smoke test, run per Tier 1 OS in
   CI): `version`/`doctor`/`probe`/`lint`/`render` against `examples/smoke` (1s composition,
   240×160, `--quality draft`), invoked through the *packaged* launcher, not the source tree.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream API churn (`0.7.x`, pre-1.0, and the README already disagrees with source) | Pin an exact `@hyperframes/producer` version per `hfmpeg` release; publish a compatibility table; keep the adapter in one file (`runtime/producer.ts`) |
| Producer's on-disk asset lookups break under bundling | No single-file build in v1; CI smoke-renders the packaged archive, not just the source tree |
| FFmpeg GPL contamination of a permissive release | Resolved: subprocess-only usage keeps `hfmpeg` source permissive; bundled binary is mere aggregation, discharged with license text + corresponding-source URL |
| Unsigned archives blocked by Gatekeeper / SmartScreen | Documented unblock steps in README, release notes, and `hfmpeg doctor`; revisit signing post-v1 |
| macOS/Linux artifacts assembled from a Windows host lose exec bits or go untested | Tar writer stamps modes explicitly; every Tier 1 target is built **and** smoke-rendered on a real GitHub Actions runner |
| Archive size (Chromium ~150-300 MB) | Offer lite as the default recommendation; standalone for air-gapped/CI use |
| Native deps (`sharp`, `onnxruntime-node`) | Not needed — those live in the upstream CLI, not in `@hyperframes/producer`. Keep it that way; never depend on the `hyperframes` CLI package |
| Puppeteer's postinstall downloading its own Chrome into our archive | Build with `PUPPETEER_SKIP_DOWNLOAD=1` and control Chromium ourselves |
| Windows quirks (unicode paths, DLL-missing ffmpeg exit codes, long paths) | Upstream already has specific handling; surface its messages verbatim and test on Windows in CI |

---

## 7. Decisions (locked)

| # | Decision |
| --- | --- |
| D1 | **Runtime: TypeScript on Node 22+**, distributed as archives carrying a Node runtime. Cross-platform artifacts are assembled by repackaging, and validated on real GitHub Actions runners. Bun cross-compile is a post-v1 optimization only (it pays off for a single-file binary, which §2.3 rules out). |
| D2 | **No fork, no vendoring.** Depend on the published `@hyperframes/producer` at an **exact pinned version**; record it in `hfmpeg version --json` as `upstream`. |
| D3 | **FFmpeg is invoked as a subprocess**, never linked → `hfmpeg` source stays permissive. Bundling a GPL build is mere aggregation, discharged with license text + corresponding-source URL. |
| D4 | **Standalone bundles both** ffmpeg/ffprobe and the pinned `chrome-headless-shell`. Lite bundles neither and resolves from `PATH` / cache / env. |
| D5 | **Tier 1:** `win-x64`, `linux-x64`, `macos-arm64`, `macos-x64` (standalone + lite). **Tier 2:** `linux-arm64`, lite only — no Chrome-for-Testing headless shell exists for it. |
| D6 | **Command surface as drafted** in `00-COMMANDS.md`: flat subcommands with ffmpeg-ish `-i`/`-o` shorthand on `render`. |
| D7 | **Flag names mirror `hyperframes render` exactly** wherever an equivalent exists. No renames. |
| D8 | **No code signing / notarization for v1.** Instead, ship explicit unblock instructions in the README, the release body, and `hfmpeg doctor` (macOS `xattr -d com.apple.quarantine ./hfmpeg`; Windows SmartScreen "More info → Run anyway"). |
| D9 | `--docker` mode, `hfmpeg serve`, and the distributed render primitives are **deferred** (§8). |
| D10 | **`hfmpeg` versions independently** (its own semver), with `upstream` and `chromiumPinned` fields in `version --json` and a compatibility table in the release notes. |
| D11 | **Engine config is always built as `producerConfig: resolveConfig(flagOverrides)`** — never a hand-built `EngineConfig` literal. Keeps every engine env var live, gives flags precedence over env, and inherits the host-adaptive clamps. See §2.4. |
| D12 | **Naming:** repo stays `html-2-video-rendering`; the *product / binary / archive prefix* is `hfmpeg`; tags are plain `v<semver>` (`v1.0.0`), release titles `hfmpeg v1.0.0`. See §9 note. |

## 8. Deferred to post-v1

Nothing in the v1 design blocks any of these; they are sequencing, not architecture.

- **npm package** (`npx hfmpeg render …`). Cheap later: it is the lite archive's contents plus a
  `bin` entry in `package.json`. Only decision deferred is the package name.
- **Package managers**: Homebrew tap, Scoop bucket, winget manifest, `install.sh` / `install.ps1`.
  All consume the same GitHub Release assets + `SHA256SUMS` that v1 already produces.
- **Code signing / notarization** — needs an Apple Developer ID and a Windows certificate.
- **`--docker` deterministic render mode** — needs a published renderer image.
- **`hfmpeg serve`** HTTP render server (`startServer` is already exported by the producer).
- **Distributed rendering** (`plan` / `renderChunk` / `assemble`, also already exported).
- **Single-file executable** — only after the producer's on-disk asset lookups
  (`hyperframe.manifest.json`, worker files) are worked around.
- **`linux-arm64` standalone** — blocked on a Chromium source we are willing to redistribute.

## 9. Remaining open items (non-blocking, decide during Phase 1-2)

1. **Default output path.** Upstream defaults to `renders/<name>.mp4`; for an ffmpeg-like tool I'd
   make `-o` **required** so nothing is ever written by surprise. Current draft assumes required.
2. **Progress default on a TTY**: bar with ETA/fps vs plain lines; and in CI/non-TTY, silent vs one
   line per N%. Current draft: `--progress auto` → bar on TTY, plain elsewhere.
3. **Telemetry**: assumed permanently absent.
4. **Update check**: assumed absent; possibly an opt-in `hfmpeg version --check-latest` later.
5. ~~**Repo / tag scheme**~~ — **resolved as D12.** Recommendation, and the reasoning:
   - **Keep the repo name `html-2-video-rendering`.** It is descriptive and searchable ("html to
     video" is what people actually search for), whereas `hfmpeg` is meaningless to a newcomer.
     A rename buys us nothing and costs stale clone URLs (GitHub redirects, but only until
     someone else claims the old name).
   - **The binary, archive prefix, and product name are `hfmpeg`** — short is what matters at the
     prompt, not in the URL. Repo name and command name differing is completely normal
     (`BurntSushi/ripgrep` → `rg`).
   - **Tags are plain `v<semver>`** (`v1.0.0`), release titled `hfmpeg v1.0.0`, assets
     `hfmpeg-1.0.0-<os>-<arch>-<channel>.<ext>`. No `hfmpeg-v1` or date prefixes — one scheme, so
     `install.sh` and package-manager manifests can construct asset URLs from a version string
     alone.
   - **One thing to check before locking `hfmpeg` publicly:** whether the `hfmpeg` name is free on npm
     (and Homebrew) — relevant to the deferred §8 items. If taken, the fallback is a scoped npm
     name with the binary still installed as `hfmpeg`, which costs us nothing.
6. **Per-project config file** (`hfmpeg.config.json` for default flags). Not needed for v1; easy to add
   without breaking the flag surface.
