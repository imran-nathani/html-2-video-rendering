import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { resolveResolutionFlagPair } from "@hyperframes/parsers";
import type { CanvasResolution } from "@hyperframes/parsers";
import type { EngineConfig } from "@hyperframes/engine";
import type { BatchRow } from "../batch.js";
import { readBatchRows, runBatch } from "../batch.js";
import type { RenderArgs } from "../args/parse.js";
import { parseFpsArg } from "../args/fps.js";
import {
  assertStrictVariables,
  checkUndeclaredVariables,
  resolveVariables,
  type VariablesObject,
} from "../args/variables.js";
import {
  CliError,
  EXIT_CODES,
  toCliError,
  usageError,
  type CliErrorDetails,
  type ExitCode,
  type StructuredWarning,
} from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";
import {
  createProgressReporter,
  isValidProgressMode,
  resolveProgressMode,
  type ProgressMode,
  type ProgressReporter,
} from "../output/progress.js";
import { parsePosterTime, planPosterCapture } from "../poster.js";
import { extractCompositionRoot, resolveFallbackDurationSeconds } from "../composition.js";
import { logDebug } from "../output/log.js";
import { readEntryHtml, resolveProjectInput } from "../project.js";
import { createProducerLogger, withConsoleLevelGate } from "../runtime/logger.js";
import { loadProducer } from "../runtime/producer.js";

type RenderOutputFormat = "mp4" | "webm" | "mov" | "gif" | "png-sequence";

const VALID_QUALITIES = new Set(["draft", "standard", "high"]);
const VALID_FORMATS = new Set<string>(["mp4", "webm", "mov", "gif", "png-sequence"] satisfies RenderOutputFormat[]);
const ALPHA_FORMATS = new Set(["webm", "mov", "png-sequence", "gif"]);
const VALID_VIDEO_FRAME_FORMATS = new Set(["auto", "jpg", "png"]);
const FORMAT_BY_EXTENSION: Record<string, string> = {
  ".mp4": "mp4",
  ".webm": "webm",
  ".mov": "mov",
  ".gif": "gif",
};

function inferFormat(outputPath: string): string {
  const ext = extname(outputPath).toLowerCase();
  return FORMAT_BY_EXTENSION[ext] ?? "mp4";
}

function parseIntFlag(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`Invalid ${name} "${raw}". Expected an integer ${min}..${max}.`);
  }
  return value;
}

/** Shared, format/quality-independent RenderConfig fields resolved once per `render` invocation. */
export interface RenderPlan {
  format: string;
  quality: "draft" | "standard" | "high";
  fps: { num: number; den: number };
  workers: number | "auto" | undefined;
  gifLoop?: number;
  useGpu: boolean;
  debug: boolean;
  strictness: "best-effort" | "strict";
  crf?: number;
  videoBitrate?: string;
  videoFrameFormat?: "auto" | "jpg" | "png";
  hdrMode?: "force-hdr" | "force-sdr";
  outputResolution?: string;
  outputResolutionAspectAgnostic?: boolean;
  engineOverrides: Partial<EngineConfig>;
}

export function buildRenderPlan(args: RenderArgs, output: string): RenderPlan {
  let format = args.format;
  if (format && !VALID_FORMATS.has(format)) {
    throw usageError(
      `Invalid --format "${format}". Expected one of: ${[...VALID_FORMATS].join(", ")}.`,
    );
  }
  if (!format) format = inferFormat(output);

  const quality = args.quality ?? "standard";
  if (!VALID_QUALITIES.has(quality)) {
    throw usageError(`Invalid --quality "${quality}". Expected one of: draft, standard, high.`);
  }

  let fps = { num: 30, den: 1 };
  if (args.fps) {
    try {
      fps = parseFpsArg(args.fps);
    } catch (err) {
      throw usageError(err instanceof Error ? err.message : String(err));
    }
  }

  let workers: number | "auto" | undefined;
  if (args.workers !== undefined) {
    if (args.workers === "auto") {
      workers = "auto";
    } else {
      workers = parseIntFlag("--workers", args.workers, 1, 24);
    }
  }

  if (args.crf !== undefined && args.videoBitrate !== undefined) {
    throw usageError("--crf and --video-bitrate are mutually exclusive.");
  }
  const crf =
    args.crf !== undefined ? parseIntFlag("--crf", args.crf, 0, 51) : undefined;
  const videoBitrate = args.videoBitrate;

  if (args.vp9CpuUsed !== undefined && format !== "webm") {
    throw usageError("--vp9-cpu-used only applies to --format webm.");
  }
  const vp9CpuUsed =
    args.vp9CpuUsed !== undefined
      ? parseIntFlag("--vp9-cpu-used", args.vp9CpuUsed, -8, 8)
      : undefined;

  if (args.gifLoop !== undefined && format !== "gif") {
    throw usageError("--gif-loop only applies to --format gif.");
  }
  const gifLoop =
    args.gifLoop !== undefined ? parseIntFlag("--gif-loop", args.gifLoop, 0, 65535) : undefined;

  let videoFrameFormat: "auto" | "jpg" | "png" | undefined;
  if (args.videoFrameFormat !== undefined) {
    if (!VALID_VIDEO_FRAME_FORMATS.has(args.videoFrameFormat)) {
      throw usageError(
        `Invalid --video-frame-format "${args.videoFrameFormat}". Expected auto, jpg, or png.`,
      );
    }
    videoFrameFormat = args.videoFrameFormat as "auto" | "jpg" | "png";
  }

  if (args.hdr && args.sdr) {
    throw usageError("--hdr and --sdr are mutually exclusive.");
  }
  if (args.hdr && format !== "mp4") {
    throw usageError("--hdr is MP4-only; it is incompatible with alpha formats (webm/mov/png-sequence/gif).");
  }
  const hdrMode = args.hdr ? "force-hdr" : args.sdr ? "force-sdr" : undefined;

  let outputResolution: string | undefined;
  let outputResolutionAspectAgnostic: boolean | undefined;
  if (args.resolution) {
    if (args.hdr) {
      throw usageError("--resolution cannot be combined with --hdr.");
    }
    if (ALPHA_FORMATS.has(format)) {
      throw usageError(
        `--resolution cannot be combined with --format ${format} (alpha output does not support supersampling).`,
      );
    }
    const pair = resolveResolutionFlagPair(args.resolution);
    if (!pair.outputResolution) {
      throw usageError(
        `Invalid --resolution "${args.resolution}". Expected landscape, portrait, landscape-4k, ` +
          "portrait-4k, square, square-4k, or an alias (1080p, 4k, uhd, 1080p-square, square-1080p, 4k-square).",
      );
    }
    outputResolution = pair.outputResolution;
    outputResolutionAspectAgnostic = pair.outputResolutionAspectAgnostic;
  }

  const engineOverrides: Partial<EngineConfig> = {};
  if (args.browserGpu !== undefined) {
    engineOverrides.browserGpuMode = args.browserGpu ? "hardware" : "software";
  }
  if (args.lowMemoryMode !== undefined) engineOverrides.lowMemoryMode = args.lowMemoryMode;
  if (args.pageSideCompositing !== undefined) {
    engineOverrides.enablePageSideCompositing = args.pageSideCompositing;
  }
  if (args.experimentalFastCapture !== undefined) {
    engineOverrides.useDrawElement = args.experimentalFastCapture;
  }
  if (vp9CpuUsed !== undefined) engineOverrides.vp9CpuUsed = vp9CpuUsed;

  if (args.browserTimeout !== undefined) {
    const seconds = Number(args.browserTimeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw usageError(`Invalid --browser-timeout "${args.browserTimeout}". Expected seconds > 0.`);
    }
    engineOverrides.pageNavigationTimeout = seconds * 1000;
  }
  if (args.playerReadyTimeout !== undefined) {
    engineOverrides.playerReadyTimeout = parseIntFlag(
      "--player-ready-timeout",
      args.playerReadyTimeout,
      1,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (args.protocolTimeout !== undefined) {
    engineOverrides.protocolTimeout = parseIntFlag(
      "--protocol-timeout",
      args.protocolTimeout,
      1,
      Number.MAX_SAFE_INTEGER,
    );
  }

  const strictness: "best-effort" | "strict" = args.bestEffort === false ? "strict" : "best-effort";

  return {
    format,
    quality: quality as "draft" | "standard" | "high",
    fps,
    workers,
    gifLoop,
    useGpu: args.gpu,
    debug: args.debug,
    strictness,
    crf,
    videoBitrate,
    videoFrameFormat,
    hdrMode,
    outputResolution,
    outputResolutionAspectAgnostic,
    engineOverrides,
  };
}

async function runLintGate(
  projectDir: string,
  entryFile: string | undefined,
  mode: "strict" | "strict-all",
): Promise<void> {
  const { prepareHyperframeLintBody, runHyperframeLint } = await loadProducer();
  const prepared = prepareHyperframeLintBody({ projectDir, entryFile });
  if ("error" in prepared) {
    throw new CliError(`Lint gate: ${prepared.error}`, EXIT_CODES.COMPOSITION_INVALID);
  }
  const result = await runHyperframeLint(prepared.prepared);
  if (result.errorCount > 0 || (mode === "strict-all" && result.warningCount > 0)) {
    const blocking = result.findings.filter(
      (f) => f.severity === "error" || (mode === "strict-all" && f.severity === "warning"),
    );
    throw new CliError(
      `Lint gate failed (${result.errorCount} error(s), ${result.warningCount} warning(s)):\n` +
        blocking.map((f) => `[${f.severity}] ${f.code}: ${f.message}`).join("\n"),
      EXIT_CODES.LINT_OR_STRICT_FAILED,
      undefined,
      // `reason` separates this from the *other* exit-4 failure (a capture
      // blocked by correctness warnings under --no-best-effort), which a
      // caller wants to report to the user completely differently.
      {
        reason: "lint_gate",
        findings: blocking.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
      },
    );
  }
}

export function checkOutputWritable(outputPath: string, format: string, overwrite: boolean): void {
  if (format === "png-sequence") return;
  if (existsSync(outputPath) && !overwrite) {
    throw new CliError(
      `Output already exists: ${outputPath}`,
      EXIT_CODES.OUTPUT_IO,
      "Pass --overwrite/-y to replace it.",
    );
  }
}

/**
 * `--dry-run` (00-COMMANDS.md "Gates & diagnostics"): resolve everything —
 * paths, binaries, config, duration, frame count — and print the plan
 * without spawning Chrome or FFmpeg.
 */
async function reportDryRun(
  args: RenderArgs,
  plan: RenderPlan,
  producerConfig: EngineConfig,
  projectDir: string,
  entryFile: string | undefined,
): Promise<number> {
  const outputPath = args.batch ? args.output! : resolve(args.output!);
  const dryRunHtml = readEntryHtml(projectDir, entryFile);
  const root = extractCompositionRoot(dryRunHtml);

  const durationSeconds = root?.durationSeconds ?? resolveFallbackDurationSeconds(dryRunHtml);
  const totalFrames =
    durationSeconds !== undefined
      ? Math.round((durationSeconds * plan.fps.num) / plan.fps.den)
      : undefined;

  const { findFfBinary } = await import("@hyperframes/parsers/ff-binaries");
  const { resolveHeadlessShellPath } = await import("@hyperframes/engine");

  // A poster overrides both the fps and the frame budget (see `poster.ts`),
  // so reporting the video plan's numbers here would misstate the work by
  // an order of magnitude — the one question --dry-run exists to answer.
  const poster =
    args.poster !== undefined && durationSeconds !== undefined && durationSeconds > 0
      ? planPosterCapture(durationSeconds, parsePosterTime(args.poster, durationSeconds), plan.fps)
      : undefined;

  const data = {
    projectDir,
    entryFile: entryFile ?? "index.html",
    output: args.batch ? `${outputPath} (batch template)` : outputPath,
    format: poster ? "png (poster)" : plan.format,
    quality: plan.quality,
    fps: poster?.fps ?? plan.fps,
    workers: plan.workers ?? "auto",
    poster: poster
      ? {
          timeSeconds: poster.timeSeconds,
          frameIndex: poster.frameIndex,
          capturedFrames: poster.totalFrames,
        }
      : undefined,
    composition: {
      id: root?.compositionId,
      width: root?.width,
      height: root?.height,
      durationSeconds,
      totalFrames,
    },
    dependencies: {
      ffmpeg: findFfBinary("ffmpeg"),
      ffprobe: findFfBinary("ffprobe"),
      chromium: producerConfig.chromePath ?? resolveHeadlessShellPath(),
    },
  };

  if (args.json) {
    printJsonEnvelope({ ok: true, command: "render", data: { dryRun: true, ...data } });
  } else {
    console.log(`project        ${data.projectDir}`);
    console.log(`entry          ${data.entryFile}`);
    console.log(`output         ${data.output}`);
    console.log(`format/quality ${data.format} / ${data.quality}`);
    console.log(`fps            ${data.fps.num}/${data.fps.den}`);
    console.log(`workers        ${data.workers}`);
    if (data.poster) {
      console.log(
        `poster         t=${data.poster.timeSeconds}s  frame ${data.poster.frameIndex} of ${data.poster.capturedFrames} captured`,
      );
    }
    console.log(
      `composition    ${data.composition.id ?? "(none found)"}  ${data.composition.width ?? "?"}x${data.composition.height ?? "?"}  duration=${data.composition.durationSeconds ?? "?"}s  frames=${data.composition.totalFrames ?? "?"}`,
    );
    console.log(`ffmpeg         ${data.dependencies.ffmpeg ?? "not found"}`);
    console.log(`ffprobe        ${data.dependencies.ffprobe ?? "not found"}`);
    console.log(`chromium       ${data.dependencies.chromium ?? "(puppeteer-bundled)"}`);
  }

  return EXIT_CODES.OK;
}

/**
 * Pre-flight dependency check, run once per `render` invocation (single or
 * batch) right before the real work starts. `--dry-run` already resolves +
 * reports these (`reportDryRun`, above) but never *fails* on a missing one —
 * a real render previously had no equivalent guard at all: it would launch
 * headless Chrome and capture every frame (the bulk of a render's
 * wall-clock time) only to fail once the producer's encode stage tried to
 * spawn a missing `ffmpeg`. Failing fast here, before any of that work
 * starts, is cheap (a `PATH`/cache scan) and gives a `MISSING_DEPENDENCY`
 * (exit 3) error immediately instead of `RENDER_FAILED` (exit 1) after a
 * long wait — matching what `00-COMMANDS.md`'s exit-code table promises.
 *
 * This only catches "not resolvable anywhere" (no flag, no env var, no
 * `PATH`, no project-local `.hyperframes/bin/`, no cache). An *explicit*
 * but wrong path (`--ffmpeg-path`/`HYPERFRAMES_FFMPEG_PATH` pointing at a
 * file that doesn't exist) is trusted the same way `ffBinaries` already
 * trusts it, and surfaces at actual spawn time instead — `handleRuntimeError`
 * (below) maps that raw `ENOENT` to the same exit code.
 */
async function assertRenderDependencies(): Promise<void> {
  const { findFfBinary } = await import("@hyperframes/parsers/ff-binaries");

  if (!findFfBinary("ffmpeg")) {
    throw new CliError(
      "ffmpeg not found.",
      EXIT_CODES.MISSING_DEPENDENCY,
      "Install ffmpeg, pass --ffmpeg-path, set HYPERFRAMES_FFMPEG_PATH, or run `hfmpeg doctor` for details.",
    );
  }
  if (!findFfBinary("ffprobe")) {
    throw new CliError(
      "ffprobe not found.",
      EXIT_CODES.MISSING_DEPENDENCY,
      "Install ffprobe, pass --ffprobe-path, set HYPERFRAMES_FFPROBE_PATH, or run `hfmpeg doctor` for details.",
    );
  }

  try {
    // Undefined is fine here (falls back to Puppeteer's own bundled Chrome,
    // 00-PLAN.md §2.2 item 6) — this only throws when an *explicit* chromium
    // path (flag/env) was given but doesn't exist on disk.
    const { resolveHeadlessShellPath } = await import("@hyperframes/engine");
    resolveHeadlessShellPath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Chromium/chrome-headless-shell not found: ${message}`,
      EXIT_CODES.MISSING_DEPENDENCY,
      "Run `hfmpeg deps chromium ensure`, pass --chromium-path, or run `hfmpeg doctor` for details.",
    );
  }
}

type ExecuteRenderJob = Awaited<ReturnType<typeof loadProducer>>["executeRenderJob"];
type CreateRenderJob = Awaited<ReturnType<typeof loadProducer>>["createRenderJob"];

/**
 * Run one job to completion with `SIGINT` wired to its abort signal and
 * progress forwarded to `reporter`. Shared by the video and `--poster`
 * paths so cancellation behaves identically in both.
 */
async function runRenderJob(
  executeRenderJob: ExecuteRenderJob,
  job: Parameters<ExecuteRenderJob>[0],
  projectDir: string,
  outputPath: string,
  reporter: ProgressReporter,
): Promise<void> {
  const abortController = new AbortController();
  const onSigint = () => abortController.abort();
  process.once("SIGINT", onSigint);

  try {
    // The gate covers the engine's bare `console.log` tracing, which no
    // logger injection can reach (see `withConsoleLevelGate`).
    await withConsoleLevelGate(async () => {
      await executeRenderJob(
        job,
        projectDir,
        outputPath,
        // The `RenderJob` handed to the progress callback already carries the
        // frame counters the producer interpolates into `message`; forward them
        // as fields so `--progress json` consumers never parse the prose.
        (
          progressJob: { progress?: number; totalFrames?: number; framesRendered?: number },
          message: string,
        ) => {
          reporter.report(progressJob.progress ?? 0, message, {
            totalFrames: progressJob.totalFrames,
            framesCompleted: progressJob.framesRendered,
          });
        },
        abortController.signal,
      );
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    reporter.end();
  }
}

export async function runRenderCommand(argv: string[], args: RenderArgs): Promise<number> {
  try {
    return await executeRender(args);
  } catch (err) {
    return handleRuntimeError(err, args.json);
  }
}

/**
 * Global flags (`00-COMMANDS.md` "Global flags") that are pure env-var
 * pass-throughs: re-read at the actual spawn/resolve call sites (§2.2/§2.4),
 * so setting them for the process is all `render` needs to do.
 */
export function applyPathOverrideEnv(args: RenderArgs): void {
  if (args.ffmpegPath !== undefined) process.env.HYPERFRAMES_FFMPEG_PATH = args.ffmpegPath;
  if (args.ffprobePath !== undefined) process.env.HYPERFRAMES_FFPROBE_PATH = args.ffprobePath;
  if (args.chromiumPath !== undefined) process.env.PRODUCER_HEADLESS_SHELL_PATH = args.chromiumPath;
}

async function executeRender(args: RenderArgs): Promise<number> {
  if (!args.output) {
    throw usageError(
      'Missing required "--output, -o <path>".',
      "Example: hfmpeg render ./my-video -o out.mp4",
    );
  }

  applyPathOverrideEnv(args);

  const { projectDir, entryFile } = resolveProjectInput(args);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw usageError(
      `Project directory not found: ${projectDir}`,
      "Pass a directory (or an .html file via --input/-i).",
    );
  }

  let progressModeRaw: ProgressMode = args.json ? "none" : "auto";
  if (args.progress !== undefined) {
    if (!isValidProgressMode(args.progress)) {
      throw usageError(
        `Invalid --progress "${args.progress}". Expected auto, bar, plain, json, or none.`,
      );
    }
    progressModeRaw = args.progress;
  }
  const progressMode = args.quiet ? "none" : resolveProgressMode(progressModeRaw);

  // `--poster` produces a PNG still, so the video-shaped flags either don't
  // apply or would silently be ignored. Reject them instead: the format is
  // forced to a frame capture below, and a caller who passed `--format mov`
  // expecting an alpha *video* should hear about it.
  if (args.poster !== undefined) {
    if (args.batch) throw usageError("--poster cannot be combined with --batch.");
    if (args.format) {
      throw usageError(
        `--poster always writes a PNG; it cannot be combined with --format ${args.format}.`,
      );
    }
    if (args.resolution) {
      throw usageError(
        "--poster cannot be combined with --resolution (the alpha/frame capture path does not apply supersampling).",
      );
    }
    if (args.hdr || args.sdr) throw usageError("--poster cannot be combined with --hdr/--sdr.");
  }

  const plan = buildRenderPlan(
    args.poster !== undefined ? { ...args, format: "png-sequence" } : args,
    args.output,
  );
  logDebug(`resolved project: dir=${projectDir} entry=${entryFile ?? "index.html"}`);
  logDebug(`resolved plan: ${JSON.stringify({ format: plan.format, quality: plan.quality, fps: plan.fps, workers: plan.workers, strictness: plan.strictness })}`);

  const baseVariables = resolveVariables(args.variables, args.variablesFile);

  // Both variable gates need the entry HTML's declarations, so read it once
  // when either has something to check. Batch rows are deliberately *not*
  // checked for undeclared keys: a row key can legitimately exist only to
  // feed the `{key}` output template (`batch.ts`), so "not declared by the
  // composition" isn't an error there the way it is for --variables.
  if (args.strictVariables || baseVariables) {
    const html = readEntryHtml(projectDir, entryFile);
    if (args.strictVariables) assertStrictVariables(html, baseVariables);
    checkUndeclaredVariables(html, baseVariables, args.strictVariables);
  }

  if (args.strict || args.strictAll) {
    await runLintGate(projectDir, entryFile, args.strictAll ? "strict-all" : "strict");
  }

  const { createRenderJob, executeRenderJob, resolveConfig } = await loadProducer();

  // 00-COMMANDS.md: `--frames-cache-dir` accepts off/none/false/0 to disable
  // the cache — that aliasing lives in resolveConfig()'s own env-var read, so
  // route the flag through the env var rather than the overrides object to
  // get it for free instead of re-implementing it.
  if (args.framesCacheDir !== undefined) {
    process.env.HYPERFRAMES_EXTRACT_CACHE_DIR = args.framesCacheDir;
  }

  // D11 (00-PLAN.md §2.4): always build engine config via resolveConfig(), never
  // a hand-built EngineConfig literal, so every PRODUCER_*/HYPERFRAMES_* env var
  // stays live and only flags we actually own override it.
  const producerConfig = resolveConfig(plan.engineOverrides);
  logDebug(
    `resolved engine config: chromePath=${producerConfig.chromePath ?? "(puppeteer-bundled)"} ` +
      `lowMemoryMode=${producerConfig.lowMemoryMode} browserGpuMode=${producerConfig.browserGpuMode}`,
  );

  if (args.dryRun) {
    return await reportDryRun(args, plan, producerConfig, projectDir, entryFile);
  }

  // Fail fast on a missing ffmpeg/ffprobe/chromium *before* spending time
  // capturing frames — see assertRenderDependencies' own comment for why
  // this didn't exist before and what it does/doesn't catch.
  await assertRenderDependencies();

  if (args.poster !== undefined) {
    return await executePosterRender(args, plan, producerConfig, projectDir, entryFile, baseVariables, progressMode, { createRenderJob, executeRenderJob });
  }

  if (args.batch) {
    return await executeBatchRender(args, plan, producerConfig, projectDir, entryFile, baseVariables, progressMode, { createRenderJob, executeRenderJob });
  }

  const outputPath = resolve(args.output);
  checkOutputWritable(outputPath, plan.format, args.overwrite);

  const reporter = createProgressReporter(progressMode, "render");
  const job = createRenderJob({
    fps: plan.fps,
    quality: plan.quality,
    format: plan.format as never,
    workers: plan.workers === "auto" ? undefined : plan.workers,
    entryFile,
    producerConfig,
    logger: createProducerLogger(),
    gifLoop: plan.gifLoop,
    useGpu: plan.useGpu,
    debug: plan.debug,
    strictness: plan.strictness,
    crf: plan.crf,
    videoBitrate: plan.videoBitrate,
    videoFrameFormat: plan.videoFrameFormat,
    hdrMode: plan.hdrMode,
    variables: baseVariables,
    outputResolution: plan.outputResolution as never,
    outputResolutionAspectAgnostic: plan.outputResolutionAspectAgnostic,
  });

  await runRenderJob(executeRenderJob, job, projectDir, outputPath, reporter);

  const renderTimeMs =
    job.startedAt && job.completedAt
      ? job.completedAt.getTime() - job.startedAt.getTime()
      : undefined;
  logDebug(`render finished: outcome=${job.outcome ?? "completed"} renderTimeMs=${renderTimeMs ?? "?"}`);

  const data = {
    output: outputPath,
    format: plan.format,
    fps: plan.fps,
    outcome: job.outcome ?? "completed",
    warnings: normalizeWarnings(job.warnings),
    totalFrames: job.totalFrames,
    framesRendered: job.framesRendered,
    durationSeconds: job.duration,
    renderTimeMs,
  };

  if (args.json) {
    printJsonEnvelope({ ok: true, command: "render", data });
  } else if (!args.quiet) {
    console.log(`Rendered ${outputPath} (${data.outcome})`);
  }

  return EXIT_CODES.OK;
}

/**
 * `--poster <time|auto>`: one still PNG instead of a video.
 *
 * Runs the *real* pipeline (compile, variables, fonts, sub-compositions) at
 * a frame rate chosen by `planPosterCapture` so one captured frame lands
 * exactly on the requested time, writes the sequence to a scratch directory,
 * and keeps the single frame. See `poster.ts` for why it can't simply ask
 * the producer for one frame.
 */
async function executePosterRender(
  args: RenderArgs,
  plan: RenderPlan,
  producerConfig: EngineConfig,
  projectDir: string,
  entryFile: string | undefined,
  variables: VariablesObject | undefined,
  progressMode: ProgressMode,
  producerFns: { createRenderJob: CreateRenderJob; executeRenderJob: ExecuteRenderJob },
): Promise<number> {
  const posterHtml = readEntryHtml(projectDir, entryFile);
  const root = extractCompositionRoot(posterHtml);
  // Same fallback `probe`/`--dry-run` use: the [data-composition-id] element
  // (often <html>) doesn't always carry data-duration itself — a plain
  // render tolerates that by launching a browser to read it live off
  // window.__hf.duration; --poster needs the number up front, so it takes
  // the largest declared data-start + data-duration in the file instead.
  const durationSeconds = root?.durationSeconds ?? resolveFallbackDurationSeconds(posterHtml);
  if (durationSeconds === undefined || !(durationSeconds > 0)) {
    throw new CliError(
      "--poster needs the composition's duration, which could not be read from the entry file.",
      EXIT_CODES.COMPOSITION_INVALID,
      "Ensure the composition root (or its timeline's own root element) carries data-duration "
        + "(see `hfmpeg probe`).",
    );
  }

  const posterPlan = planPosterCapture(durationSeconds, parsePosterTime(args.poster!, durationSeconds), plan.fps);
  logDebug(
    `poster plan: t=${posterPlan.timeSeconds}s frame=${posterPlan.frameIndex} ` +
      `fps=${posterPlan.fps.num}/${posterPlan.fps.den} capturedFrames=${posterPlan.totalFrames}`,
  );

  const outputPath = resolve(args.output!);
  checkOutputWritable(outputPath, "png", args.overwrite);

  const framesDir = mkdtempSync(join(tmpdir(), "hfmpeg-poster-"));
  const reporter = createProgressReporter(progressMode, "render");
  const job = producerFns.createRenderJob({
    fps: posterPlan.fps,
    quality: plan.quality,
    format: "png-sequence",
    workers: plan.workers === "auto" ? undefined : plan.workers,
    entryFile,
    producerConfig,
    logger: createProducerLogger(),
    useGpu: plan.useGpu,
    debug: plan.debug,
    strictness: plan.strictness,
    variables,
  });

  try {
    await runRenderJob(producerFns.executeRenderJob, job, projectDir, framesDir, reporter);

    const frames = readdirSync(framesDir)
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort();
    const frame = frames[posterPlan.frameIndex];
    if (!frame) {
      // Never silently substitute a neighbouring frame: a poster of the
      // wrong moment is indistinguishable from a correct one downstream.
      throw new CliError(
        `Poster frame ${posterPlan.frameIndex} (t=${posterPlan.timeSeconds}s) was not captured; ` +
          `the render produced ${frames.length} frame(s).`,
        EXIT_CODES.RENDER_FAILED,
        "Please report this with the composition's duration and the --poster value used.",
      );
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(join(framesDir, frame), outputPath);

    const data = {
      output: outputPath,
      format: "png",
      poster: {
        timeSeconds: posterPlan.timeSeconds,
        frameIndex: posterPlan.frameIndex,
        capturedFrames: frames.length,
        fps: posterPlan.fps,
      },
      outcome: job.outcome ?? "completed",
      warnings: normalizeWarnings(job.warnings),
      renderTimeMs:
        job.startedAt && job.completedAt
          ? job.completedAt.getTime() - job.startedAt.getTime()
          : undefined,
    };

    if (args.json) {
      printJsonEnvelope({ ok: true, command: "render", data });
    } else if (!args.quiet) {
      console.log(`Wrote poster ${outputPath} at t=${posterPlan.timeSeconds}s (${data.outcome})`);
    }

    return EXIT_CODES.OK;
  } finally {
    rmSync(framesDir, { recursive: true, force: true });
  }
}

async function executeBatchRender(
  args: RenderArgs,
  plan: RenderPlan,
  producerConfig: EngineConfig,
  projectDir: string,
  entryFile: string | undefined,
  baseVariables: VariablesObject | undefined,
  progressMode: ProgressMode,
  producerFns: { createRenderJob: CreateRenderJob; executeRenderJob: ExecuteRenderJob },
): Promise<number> {
  if (!args.output) throw usageError('Missing required "--output, -o <template>" for --batch.');
  const rows = readBatchRows(args.batch as string);

  const concurrency =
    args.batchConcurrency !== undefined
      ? parseIntFlag("--batch-concurrency", args.batchConcurrency, 1, rows.length || 1)
      : 1;

  const renderOne = async (row: BatchRow, outputRelative: string): Promise<unknown> => {
    const outputPath = resolve(outputRelative);
    checkOutputWritable(outputPath, plan.format, args.overwrite);

    const rowVariables = baseVariables ? { ...baseVariables, ...row } : row;
    const { createRenderJob, executeRenderJob } = producerFns;

    const job = createRenderJob({
      fps: plan.fps,
      quality: plan.quality,
      format: plan.format as never,
      workers: plan.workers === "auto" ? undefined : plan.workers,
      entryFile,
      producerConfig,
      logger: createProducerLogger(),
      gifLoop: plan.gifLoop,
      useGpu: plan.useGpu,
      debug: plan.debug,
      strictness: plan.strictness,
      crf: plan.crf,
      videoBitrate: plan.videoBitrate,
      videoFrameFormat: plan.videoFrameFormat,
      hdrMode: plan.hdrMode,
      variables: rowVariables,
      outputResolution: plan.outputResolution as never,
      outputResolutionAspectAgnostic: plan.outputResolutionAspectAgnostic,
    });

    await withConsoleLevelGate(async () => {
      await executeRenderJob(job, projectDir, outputPath, undefined, undefined);
    });

    return {
      output: outputPath,
      outcome: job.outcome ?? "completed",
      warnings: normalizeWarnings(job.warnings),
      totalFrames: job.totalFrames,
      framesRendered: job.framesRendered,
    };
  };

  const reporter = createProgressReporter(progressMode, "render");
  const results = await runBatch(
    rows,
    args.output,
    { concurrency, failFast: args.batchFailFast },
    async (row, output, index) => {
      reporter.report((index / rows.length) * 100, `row ${index + 1}/${rows.length}: ${output}`);
      return renderOne(row, output);
    },
  );
  reporter.end();

  const failures = results.filter((r) => !r.ok);
  const ok = failures.length === 0;

  const data = {
    rows: results.map((r) => ({
      index: r.index,
      output: r.output,
      ok: r.ok,
      error: r.error,
      data: r.data,
    })),
    succeeded: results.length - failures.length,
    failed: failures.length,
  };

  if (args.json) {
    printJsonEnvelope({ ok, command: "render", data });
  } else if (!args.quiet) {
    for (const r of results) {
      console.log(`${r.ok ? "[ok]  " : "[fail]"} ${r.output}${r.error ? ` — ${r.error}` : ""}`);
    }
  }

  return ok ? EXIT_CODES.OK : EXIT_CODES.RENDER_FAILED;
}

/**
 * Matches the producer's own "binary not found" wording (confirmed by
 * actually triggering it: `--ffmpeg-path` pointing at a missing file fails
 * *before* capture with `"[FFmpeg] FFmpeg binary not found at
 * HYPERFRAMES_FFMPEG_PATH=\"...\". Install FFmpeg or unset the override."`
 * — a deliberate, user-facing message, not an internal trace line, and not
 * a raw `ENOENT` the way a naive spawn failure would be (the producer
 * pre-validates explicit ffmpeg/ffprobe paths itself and throws this
 * instead). Still checked alongside a raw `.code === "ENOENT"` as a
 * fallback for whatever *doesn't* get that same pre-validation.
 */
const MISSING_BINARY_MESSAGE_RE = /\bbinary not found\b/i;

/**
 * hfmpeg-authored remediation for warning codes whose bare producer message
 * doesn't name the fix. `sub_timeline_readiness_timeout` in particular is a
 * ~45s wait (`playerReadyTimeout`, configurable via `--player-ready-timeout`)
 * before failing on a composition that never intended to register a GSAP
 * timeline in the first place — `data-no-timeline` is the documented escape
 * hatch, but the producer's own message doesn't mention it.
 */
const WARNING_FIX_HINTS: Record<string, string> = {
  sub_timeline_readiness_timeout:
    "If this composition never registers a timeline on window.__timelines, add data-no-timeline to its root element to skip this wait. Otherwise, --player-ready-timeout <ms> raises the budget it's failing against.",
  sub_timeline_script_failure:
    "A script this composition depends on (e.g. a CDN-hosted timeline library) failed to load. Check the URL is reachable, or vendor it locally — `hfmpeg lint --hermetic` finds every remote reference in the composition.",
};

/**
 * Normalize a producer `RenderWarning[]` (untyped on the wire — either off a
 * caught `RenderQualityError` or off a completed `RenderJob.warnings`) into
 * `StructuredWarning[]`, attaching an hfmpeg `fixHint` for codes we recognise.
 *
 * Defensive about the input shape (unknown-typed, per-entry `code` check)
 * because it's never something we construct ourselves.
 */
function normalizeWarnings(raw: unknown): StructuredWarning[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): StructuredWarning[] => {
    if (!entry || typeof entry !== "object") return [];
    const { code, message, stage, details } = entry as Record<string, unknown>;
    if (typeof code !== "string") return [];
    return [
      {
        code,
        message: typeof message === "string" ? message : undefined,
        stage: typeof stage === "string" ? stage : undefined,
        details: details && typeof details === "object" ? (details as Record<string, unknown>) : undefined,
        fixHint: WARNING_FIX_HINTS[code],
      },
    ];
  });
}

/**
 * Pull the producer's `RenderWarning[]` off a `RenderQualityError` so the
 * codes that blocked the render survive into the `--json` error envelope.
 *
 * Upstream builds that error with `new RenderQualityError(job.warnings)` and
 * keeps the array on `.warnings`, but the only *machine-readable* copy it
 * publishes is a `[WARN] … {"warningCodes":[…]}` line on stderr — the error's
 * `message` interpolates the codes into prose. Without this, attributing a
 * strict-mode failure to a code means regexing that message or scraping logs.
 */
function extractRenderWarnings(err: unknown): StructuredWarning[] | undefined {
  if (!err || typeof err !== "object" || !("warnings" in err)) return undefined;
  const warnings = normalizeWarnings((err as { warnings?: unknown }).warnings);
  return warnings.length > 0 ? warnings : undefined;
}

export function handleRuntimeError(err: unknown, json: boolean): number {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : undefined;
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  let exitCode: ExitCode = EXIT_CODES.RENDER_FAILED;
  let details: CliErrorDetails | undefined;
  let hint: string | undefined;
  if (err instanceof Error && "exitCode" in err) {
    exitCode = (err as CliError).exitCode;
  } else if (name === "RenderCancelledError") {
    exitCode = EXIT_CODES.CANCELLED;
  } else if (name === "RenderQualityError") {
    exitCode = EXIT_CODES.LINT_OR_STRICT_FAILED;
    const warnings = extractRenderWarnings(err);
    details = { reason: "correctness_warnings", warnings };
    // Surface the first known fix as the top-level error hint too, so it
    // shows up in plain-text output (`Error: … \n <hint>`), not only buried
    // in a per-warning `fixHint` a `--json` consumer has to go looking for.
    hint = warnings?.find((w) => w.fixHint !== undefined)?.fixHint;
  } else if (code === "ENOENT" || (message && MISSING_BINARY_MESSAGE_RE.test(message))) {
    // Belt-and-suspenders alongside assertRenderDependencies (above): this
    // catches the one case the upfront check doesn't (it trusts an explicit
    // --ffmpeg-path/--chromium-path/env var without checking the file
    // exists, same as the resolvers themselves do) — an explicit-but-wrong
    // path, surfaced here instead of at fast-fail time.
    exitCode = EXIT_CODES.MISSING_DEPENDENCY;
  }

  const cliError = toCliError(err, exitCode, details, hint);
  printCliError("render", cliError, json);
  return cliError.exitCode;
}
