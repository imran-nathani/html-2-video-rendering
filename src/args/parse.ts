import { usageError } from "../output/errors.js";

export interface RenderArgs {
  /** Positional `[dir]` argument. */
  positionalDir?: string;
  /** `--input, -i` — alternative to the positional: a dir or an `.html` file. */
  input?: string;
  /** `--composition, -c` — entry HTML relative to the project dir. */
  composition?: string;
  /** `--output, -o` — required. */
  output?: string;
  format?: string;
  fps?: string;
  quality?: string;
  /** `--workers, -w <n|auto>`. */
  workers?: string;
  quiet: boolean;
  json: boolean;
  /** `--overwrite, -y`. */
  overwrite: boolean;

  /** `--resolution <preset|alias>`. */
  resolution?: string;
  crf?: string;
  videoBitrate?: string;
  vp9CpuUsed?: string;
  gifLoop?: string;
  videoFrameFormat?: string;
  hdr: boolean;
  sdr: boolean;

  variables?: string;
  variablesFile?: string;
  strictVariables: boolean;
  batch?: string;
  batchConcurrency?: string;
  batchFailFast: boolean;

  gpu: boolean;
  /** Tri-state: `undefined` = auto, `true` = `--browser-gpu`, `false` = `--no-browser-gpu`. */
  browserGpu?: boolean;
  lowMemoryMode?: boolean;
  pageSideCompositing?: boolean;
  experimentalFastCapture?: boolean;
  framesCacheDir?: string;

  /** `--browser-timeout <seconds>`. */
  browserTimeout?: string;
  /** `--player-ready-timeout <ms>`. */
  playerReadyTimeout?: string;
  /** `--protocol-timeout <ms>`. */
  protocolTimeout?: string;

  /** Tri-state: `undefined`/`true` = best-effort (default), `false` = `--no-best-effort`. */
  bestEffort?: boolean;
  strict: boolean;
  strictAll: boolean;
  debug: boolean;
  /** `--progress <auto|bar|plain|json|none>`. */
  progress?: string;
  /** `--dry-run`: resolve everything and print the plan without rendering. */
  dryRun: boolean;

  /** `--ffmpeg-path <path>` — global flag, sets `HYPERFRAMES_FFMPEG_PATH` for the run. */
  ffmpegPath?: string;
  /** `--ffprobe-path <path>` — global flag, sets `HYPERFRAMES_FFPROBE_PATH` for the run. */
  ffprobePath?: string;
  /** `--chromium-path <path>` — global flag, sets `PRODUCER_HEADLESS_SHELL_PATH` for the run. */
  chromiumPath?: string;
}

type RenderArgsStringKey = Exclude<
  keyof RenderArgs,
  | "quiet"
  | "json"
  | "overwrite"
  | "hdr"
  | "sdr"
  | "strictVariables"
  | "batchFailFast"
  | "gpu"
  | "browserGpu"
  | "lowMemoryMode"
  | "pageSideCompositing"
  | "experimentalFastCapture"
  | "bestEffort"
  | "strict"
  | "strictAll"
  | "debug"
  | "dryRun"
>;

// `-q` is reserved for `--quality` here (00-COMMANDS.md's render section is
// more specific than the global `--quiet, -q`, which is a spec-level
// ambiguity between the two flag tables — `--quiet` therefore has no short
// alias in this implementation to avoid the collision).
const FLAGS_WITH_VALUE: Record<string, RenderArgsStringKey> = {
  "--input": "input",
  "-i": "input",
  "--composition": "composition",
  "-c": "composition",
  "--output": "output",
  "-o": "output",
  "--format": "format",
  "--fps": "fps",
  "-f": "fps",
  "--quality": "quality",
  "-q": "quality",
  "--workers": "workers",
  "-w": "workers",
  "--resolution": "resolution",
  "--crf": "crf",
  "--video-bitrate": "videoBitrate",
  "--vp9-cpu-used": "vp9CpuUsed",
  "--gif-loop": "gifLoop",
  "--video-frame-format": "videoFrameFormat",
  "--variables": "variables",
  "--variables-file": "variablesFile",
  "--batch": "batch",
  "--batch-concurrency": "batchConcurrency",
  "--frames-cache-dir": "framesCacheDir",
  "--browser-timeout": "browserTimeout",
  "--player-ready-timeout": "playerReadyTimeout",
  "--protocol-timeout": "protocolTimeout",
  "--progress": "progress",
  "--ffmpeg-path": "ffmpegPath",
  "--ffprobe-path": "ffprobePath",
  "--chromium-path": "chromiumPath",
};

type SimpleBooleanKey =
  | "quiet"
  | "json"
  | "overwrite"
  | "hdr"
  | "sdr"
  | "strictVariables"
  | "batchFailFast"
  | "gpu"
  | "strict"
  | "strictAll"
  | "debug"
  | "dryRun";

const SIMPLE_BOOLEAN_FLAGS: Record<string, SimpleBooleanKey> = {
  "--quiet": "quiet",
  "--json": "json",
  "--overwrite": "overwrite",
  "-y": "overwrite",
  "--hdr": "hdr",
  "--sdr": "sdr",
  "--strict-variables": "strictVariables",
  "--batch-fail-fast": "batchFailFast",
  "--gpu": "gpu",
  "--strict": "strict",
  "--strict-all": "strictAll",
  "--debug": "debug",
  "--dry-run": "dryRun",
};

type TristateKey =
  | "browserGpu"
  | "lowMemoryMode"
  | "pageSideCompositing"
  | "experimentalFastCapture"
  | "bestEffort";

const TRISTATE_FLAGS: Record<string, { key: TristateKey; value: boolean }> = {
  "--browser-gpu": { key: "browserGpu", value: true },
  "--no-browser-gpu": { key: "browserGpu", value: false },
  "--low-memory-mode": { key: "lowMemoryMode", value: true },
  "--no-low-memory-mode": { key: "lowMemoryMode", value: false },
  "--page-side-compositing": { key: "pageSideCompositing", value: true },
  "--no-page-side-compositing": { key: "pageSideCompositing", value: false },
  "--experimental-fast-capture": { key: "experimentalFastCapture", value: true },
  "--no-experimental-fast-capture": { key: "experimentalFastCapture", value: false },
  "--best-effort": { key: "bestEffort", value: true },
  "--no-best-effort": { key: "bestEffort", value: false },
};

export function parseRenderArgs(argv: string[]): RenderArgs {
  const args: RenderArgs = {
    quiet: false,
    json: false,
    overwrite: false,
    hdr: false,
    sdr: false,
    strictVariables: false,
    batchFailFast: false,
    gpu: false,
    strict: false,
    strictAll: false,
    debug: false,
    dryRun: false,
  };
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];

    const simpleBooleanKey = SIMPLE_BOOLEAN_FLAGS[token];
    if (simpleBooleanKey) {
      args[simpleBooleanKey] = true;
      i += 1;
      continue;
    }

    const tristate = TRISTATE_FLAGS[token];
    if (tristate) {
      args[tristate.key] = tristate.value;
      i += 1;
      continue;
    }

    const key = FLAGS_WITH_VALUE[token];
    if (key) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw usageError(`Flag "${token}" requires a value.`);
      }
      args[key] = value;
      i += 2;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageError(`Unknown flag "${token}".`, "Run `hfmpeg help render` for usage.");
    }

    if (args.positionalDir === undefined) {
      args.positionalDir = token;
      i += 1;
      continue;
    }

    throw usageError(`Unexpected argument "${token}".`);
  }

  return args;
}
