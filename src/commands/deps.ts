import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getDependencyRows } from "./doctor.js";
import { PINNED_CHROMIUM_VERSION } from "../meta.js";
import { color } from "../output/color.js";
import { CliError, EXIT_CODES, toCliError, usageError } from "../output/errors.js";
import { printCliError, printJsonEnvelope } from "../output/json.js";

export interface DepsFlags {
  version?: string;
  cacheDir?: string;
  force: boolean;
  json: boolean;
}

export function parseDepsFlags(argv: string[]): DepsFlags {
  const flags: DepsFlags = { force: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--version") {
      flags.version = argv[i + 1];
      i += 1;
    } else if (token === "--cache-dir") {
      flags.cacheDir = argv[i + 1];
      i += 1;
    } else if (token === "--force") {
      flags.force = true;
    } else if (token === "--json") {
      flags.json = true;
    }
  }
  return flags;
}

/**
 * The root directory `@hyperframes/engine`'s `resolveHeadlessShellPath`
 * scans first (`00-PLAN.md` §2.2 item 4): `~/.cache/hyperframes/chrome`.
 * Installing here means `ensure` requires no env var / `--chromium-path` for
 * the render path to pick the binary up.
 *
 * `HFMPEG_CACHE_DIR` is set by the global `--cache-dir` flag
 * (`args/global.ts`) — checked first so `hfmpeg --cache-dir X deps chromium
 * ensure` and the subcommand-local `deps chromium ensure --cache-dir X`
 * (which always wins; it's read directly into `DepsFlags.cacheDir` and only
 * this function's *default* is consulted when that's absent) agree on one
 * source of truth. Falls back to the un-overridden upstream-compatible
 * default otherwise.
 */
function defaultHyperframesChromeDir(): string {
  if (process.env.HFMPEG_CACHE_DIR) return join(process.env.HFMPEG_CACHE_DIR, "hyperframes", "chrome");
  return join(homedir(), ".cache", "hyperframes", "chrome");
}

/**
 * `@puppeteer/browsers`' `install()` lays out `<cacheDir>/chrome-headless-shell/
 * <platform>-<buildId>/chrome-headless-shell-<platform>/…`, one directory level
 * deeper (and prefixed with the platform) than the flat `<version>/chrome-
 * headless-shell-<platform>/…` layout `@hyperframes/engine`'s own cache scan
 * expects. Install into a throwaway staging dir with `@puppeteer/browsers`,
 * then copy just the versioned leaf into the shape the engine's scanner wants.
 */
async function ensureChromium(flags: DepsFlags): Promise<{ installedPath: string; resolvedPath?: string }> {
  const { install, Browser, detectBrowserPlatform } = await import("@puppeteer/browsers");
  const { resolveHeadlessShellPath } = await import("@hyperframes/engine");

  const buildId = flags.version ?? PINNED_CHROMIUM_VERSION;
  const targetChromeDir = flags.cacheDir ?? defaultHyperframesChromeDir();
  const targetVersionDir = join(targetChromeDir, "chrome-headless-shell", buildId);

  if (existsSync(targetVersionDir) && !flags.force) {
    const resolvedPath = resolveHeadlessShellPath();
    return { installedPath: targetVersionDir, resolvedPath };
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new CliError(
      `Could not detect a supported platform for chrome-headless-shell on ${process.platform}-${process.arch}.`,
      EXIT_CODES.MISSING_DEPENDENCY,
    );
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "hfmpeg-chromium-"));
  try {
    const installed = await install({
      cacheDir: stagingDir,
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId,
      platform,
      unpack: true,
    });

    rmSync(targetVersionDir, { recursive: true, force: true });
    cpSync(installed.path, targetVersionDir, { recursive: true });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  const resolvedPath = resolveHeadlessShellPath();
  return { installedPath: targetVersionDir, resolvedPath };
}

async function runDepsStatus(flags: DepsFlags): Promise<number> {
  const rows = await getDependencyRows();
  const ok = rows.every((r) => r.ok);
  if (flags.json) {
    printJsonEnvelope({ ok, command: "deps", data: { rows } });
  } else {
    for (const row of rows) {
      const sourceSuffix = row.source ? color.dim(` (source: ${row.source})`, process.stdout) : "";
      const marker = row.ok ? color.green("[ok]", process.stdout) : color.red("[!!]", process.stdout);
      console.log(`${marker} ${row.name.padEnd(16, " ")} ${row.detail}${sourceSuffix}`);
    }
  }
  return EXIT_CODES.OK;
}

async function runDepsChromium(action: string | undefined, flags: DepsFlags): Promise<number> {
  const { resolveHeadlessShellPath } = await import("@hyperframes/engine");

  if (action === "path" || action === undefined) {
    const path = resolveHeadlessShellPath();
    if (!path) {
      throw new CliError(
        "No chrome-headless-shell found. Run `hfmpeg deps chromium ensure` to download the pinned build, " +
          "or set --chromium-path / PRODUCER_HEADLESS_SHELL_PATH.",
        EXIT_CODES.MISSING_DEPENDENCY,
      );
    }
    if (flags.json) {
      printJsonEnvelope({ ok: true, command: "deps", data: { path } });
    } else {
      console.log(path);
    }
    return EXIT_CODES.OK;
  }

  if (action === "ensure") {
    const { installedPath, resolvedPath } = await ensureChromium(flags);
    const data = {
      installedPath,
      resolvedPath,
      autoDiscovered: Boolean(resolvedPath),
      version: flags.version ?? PINNED_CHROMIUM_VERSION,
    };
    if (flags.json) {
      printJsonEnvelope({ ok: true, command: "deps", data });
    } else {
      console.log(`Installed chrome-headless-shell ${data.version} at ${installedPath}`);
      if (resolvedPath) {
        console.log(`Auto-discovered by resolveHeadlessShellPath(): ${resolvedPath}`);
      } else {
        console.log(
          "Not auto-discovered. Pass --chromium-path or set PRODUCER_HEADLESS_SHELL_PATH to this install.",
        );
      }
    }
    return EXIT_CODES.OK;
  }

  if (action === "clear") {
    const chromeDir = flags.cacheDir ?? defaultHyperframesChromeDir();
    const shellDir = join(chromeDir, "chrome-headless-shell");
    rmSync(shellDir, { recursive: true, force: true });
    if (flags.json) {
      printJsonEnvelope({ ok: true, command: "deps", data: { cleared: shellDir } });
    } else {
      console.log(`Removed ${shellDir}`);
    }
    return EXIT_CODES.OK;
  }

  throw usageError(`Unknown "deps chromium" action "${action}".`, "Expected: ensure, path, or clear.");
}

async function runDepsFfmpeg(action: string | undefined, flags: DepsFlags): Promise<number> {
  if (action !== "path" && action !== undefined) {
    throw usageError(
      `Unknown "deps ffmpeg" action "${action}".`,
      "Expected: path. (`ffmpeg ensure` is deferred — see 00-PLAN.md Q3.)",
    );
  }

  const { findFfBinary } = await import("@hyperframes/parsers/ff-binaries");
  const path = findFfBinary("ffmpeg");
  if (!path) {
    throw new CliError(
      "No ffmpeg found on PATH. Install it, or set --ffmpeg-path / HYPERFRAMES_FFMPEG_PATH.",
      EXIT_CODES.MISSING_DEPENDENCY,
    );
  }
  if (flags.json) {
    printJsonEnvelope({ ok: true, command: "deps", data: { path } });
  } else {
    console.log(path);
  }
  return EXIT_CODES.OK;
}

export async function runDepsCommand(rest: string[]): Promise<number> {
  const [sub, action] = rest;
  const flags = parseDepsFlags(rest);

  try {
    if (!sub || sub === "status") return await runDepsStatus(flags);
    if (sub === "chromium") return await runDepsChromium(action, flags);
    if (sub === "ffmpeg") return await runDepsFfmpeg(action, flags);
    throw usageError(
      `Unknown "deps" subcommand "${sub}".`,
      "Expected: status, chromium <ensure|path|clear>, or ffmpeg path.",
    );
  } catch (err) {
    const cliError = toCliError(err);
    printCliError("deps", cliError, flags.json);
    return cliError.exitCode;
  }
}
