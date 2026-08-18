# Working on this repo

## Commands

```bash
npm run build            # tsc -> dist/
npm test                 # unit tests (node:test via tsx); 70 tests, ~65s
npm run typecheck        # tsc --noEmit over src/ + test/
npm run package:lite     # build + smoke-test one archive for the host platform
npm run package:editor
npm run package:standalone
node packaging/publish.mjs --dry-run   # build, checksum, preview release notes
```

`HFMPEG_INTEGRATION_TESTS=1 npm test` additionally runs the golden-render and
cancel/cleanup tests; both self-skip unless a real ffmpeg/Chromium toolchain
is present.

## Windows dev box quirks

- `npm`/`npx` fail from PowerShell here: `npm.ps1 cannot be loaded because
  running scripts is disabled on this system`. Call the CLI JS directly
  instead of changing the execution policy:
  `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" test`
- The `gh` CLI is **not** installed. Anything touching GitHub must use the
  REST API with a PAT in `GITHUB_TOKEN` (which is what
  `packaging/publish.mjs` does).
- `bash` is not on `PATH`; Git's shell lives at
  `C:\Users\Arshiya\AppData\Local\Programs\Git\bin\sh.exe`.
- No ffmpeg on `PATH`, so a lite/editor `packaging/build.mjs` run reports its
  smoke *render* as an environment limitation rather than failing. That is
  expected here; it is not expected for the standalone channel.

## Release process

GitHub Actions is unavailable for this repo (billing), so
`.github/workflows/release.yml` and `ci.yml` do not run. See the README's
"Publishing a release" section: win-x64 is published from this machine with
`packaging/publish.mjs`, macos-arm64 from Semaphore
(`.semaphore/semaphore.yml`). Both merge into the same GitHub Release.

Semaphore's macOS agents cost **$0.09/min against a $15/month credit (~166
min/month)** — never give that pipeline a build-on-every-push trigger. Keep
it manual- or tag-only, configured in the Semaphore dashboard.

## Gotchas worth remembering

- npm script globs must be **quoted** (`tsx --test "test/**/*.test.ts"`).
  Unquoted, `sh` pre-expands `test/**/*.test.ts` to `test/*/*.test.ts` on
  macOS/Linux, which silently matches only `test/integration/` and skips
  every unit test. Windows `cmd` doesn't glob, which is why this looked fine
  locally.
- `@hyperframes/engine`'s `resolveHeadlessShellPath()` checks
  `PRODUCER_HEADLESS_SHELL_PATH`, `HYPERFRAMES_BROWSER_PATH`, and two
  `~/.cache` dirs — and nothing else. It never falls back to a Chrome on
  `PATH`, so a lite build on a fresh CI agent needs one of those set (or
  `hfmpeg deps chromium ensure`) or its smoke render will fail.
- `packaging/fetch-ffmpeg.mjs` is trust-on-first-use: the first fetch for a
  (tag, platform) mints a sha256 pin in `packaging/checksums.json`. Mint pins
  locally and commit them; CI should always run with `--require-pinned` so it
  can never be the first thing to trust a changed upstream binary.
