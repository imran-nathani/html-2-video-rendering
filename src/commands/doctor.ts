import os from "node:os";
import { getArchiveRoot, getChannel, getHfmpegVersion, getProducerVersion } from "../meta.js";
import { EXIT_CODES } from "../output/errors.js";
import { printJsonEnvelope } from "../output/json.js";

export interface DoctorRow {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Where a resolved dependency actually came from (§3 "Release channel
   * detection": "which ffmpeg did it actually use" is the single most
   * common support question for a tool like this). `undefined` when not
   * applicable (e.g. the row isn't a resolved binary at all).
   */
  source?: "bundled" | "env" | "system";
}

/**
 * `bundled` when the resolved path lives inside this install's own `bin/`
 * (only true for a standalone archive — 00-PLAN.md §4 "Release channel
 * detection"); `env` when one of the relevant override env vars is set;
 * `system` otherwise (PATH scan, well-known dirs, or a cache directory).
 */
function classifySource(resolvedPath: string | undefined, envVarNames: string[]): DoctorRow["source"] {
  if (!resolvedPath) return undefined;
  // Check "bundled" before "env": the standalone launcher itself injects
  // these env vars to point at the bundled copies (only when the user
  // hasn't already set them — see packaging/launcher/hfmpeg-standalone), so
  // an env var being set does not, on its own, mean the *user* asked for
  // something other than what's bundled.
  const bundledBinDir = `${getArchiveRoot()}${process.platform === "win32" ? "\\" : "/"}bin`;
  if (resolvedPath.startsWith(bundledBinDir)) return "bundled";
  if (envVarNames.some((name) => Boolean(process.env[name]))) return "env";
  return "system";
}

/**
 * The ffmpeg/ffprobe/chromium rows, shared between `doctor` (full
 * environment report) and `deps status` (dependency-only — 00-COMMANDS.md
 * "`deps status` same rows doctor prints, dependency-only").
 */
export async function getDependencyRows(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];

  try {
    const { findFfBinary } = await import("@hyperframes/parsers/ff-binaries");
    const ffmpegPath = findFfBinary("ffmpeg");
    const ffprobePath = findFfBinary("ffprobe");
    rows.push({
      name: "ffmpeg",
      ok: Boolean(ffmpegPath),
      detail: ffmpegPath ?? "not found on PATH",
      source: classifySource(ffmpegPath, ["HYPERFRAMES_FFMPEG_PATH"]),
    });
    rows.push({
      name: "ffprobe",
      ok: Boolean(ffprobePath),
      detail: ffprobePath ?? "not found on PATH",
      source: classifySource(ffprobePath, ["HYPERFRAMES_FFPROBE_PATH"]),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rows.push({ name: "ffmpeg/ffprobe", ok: false, detail: `resolution failed: ${message}` });
  }

  try {
    const { resolveHeadlessShellPath } = await import("@hyperframes/engine");
    const chromePath = resolveHeadlessShellPath();
    rows.push({
      name: "chromium",
      ok: true,
      detail: chromePath ?? "not cached; Puppeteer's bundled Chrome will be used",
      source: classifySource(chromePath, ["PRODUCER_HEADLESS_SHELL_PATH", "HYPERFRAMES_BROWSER_PATH"]),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rows.push({ name: "chromium", ok: false, detail: message });
  }

  return rows;
}

/**
 * `doctor` always exits `0` when the command itself ran; environment health
 * lives in the JSON payload's top-level `ok` field (00-COMMANDS.md "doctor").
 */
export async function runDoctorCommand(json: boolean): Promise<number> {
  const rows: DoctorRow[] = [];

  rows.push({ name: "hfmpeg", ok: true, detail: `${getHfmpegVersion()} (channel: ${getChannel()})` });
  rows.push({
    name: "node",
    ok: true,
    detail: `${process.version} on ${process.platform}-${process.arch}`,
  });

  const producerVersion = getProducerVersion();
  rows.push({
    name: "@hyperframes/producer",
    ok: Boolean(producerVersion),
    detail: producerVersion ?? "not resolvable — run `npm install`",
  });

  rows.push(...(await getDependencyRows()));

  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  rows.push({
    name: "memory",
    ok: true,
    detail: `${freeMemMb}MB free / ${totalMemMb}MB total (low-memory mode auto-engages <= 8192MB)`,
  });
  rows.push({ name: "cpu", ok: true, detail: `${os.cpus().length} cores` });

  const healthy = rows.every((row) => row.ok);

  if (json) {
    printJsonEnvelope({ ok: healthy, command: "doctor", data: { rows } });
  } else {
    for (const row of rows) {
      const sourceSuffix = row.source ? ` (source: ${row.source})` : "";
      console.log(`${row.ok ? "[ok]" : "[!!]"} ${row.name.padEnd(24, " ")} ${row.detail}${sourceSuffix}`);
    }
  }

  return EXIT_CODES.OK;
}
