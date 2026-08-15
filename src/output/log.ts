/**
 * A tiny process-wide logger for `hfmpeg`'s own diagnostic output — distinct
 * from `output/progress.ts` (render progress) and `output/json.ts` (the
 * final `--json` envelope). Gated by the global `--log-level`/`--verbose`
 * flags (`00-COMMANDS.md` "Global flags"), set once via `setLogLevel`/
 * `setVerbose` in `args/global.ts` before any command runs.
 *
 * Always writes to stderr, never stdout, so `--json`'s single stdout
 * envelope is never interleaved with diagnostics (same rule `progress.ts`'s
 * `json` mode follows).
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = "info";
let verbose = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** `--verbose` implies at least `debug`-level output, on top of whatever `--log-level` says. */
export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

function effectiveRank(): number {
  return Math.max(LEVEL_RANK[currentLevel], verbose ? LEVEL_RANK.debug : 0);
}

function write(level: LogLevel, message: string): void {
  if (LEVEL_RANK[level] > effectiveRank()) return;
  process.stderr.write(`${message}\n`);
}

export function logError(message: string): void {
  write("error", message);
}

export function logWarn(message: string): void {
  write("warn", `warn: ${message}`);
}

export function logInfo(message: string): void {
  write("info", message);
}

/** Gated behind `debug`-level or `--verbose`; the "extra diagnostics" tier from `00-COMMANDS.md`. */
export function logDebug(message: string): void {
  write("debug", `debug: ${message}`);
}
