import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setColorDisabled } from "../output/color.js";
import { usageError } from "../output/errors.js";
import { LOG_LEVELS, setLogLevel, setVerbose, type LogLevel } from "../output/log.js";

/**
 * The global flags from `00-COMMANDS.md`'s "Global flags" table that are
 * genuinely command-agnostic (unlike `--json`/`--quiet`, which stay parsed
 * per-command because of the render-specific `-q`/`--quality` short-flag
 * collision noted in `args/parse.ts`). Extracted from the raw argv *before*
 * command dispatch in `cli.ts`, so they work in any position and for every
 * command, without each command's parser needing to know about them.
 */
export interface GlobalFlags {
  verbose: boolean;
  noColor: boolean;
  logLevel: LogLevel;
  /** `--tmp-dir <path>` — where render scratch directories are created. */
  tmpDir?: string;
  /** `--cache-dir <path>` — where downloaded Chromium/FFmpeg live (lite builds). */
  cacheDir?: string;
}

function defaultGlobalFlags(): GlobalFlags {
  return { verbose: false, noColor: false, logLevel: "info" };
}

/**
 * Split `argv` into the recognised global flags and everything else,
 * preserving the relative order/positions of the remaining tokens so
 * command-specific parsers (and the command-name lookup in `cli.ts`) see
 * exactly the argv they'd see if these flags weren't there at all.
 */
export function extractGlobalFlags(argv: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags = defaultGlobalFlags();
  const rest: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];

    if (token === "--verbose") {
      flags.verbose = true;
      i += 1;
      continue;
    }
    if (token === "--no-color") {
      flags.noColor = true;
      i += 1;
      continue;
    }
    if (token === "--log-level") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('Flag "--log-level" requires a value.');
      if (!LOG_LEVELS.includes(value as LogLevel)) {
        throw usageError(
          `Invalid --log-level "${value}". Expected one of: ${LOG_LEVELS.join(", ")}.`,
        );
      }
      flags.logLevel = value as LogLevel;
      i += 2;
      continue;
    }
    if (token === "--tmp-dir") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('Flag "--tmp-dir" requires a value.');
      flags.tmpDir = value;
      i += 2;
      continue;
    }
    if (token === "--cache-dir") {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('Flag "--cache-dir" requires a value.');
      flags.cacheDir = value;
      i += 2;
      continue;
    }

    rest.push(token);
    i += 1;
  }

  return { flags, rest };
}

/**
 * `HFMPEG_*` env var aliases (`00-COMMANDS.md` "Environment variables") onto
 * the upstream var each one maps to — read once, before any command runs,
 * so they behave exactly like the user having set the upstream var
 * themselves (same precedence: an upstream var the user *also* set directly
 * always wins, since these only fill in a gap, never overwrite).
 */
export function applyEnvAliases(): void {
  const aliasInto = (aliasName: string, upstreamName: string) => {
    const value = process.env[aliasName];
    if (value !== undefined && process.env[upstreamName] === undefined) {
      process.env[upstreamName] = value;
    }
  };
  aliasInto("HFMPEG_FFMPEG_PATH", "HYPERFRAMES_FFMPEG_PATH");
  aliasInto("HFMPEG_FFPROBE_PATH", "HYPERFRAMES_FFPROBE_PATH");
  aliasInto("HFMPEG_CHROMIUM_PATH", "PRODUCER_HEADLESS_SHELL_PATH");
}

/**
 * Apply the side effects of the extracted global flags, once, before any
 * command runs:
 *
 * - `--log-level`/`--verbose` configure `output/log.ts`.
 * - `--no-color` configures `output/color.ts` (on top of `NO_COLOR`, which
 *   that module already honours directly).
 * - `--tmp-dir` sets `TMPDIR` (POSIX, read by `os.tmpdir()`) and `TEMP`/`TMP`
 *   (Windows) for this process, so every render-scratch directory the
 *   engine creates via `os.tmpdir()` — capture workDir, the frame extraction
 *   cache, HDR staging — lands under it, not just our own code's temp usage.
 * - `--cache-dir` sets `HFMPEG_CACHE_DIR`, which `commands/deps.ts`'s
 *   `defaultHyperframesChromeDir()` reads as a fallback before its own
 *   hardcoded default, so the global flag and `deps chromium ensure
 *   --cache-dir` agree on one source of truth.
 */
export function applyGlobalFlags(flags: GlobalFlags): void {
  setLogLevel(flags.logLevel);
  setVerbose(flags.verbose);
  setColorDisabled(flags.noColor);

  if (flags.tmpDir !== undefined) {
    const dir = resolve(flags.tmpDir);
    mkdirSync(dir, { recursive: true });
    process.env.TMPDIR = dir;
    if (process.platform === "win32") {
      process.env.TEMP = dir;
      process.env.TMP = dir;
    }
  }

  if (flags.cacheDir !== undefined) {
    process.env.HFMPEG_CACHE_DIR = resolve(flags.cacheDir);
  }
}
