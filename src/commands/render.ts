import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { resolveResolutionFlagPair } from "@hyperframes/parsers";
import type { CanvasResolution } from "@hyperframes/parsers";
import type { EngineConfig } from "@hyperframes/engine";
import type { BatchRow } from "../batch.js";
import { readBatchRows, runBatch } from "../batch.js";
import type { RenderArgs } from "../args/parse.js";
import { parseFpsArg } from "../args/fps.js";
import { assertStrictVariables, resolveVariables, type VariablesObject } from "../args/variables.js";
import { CliError, EXIT_CODES, toCliError, usageError, type ExitCode } from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";
import {
  createProgressReporter,
  isValidProgressMode,
  resolveProgressMode,
  type ProgressMode,
} from "../output/progress.js";
import { extractCompositionRoot } from "../composition.js";
import { logDebug } from "../output/log.js";
import { readEntryHtml, resolveProjectInput } from "../project.js";
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
    const findings = result.findings
      .filter((f) => f.severity === "error" || (mode === "strict-all" && f.severity === "warning"))
      .map((f) => `[${f.severity}] ${f.code}: ${f.message}`)
      .join("\n");
    throw new CliError(
      `Lint gate failed (${result.errorCount} error(s), ${result.warningCount} warning(s)):\n${findings}`,
      EXIT_CODES.LINT_OR_STRICT_FAILED,
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
  const root = extractCompositionRoot(readEntryHtml(projectDir, entryFile));

  const durationSeconds = root?.durationSeconds;
  const totalFrames =
    durationSeconds !== undefined
      ? Math.round((durationSeconds * plan.fps.num) / plan.fps.den)
      : undefined;

  const { findFfBinary } = await import("@hyperframes/parsers/ff-binaries");
  const { resolveHeadlessShellPath } = await import("@hyperframes/engine");

  const data = {
    projectDir,
    entryFile: entryFile ?? "index.html",
    output: args.batch ? `${outputPath} (batch template)` : outputPath,
    format: plan.format,
    quality: plan.quality,
    fps: plan.fps,
    workers: plan.workers ?? "auto",
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

  const plan = buildRenderPlan(args, args.output);
  logDebug(`resolved project: dir=${projectDir} entry=${entryFile ?? "index.html"}`);
  logDebug(`resolved plan: ${JSON.stringify({ format: plan.format, quality: plan.quality, fps: plan.fps, workers: plan.workers, strictness: plan.strictness })}`);

  const baseVariables = resolveVariables(args.variables, args.variablesFile);

  if (args.strictVariables) {
    const html = readEntryHtml(projectDir, entryFile);
    assertStrictVariables(html, baseVariables);
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

  const abortController = new AbortController();
  const onSigint = () => abortController.abort();
  process.once("SIGINT", onSigint);

  try {
    await executeRenderJob(
      job,
      projectDir,
      outputPath,
      (progressJob: { progress?: number }, message: string) => {
        reporter.report(progressJob.progress ?? 0, message);
      },
      abortController.signal,
    );
  } finally {
    process.removeListener("SIGINT", onSigint);
    reporter.end();
  }

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
    warnings: job.warnings ?? [],
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

async function executeBatchRender(
  args: RenderArgs,
  plan: RenderPlan,
  producerConfig: EngineConfig,
  projectDir: string,
  entryFile: string | undefined,
  baseVariables: VariablesObject | undefined,
  progressMode: ProgressMode,
  producerFns: {
    createRenderJob: Awaited<ReturnType<typeof loadProducer>>["createRenderJob"];
    executeRenderJob: Awaited<ReturnType<typeof loadProducer>>["executeRenderJob"];
  },
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

    await executeRenderJob(job, projectDir, outputPath, undefined, undefined);

    return {
      output: outputPath,
      outcome: job.outcome ?? "completed",
      warnings: job.warnings ?? [],
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
      reporter.report(index / rows.length, `row ${index + 1}/${rows.length}: ${output}`);
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

export function handleRuntimeError(err: unknown, json: boolean): number {
  const name = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : undefined;
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  let exitCode: ExitCode = EXIT_CODES.RENDER_FAILED;
  if (err instanceof Error && "exitCode" in err) {
    exitCode = (err as CliError).exitCode;
  } else if (name === "RenderCancelledError") {
    exitCode = EXIT_CODES.CANCELLED;
  } else if (name === "RenderQualityError") {
    exitCode = EXIT_CODES.LINT_OR_STRICT_FAILED;
  } else if (code === "ENOENT" || (message && MISSING_BINARY_MESSAGE_RE.test(message))) {
    // Belt-and-suspenders alongside assertRenderDependencies (above): this
    // catches the one case the upfront check doesn't (it trusts an explicit
    // --ffmpeg-path/--chromium-path/env var without checking the file
    // exists, same as the resolvers themselves do) — an explicit-but-wrong
    // path, surfaced here instead of at fast-fail time.
    exitCode = EXIT_CODES.MISSING_DEPENDENCY;
  }

  const cliError = toCliError(err, exitCode);
  printCliError("render", cliError, json);
  return cliError.exitCode;
}
